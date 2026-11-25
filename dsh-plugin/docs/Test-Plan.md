# Test Plan — validating the ESP32 AICLP plugin on the bench

This plan takes the plugin from "mounts and answers" to "trusted on its own". It is
ordered so that each phase either proves something the next phase depends on, or
fails cheaply before anything is flashed.

Every step is written as a **tool call**, because the plugin is what is under test —
the `curl` form would test the bench and skip the code that needs proving. In a
session on the **ESP32 AICLP** preset you can also state the outcome in plain English
and check the agent reaches for the same tool.

- **Goal:** find plugin bugs, not bench bugs. The bench is presumed healthy until
  phase [T9](#t9--the-bench-baseline-external-oracle) says otherwise.
- **Rule:** a step only passes if you *read* the output. `ok:true` is not success on
  this bench — that is the whole reason this plugin exists.

---

## A. The fixture — what is on the bench now

Three slots are running across **two physical boards**. That is not a mistake, and
understanding it is the first test.

| Board | Chip | MAC | How it appears | Slot | Serial | GDB | Fanout |
|---|---|---|---|---|---|---|---|
| **A** | ESP32-S3 (QFN56) rev v0.2, 16 MB flash, 2 MB PSRAM | `d0:cf:13:41:1e:0c` | native USB-Serial/JTAG `303a:1001`, `/dev/ttyACM0` | **SLOT4** | 4004 | 3336 | 5004 |
| **A** | *(same chip)* | *(same)* | CH343 UART bridge `1a86:55d3`, `/dev/ttyACM1` | **SLOT6** | 4006 | 3338 | 5006 |
| **B** | ESP32-C3 | *(read it in T1.3)* | native USB-Serial/JTAG `303a:1001`, `/dev/ttyACM2` | **SLOT7** | 4007 | 3339 | 5007 |
| **C** | **classic ESP32 (WROOM)** | — | CP2102 UART bridge `10c4:ea60`, `/dev/ttyUSB0` | **SLOT1** | 4001 | 3333 | 5001 |

`slots_configured: 7`. Board C appears only while it is plugged in, and it occupies a
port that Board B otherwise uses — so expect **SLOT7 to read `absent`** whenever the WROOM
is connected. That is a cable, not a fault.

> **Board C carries someone's real firmware**, and it boots as
> `=== farm_lora gateway_esp32 boot ===` with an SX1278 LoRa radio, a web server on :80 and
> a ~1 Hz heartbeat (`gateway heartbeat, heap=…`). **Never flash it** without asking — T2
> exists to flash Board A, and the partner image does not belong on the WROOM. Reading its
> serial and pulsing EN are safe; both are just a reset.

**Board A presents two slots because it has two USB ports** — the S3 devkit's native
USB port and its CH343 UART port, both cabled to the Pi. `detected_chip` is `null` on
SLOT6 by design: a bridge chip has no JTAG TAP to interrogate.

### The two ports of Board A carry different things

This is measured, not assumed, and it is the trap that will waste your afternoon if you
skip it:

| Slot | Port | Carries |
|---|---|---|
| **SLOT4** | native USB-Serial/JTAG | the **application console** — `OK status …`, `I (…) app_main: heartbeat` |
| **SLOT6** | CH343 UART bridge | the **ROM bootloader / esptool** log — `ESP-ROM:esp32s3-20210327`, `load:0x3fce2820`, `entry 0x403c8904` |

So `tb_serial_exec slot=SLOT4 command="status"` matches, and the identical call on
**SLOT6 returns nothing at all**. That is not a fault and not a plugin bug: this
firmware puts its console on USB CDC, while the mask ROM always prints its handshake
to UART0. Both are real, on the same chip, through different cables.

**Therefore: do every console test on SLOT4.** Use SLOT6 to prove the flashing-over-UART
path and to read ROM-level boot logs. The plugin's own advice — *"a silent port is not
evidence of a silent device … a bridge slot may be the wrong port"* — exists precisely
because this looks like a dead board.

### The reference firmware is already on Board A

Board A is running the partner firmware right now:
`OK status wifi=0 ap_mode=1 ap_ssid=WB-Test-Setup ip=0.0.0.0 mac=d0:cf:13:41:1e:0c mqtt=0 topic=`,
followed by `app_main: heartbeat` lines about once a second. So T2.6 already passes
before you flash anything, and C5's worry is smaller than it looks — what you would
overwrite is the partner image, which is restorable from `.fw/test-partner-esp32s3/`.

**Board B (the C3) is silent** — no firmware, empty ring buffer. It is a flashing and
JTAG subject, not a console subject, until you put firmware on it.


### The reference firmware

`.fw/test-partner-esp32s3/` is upstream's *test partner* image: a console firmware
that answers on the DUT's serial port. Four parts, flashed at four offsets:

| Offset | File |
|---|---|
| `0x0` | `bootloader.bin` |
| `0x8000` | `partition-table.bin` |
| `0xf000` | `ota_data_initial.bin` |
| `0x20000` | `wb-test-firmware.bin` |

It gives you a real DUT to test against. The console commands this plan uses:

Verified against the running image — the console answers `OK …`, or `ERR …` when it rejects a
command (its own list is `ping|status|scan|info|mark|wifi|testap|forget|reboot`):

| Command | Reply | What it enables |
|---|---|---|
| `ping` | `OK pong` | **the canonical smoke test** — proof that write→read works at all |
| `status` | `OK status wifi=… ap_mode=… ap_ssid=… ip=… mac=… mqtt=… topic=…` | state, and the `ap_ssid=` token T4.7 waits for |
| `info` | `OK info project=wb-test-firmware version=v1.0.1 idf=v6.0.2` | confirming which firmware you flashed |
| `scan` | `OK scan N` plus one line per network | the DUT's own radio survey |
| `mark` | `OK mark` | a marker line in the DUT's log |
| `testap <ssid> <pass>` | DUT **hosts** a WPA2 AP, then reboots | a real DUT on the air, so the bench can join it |
| `testap off` | DUT leaves AP mode | restoring the DUT |
| `wifi <ssid> <pass>` | joins a network as a station | direct STA join, bypassing the portal |
| `forget` | drops saved credentials, returns to portal | resetting provisioning |
| `reboot` | reboots | recovery |

> **A rejected command looks like a success.** `tb_serial_exec` with no `expect` reports
> "N new lines", and the first of them can be `ERR unknown command …`. The tool now flags
> any `ERR`/`error:`/`unknown command` reply explicitly — trust that flag over the count.

---

## B. The GPIO wiring — which board, and why

> **You can skip this section entirely.** Nothing else in the plan depends on it. If you
> never wire anything, `gpio` stays `partial`, `tb_call` refuses `gpio_set` for you, and
> every other phase still runs. The only cost is that **T3** cannot fully pass and
> `gpio_set` stays unusable by design. Wire it only if you want GPIO recovery available,
> or want to watch the gate open.

**The Pi has one pair of GPIO control wires, not one per slot.** BCM17 and BCM18 are a
single wire pair from the Pi header to **one** board's EN and BOOT pins. Which board
you attach them to is a physical choice; the software cannot see it, which is exactly
why `gpio_wired` starts as `null` rather than `false`.

### Answer: wire the **ESP32-WROOM**. Pi pin 11 → EN, pin 12 → **GPIO0**.

This is what the bench build guide already tells you to do (§4.5: *"wire this to
whichever slot holds the board most likely to boot-loop — for you, the WROOM"*), and the
reason is bigger than this plan: **a WROOM is the board that actually needs it.**

A WROOM sits behind a USB-UART bridge (CP2102/CH340), and that bridge's DTR/RTS
auto-reset circuit frequently cannot be driven through the RFC2217 proxy. esptool
reaches the chip and reports `Wrong boot mode detected (0x13)` — reachable, but stuck in
normal boot. Driving EN and GPIO0 electrically removes that whole class of failure. A
native-USB board (S3/C3/C6) never has this problem, which is why wiring one proves less.

### The pin mapping — Pi header to the WROOM

| Pi header pin | Pi BCM | Direction | WROOM devkit pin | Notes |
|---|---|---|---|---|
| **pin 11** | **BCM 17** | out, active LOW | **EN / RST** | resets the chip; the button marked EN/RST |
| **pin 12** | **BCM 18** | out, active LOW | **GPIO0** | the boot strap — also the wire behind the BOOT button |
| **pin 6** | GND | — | **GND** | common ground, **no resistor on this one** |
| — | — | — | — | **330 Ω in series** on **each** signal wire |

```
   Pi pin 11 (BCM17) ──[330 Ω]──┬──────── WROOM  EN / RST
                                │
   Pi pin 12 (BCM18) ──[330 Ω]──┼──────── WROOM  GPIO0
                                │
   Pi pin 6  (GND)   ───────────┴──────── WROOM  GND     ← without this, nothing works
```

**Two resistors, not one** — one per signal line, never shared, and neither is on GND.
Orientation is irrelevant. Anything from 220 Ω to 1 kΩ works; 330 Ω is the documented
value. They are **protection, not function**: the measurement passes without them, but
they cap the current if the DUT drives a pin the Pi is also driving, so a mistake costs a
resistor instead of a board. The build guide's BOM lists four, as spares.

**If the header pin is hard to reach, use the BOOT button pad.** The BOOT button
connects GPIO0 directly, so soldering to that pad is electrically identical. Confirm with
a multimeter: GPIO0 (or EN) to GND reads a few kΩ — both are pulled up on the board.

The boot strap pin per chip family — **the single most likely wiring mistake here:**

| Chip | BOOT strap pin |
|---|---|
| **classic ESP32 (WROOM/WROVER)** | **GPIO0** ← yours |
| ESP32-S3 | **GPIO0** |
| ESP32-C3, C6 | **GPIO9** |

Physical header pins matter more than BCM numbers when you are holding the board:
**pin 11 = BCM17** and **pin 12 = BCM18** are adjacent, on the inner row. Swapping them
is harmless-but-confusing: the EN pulse lands on the wrong pin and the measurement
simply fails.

> **Do not use BCM 5, 6, 12 or 13.** The API accepts only `{16…27}`, and 5/6/12/13
> belong to the signal generator. `17` and `18` are the configured pair
> (`gpio_en: 17`, `gpio_boot: 18`).

**A WROOM is one port, so one slot.** That makes it a cleaner subject than Board A, whose
two slots share one chip and can both register as wired. Whichever of SLOT1/2/3/5 lights
up when you plug it in is the only slot that can measure true — every other present slot
is automatically the control case.

> **The 330 Ω pair is protection, not a prerequisite.** If the measurement reports
> `en_wired: false`, a missing resistor is *not* the cause — look at the pin, the ground,
> or the baud.

### What the bench does with those wires

`POST /api/serial/gpio-test` is a **measurement**, not a declaration:

1. pulses EN low for 0.15 s then high, and watches **that slot's** serial for a ROM
   boot banner within 8 s → `en_wired`;
2. only if that worked, holds BOOT low across a reset and asks esptool whether the
   device reached download mode → `boot_wired`;
3. records `gpio_wired = en_wired AND boot_wired` **per slot label**, and leaves the
   board running.

There is nothing to configure. Wire it, then run the test on the slot you wired and
the bench tells you whether the wire is real.

### If you run it on the wrong slot

Nothing breaks. The EN pulse drives the **WROOM's** EN pin, but the bench listens on
**the other slot's** serial — a board that did not reset — so it sees no banner and reports
`en_wired: false`, "the pin is not connected to this board (or the board is
unresponsive)". Correct and safe. [T3.7](#t3--the-gpio-gate-both-directions) makes you
do this deliberately: it is the control that proves the refusal half of the gate.

**The one real hazard:** the EN pulse *does* reset whichever board the wires reach. Do
not run `serial_gpio_test`, or `gpio_set` on pin 17, while a flash is in progress on
the wired board.

> ⚠️ **The bench will drive those GPIOs from an unrelated slot.** `POST
> /api/serial/release` on an **absent** slot does not fail — the portal logs
> `GPIO18 (BOOT) released to high-Z` and `GPIO17 (EN) pulsed` and answers `ok:true`.
> Saw this happen on SLOT1 during development: an empty socket pulsed the Pi's EN pin.
> With wires on the WROOM, that would have reset your DUT mid-test for no reason. It also
> leaves the slot's `state` reading `idle` while `present` stays `false`, so a status
> view that trusts `state` shows an empty socket as healthy.
>
> The plugin now refuses `tb_serial_release` on an absent slot, and `tb_status` shows
> presence as the authority — `SLOT1  absent  (portal reports state "idle")`. T8.10
> keeps that honest. **Never call `serial_release` on a slot you have not confirmed is
> present.**

---

## C. Preflight — before you touch anything

| # | Check | How | Why |
|---|---|---|---|
| C1 | **Nobody else is on the bench** | `tb_status`, then `tb_log limit=20` | There is **no run lock and no authentication**. Two clients silently destroy each other's state. Look for `flash(`, `bench.reset` or `debug.start` entries you did not cause |
| C2 | Nothing is held | `tb_call endpoint=slot_mode params={"slot":"SLOT4"}` → `state: idle, owner: null` | A stale lease from a dead client blocks `slot_acquire` with a 409 |
| C3 | No debug session | `tb_debug action=status` | A live session blocks `slot_acquire`, not flashing |
| C4 | Partner firmware present | `ls .fw/test-partner-esp32s3/` → 5 files | T2 flashes it. If absent: `./fetch-test-partner.sh esp32s3 esp32c3` |
| C5 | **Decide about Board A's current program** | — | Flashing **overwrites the partner image now running on the S3**. It is restorable (`tb_flash slot=SLOT4 build_dir=.fw/test-partner-esp32s3`), so this is not a loss — but if you have flashed your own build since, dump it first: `tb_call endpoint=flash_read params={"slot":"SLOT4","offset":"0x0","length":4194304}` |

> **`bench_reset` is destructive to every client on the bench.** It stops all debug
> sessions, restarts every proxy, releases all grants, drops the AP and leaves the
> joined network. T10 uses it deliberately. Do not call it casually.

---

## T0 — Bench-only smoke, touching no board

**Proves:** the transport, the manifest registry, the status renderer, and that the
plugin refuses what must never be sent. No board state changes.

| Step | Call | Pass when |
|---|---|---|
| T0.1 | `tb_status` | 7 slots, 3 running, ports read from the bench (SLOT4 `:4004`, SLOT6 `:4006`, SLOT7 `:4007`), `flashable now:` names exactly SLOT4, SLOT6, SLOT7 |
| T0.2 | `tb_status` (tail) | warns *"More than one flashable slot… a label identifies a socket, not a board"*. With three flashable slots it must fire |
| T0.3 | `tb_status` (capabilities) | `ABSENT: external_probe_debug, sdr, rf_loopback`; `PARTIAL: gpio, signal_generator` |
| T0.4 | `tb_endpoints` | a compact directory: groups, endpoint count, refused endpoints named |
| T0.5 | `tb_endpoints id=serial_monitor` | full contract, including the **SUCCESS RULE** naming `matched` |
| T0.6 | `tb_call endpoint=hotplug` | **refused**, "NOT client-callable", with the udev explanation |
| T0.7 | `tb_call endpoint=wifi_lease_event` | **refused**, same class |
| T0.8 | `tb_call endpoint=sdr_endpoints` | **refused** as `UNAVAILABLE`, naming the missing dongle |
| T0.9 | `tb_call endpoint=siggen_atten params={"db":3}` | **refused** as `UNAVAILABLE` (no PE4302) |
| T0.10 | `tb_call endpoint=ap_start params={"ssid":"x","password":"y"}` | **rejected**, `unknown parameter`, naming `pass` as the real field |
| T0.11 | `tb_call endpoint=sta_join params={"ssid":"x","password":"y"}` | **rejected** the same way — the drift guard must cover station mode too, not just AP mode |
| T0.12 | `tb_call endpoint=nonsense` | rejected with the valid-id hint, not a crash |
| T0.13 | `tb_call endpoint=slot_mode params={"slot":"SLOT9"}` | `[FAILED] slot 'SLOT9' not found`, HTTP 404 — it must not silently address SLOT1 |

**If T0.10 passes but T0.1 fails,** the plugin is fine and the bench is down — stop and
check `curl http://192.168.0.29:8080/api/wifi/ping`.

**Fix map:** transport → `plugin/client.js`; manifest parsing → `plugin/manifest.js`;
wording and rendering → `plugin/tools/shared.js`; refusals → `plugin/tools/dispatch.js`.

---

## T1 — Two slots, one chip (the identity trap)

**Proves:** the plugin's core safety claim — it tells you *which board* you are about
to flash, not just which socket.

| Step | Call | Pass when |
|---|---|---|
| T1.1 | `tb_chip_info slot=SLOT4` | `ESP32-S3 (QFN56) (USB-Serial/JTAG)`, MAC `d0:cf:13:41:1e:0c`, 16 MB flash, 2 MB PSRAM |
| T1.2 | `tb_chip_info slot=SLOT6` | **the same MAC**, no `(USB-Serial/JTAG)` suffix (it is over the bridge) |
| T1.3 | `tb_chip_info slot=SLOT7` | `ESP32-C3`. **Write the MAC down** — it is Board B's identity for the rest of the plan |
| T1.4 | compare T1.1 and T1.2 | identical ⇒ SLOT4 and SLOT6 are **one chip** |
| T1.5 | `tb_status` again | `detected_chip` is now `null` for SLOT4/SLOT6 |
| T1.6 | `tb_serial_output slot=SLOT4 lines=5` then `slot=SLOT6 lines=5` | SLOT4 shows the **application** console; SLOT6 shows only **`ESP-ROM:` / `load:` / `entry`** lines. Two ports, one chip, different traffic |

**T1.5 is a finding, and the tool now says so.** `tb_chip_info` runs esptool, which
resets the chip and clears the cached detection — and the bench log records it as a
`flash(...)` line even though nothing was written. Its description now states that side
effect, so the blank chip column is not a surprise. **The board's program does stop
when you identify it**, which matters if it was mid-test.

**Consequence to internalise:** flashing "SLOT6" while reading "SLOT4" is the same
silicon. T2 uses that deliberately.

---

## T2 — Flash, boot, read (Board A)

**Proves:** `tb_flash` (offset handling, `flash_args` reading, `bin@0x` rendering),
`tb_serial_reset`, `tb_serial_output`, `tb_serial_exec`, and the cross-slot identity.

Prerequisite: C5 decided.

| Step | Call | Pass when |
|---|---|---|
| T2.1 | `tb_flash slot=SLOT4 build_dir=.fw/test-partner-esp32s3` | the plugin reads `flash_args` itself and echoes each part as **`bin@0x0`, `bin@0x8000`, `bin@0xf000`, `bin@0x20000`** — every offset with an `0x` prefix |
| T2.2 | `tb_flash slot=SLOT4 bins={"8000":"…/partition-table.bin"}` | **REFUSED** with the decimal explanation. Then `bins={"0x8000":…}` accepted |
| T2.3 | `tb_serial_reset slot=SLOT4` | a boot log appears — look for `ESP-ROM:` or `rst:` |
| T2.4 | `tb_serial_output slot=SLOT4 lines=60` | the application console, readably, with timestamps |
| T2.5 | `tb_serial_output slot=SLOT6 lines=60` | **the ROM log, not the app console** — `ESP-ROM:esp32s3-…` / `load:0x…`. Confirms one chip, two ports, different traffic |
| T2.6 | `tb_serial_exec slot=SLOT4 command="ping" expect="pong" timeout=10` | a **`MATCHED`** verdict. The write and the read are one operation, so a fast reply cannot beat the monitor |
| T2.6b | `tb_serial_exec slot=SLOT6 command="ping" expect="pong" timeout=8` | **`NO MATCH`** — and the tool must call that *inconclusive* and mention that a bridge slot may be the wrong port. A "pass" or a bare failure here would both be wrong |
| T2.6c | `tb_serial_exec slot=SLOT4 command="not-a-command" timeout=6` | flags **"THE DUT REJECTED THIS COMMAND"** with the `ERR unknown command …` line. Counting new lines would call this a success |
| T2.7 | `tb_serial_monitor slot=SLOT4 pattern="never-going-to-appear" timeout=2` | **`INCONCLUSIVE`**, explicitly not a pass. The bench returns `ok:true, matched:false` here — the most important classification in the plugin |

**If T2.6 says `NO MATCH`:** read the returned lines. An empty buffer means no DUT
firmware answering (T2.3 did not boot, or the image is not the partner) — that is not
a plugin bug. A buffer with lines but no `ap_ssid` means `status` is not the right
command for what you flashed.

**If T2.2's refusal does not fire,** `offsetToPartName` in `plugin/tools/shared.js` is
not being reached from `tb_flash` — a real bug, and the highest-severity one in this
plan.

---

## T3 — The GPIO gate, both directions

**Proves:** the gate that was dead code until this session (`gpio_set` takes `pin`, not
`slot`), the measurement, and the transition from refused to allowed.

Do this **after** the §B wiring, or skip the phase — T3.2, T3.1 and T3.7 still work
unwired (they prove the refusal half). **All eight steps have now been run:** SLOT1
measured `true`, and the control on SLOT4 measured `false` at the same time.

| Step | Call | Pass when |
|---|---|---|
| T3.1 | `tb_call endpoint=gpio_set params={"pin":16,"value":1}` | **GATED** — refuses, lists *present* slots only (SLOT4, SLOT6, SLOT7 — **not** SLOT1), explains `gpio_wired: null` ≠ "not wired", and names `serial_gpio_test` as the cure |
| T3.2 | `tb_call endpoint=gpio_set params={"pin":16,"value":"z"}` | **allowed** — releasing is always safe. This asymmetry is deliberate |
| T3.3 | `tb_call endpoint=serial_gpio_test params={"slot":"SLOTn"}` — the slot the WROOM appeared in | `en_wired: true` **and** `boot_wired: true` → `gpio_wired: true` (~15 s). This is the bridge slot the wires exist for |
| T3.4 | `tb_status` | the WROOM's slot shows **`gpio measured`**; every other slot still **`gpio unmeasured`** |
| T3.5 | `tb_call endpoint=gpio_set params={"pin":16,"value":1}` | **now allowed** — the gate opens once any present slot is measured |
| T3.6 | `tb_call endpoint=gpio_set params={"pin":16,"value":"z"}` | release again. **Always finish here** — a pin left driven stops the DUT booting and the next person will not know why |
| T3.7 | `tb_call endpoint=serial_gpio_test params={"slot":"SLOT4"}` (any other present slot) | `en_wired: false` — this is the **control**. The EN pulse resets the WROOM, but the bench listens on the S3's serial, which did not reset. Reports "not connected to this board". **Nothing breaks** |
| T3.8 | `tb_status` | the control slot is still `gpio unmeasured` — the measurement is stored per label |

**If T3.3 reports `en_wired: false`:** wrong pin, no common ground, or no resistor.
Check pin **11** (not 12) for EN, and that GND is shared. `gpio_en: 17` is what it pulses.
If the wires are on a **button pad**, confirm with a multimeter that the pad really is
EN — on some boards the second button is not IO0.

**If `en_wired: true` but `boot_wired: false`:** the BOOT wire is on the wrong pin. On a
classic ESP32 it must reach **GPIO0**; GPIO9 is the C3/C6 strap pin and does nothing here.

**If `en_wired: false` but the board visibly reboots,** the wire is fine and the
**baud is wrong** — garbled bytes never match `rst:0x`, and the buffer fills with
mojibake. That is the most common false negative, so check it before re-soldering.

**If T3.1 does not refuse,** the gate is broken again — the regression
`tools/selftest.mjs` now watches for.

---

## T4 — Wi-Fi: the open-AP trap, then a real DUT on the air

**Proves:** the `password`→`pass` mapping, the refusal to start an open AP, and honest
handling of AP/STA exclusivity. The second half is the first genuinely end-to-end test
in this plan, because it puts real firmware on the network.

| Step | Call | Pass when |
|---|---|---|
| T4.1 | `tb_wifi_ap action=start ssid=X` (no password) | **refused** — "refusing to start an OPEN access point". The bench itself would have started it and answered `ok:true` |
| T4.2 | `tb_wifi_ap action=start ssid=WT-TEST password=testbench1234` | AP up at `192.168.4.1`, stations listed (probably none) |
| T4.3 | `tb_wifi_scan` | **503 or a mode complaint** — the radio is in AP mode. The plugin must explain "the AP is running, the radio cannot scan concurrently", not report a bare failure |
| T4.4 | `tb_wifi_ap action=status` | `active: true`, `ssid: WT-TEST`, `ip: 192.168.4.1` |
| T4.5 | `tb_wifi_ap action=stop` | stopped; `tb_wifi_scan` then returns a list (empty means the air was empty, not an error) |
| **T4.6** | `tb_serial_exec slot=SLOT4 command="testap DUT-AP dutpass123" expect="testap" timeout=15` | the DUT accepts and **reboots** into AP mode |
| T4.7 | `tb_serial_exec slot=SLOT4 command="status" expect="ap_ssid=DUT-AP" timeout=45` | poll until the DUT reports hosting **the network you named** — not merely "an AP", which it also is when it has fallen back to its portal |
| T4.8 | `tb_call endpoint=sta_join params={"ssid":"DUT-AP","pass":"dutpass123","timeout":20}` | the **bench** joins the DUT's AP. Note `pass`, not `password` — T0.11 proved the guard bites here |
| T4.9 | `tb_wifi_ap action=status` | AP is down — AP and STA are mutually exclusive. Not an error |
| T4.10 | `tb_wifi_http url=http://192.168.4.1/ method=GET timeout=10` | **a real HTTP response from the DUT.** No DUT address is guessed: 192.168.4.1 is the DUT's own AP address here |
| T4.11 | `tb_call endpoint=sta_leave` then `tb_serial_exec slot=SLOT4 command="testap off"` | both return cleanly; DUT and bench back to baseline |

**T4.7's wording matters.** The partner reboots after `testap`, so a plain "is it an
AP?" check passes before provisioning has taken effect. Waiting for the **named SSID**
is the only honest check.

**If T4.10 fails:** check T4.8 actually joined (`tb_wifi_ap action=status` shows a
station with an IP). `tb_wifi_http` with no DUT on the network should have produced a
clear "no route", so a silent pass here would itself be a bug.

**Provisioning is proven, and it is the fastest route to T5.** `tb_provision
portal_ssid=WB-Test-Setup ssid=WT-TEST password=testbench1234` took the partner DUT from
portal mode to `192.168.4.17` on the bench AP in 19 s, with `mqtt=1` and a topic — the
partner firmware **does** host a captive portal (`ap_ssid=WB-Test-Setup` in its `status`
line). Prefer it over the manual T4.6–T4.9 dance when you only need a DUT on the network.
T8.8 and the note under it cover the one genuine failure mode.

---

## T5 — UDP log and MQTT

**Proves:** incremental polling, the shared-infrastructure stance on the broker, and a
real publish from a real DUT.

| Step | Call | Pass when |
|---|---|---|
| T5.1 | `tb_mqtt action=status` | broker running on 1883 (bench reset keeps it up — it is shared) |
| T5.2 | `tb_udplog limit=10 clear=true` | cleared, so the next poll is only what you caused |
| T5.3 | **with the DUT joined to the bench AP** (T4.2 then `tb_provision`), `tb_serial_exec slot=SLOT4 command="mark" expect="OK mark" timeout=20` | the DUT accepts the command — and the flag does not fire, because the reply is `OK` |
| T5.4 | `tb_udplog limit=20` | the DUT's own log lines, including its MQTT publication to `testbench/dut/<mac>/…`, **plus a ready `since=` value** |
| T5.5 | `tb_udplog since=<value from T5.4>` | only newer lines; re-polling an old `since=` must not duplicate |
| T5.6 | `tb_mqtt action=stop` then `action=start` | both answer. **Leave the broker started** — the contract calls it shared infrastructure |

> **What T5 cannot prove here.** The broker is up and the DUT reports `mqtt=1` with a topic,
> but confirming a message actually *arrived* needs a subscriber (`mosquitto_sub`, or paho in
> the T9 venv) — neither is installed. The DUT publishes on connect, not on `mark`, so a
> deliberate publish is not available either. Treat MQTT as **transport-verified, delivery
> unverified** unless you add a subscriber.

**T5.3's precondition is the fiddly part.** The DUT must be on the bench's AP
(192.168.4.x) for its UDP log to reach the Pi and its MQTT publish to reach the broker.
If `tb_udplog` stays empty, that is why — check `tb_wifi_ap action=status` for the
station before concluding the plugin is at fault.

**Real evidence this path works:** an earlier DUT run left these lines in the buffer —
`STA got IP: 192.168.4.17`, `UDP logging redirected -> 192.168.4.1`,
`mqtt_pub: broker=mqtt://192.168.4.1 topic=testbench/dut/d0cf13411e0c/hello`. When T5.4
produces lines like that, the whole Wi-Fi → UDP → MQTT chain is proven.

---

## T6 — BLE

| Step | Call | Pass when |
|---|---|---|
| T6.1 | `tb_call endpoint=ble_status` | bridge state, no crash on an idle controller |
| T6.2 | `tb_call endpoint=ble_scan params={"timeout":8}` | devices, or an empty list with a stated reason |
| T6.3 | `tb_call endpoint=ble_connect params={"address":"AA:BB:CC:DD:EE:FF"}` | a clean failure naming the address, not a hang |
| T6.4 | `tb_call endpoint=ble_write params={"characteristic":"…","data":"00"}` with no connection | a clear "not connected" error |

The partner firmware does not advertise a BLE service, so T6 is **transport only**.
Full BLE needs a peripheral sketch; record it as not covered rather than passing it.

---

## T7 — Debug / JTAG

**Proves:** the gdb line is reported correctly, and the plugin does not encourage
stopping a session that the flash path restores itself.

| Step | Call | Pass when |
|---|---|---|
| T7.1 | `tb_debug action=start slot=SLOT4` | a session starts, and the plugin prints a ready `target extended-remote 192.168.0.29:3336` |
| T7.2 | `tb_debug action=status` | SLOT4 debugging, others not |
| T7.3 | `tb_slot_acquire slot=SLOT4 mode=flashing` | **409**, reported as a *value*, naming `mode: debugging  owner: debug-session`. Not thrown, not retried |
| T7.3b | `tb_slot_acquire slot=SLOT4 mode=debug` (deliberately wrong) | rejected **locally** with the valid list — `mode must be one of idle \| flashing \| … \| debugging`. No round trip |
| T7.4 | `tb_flash slot=SLOT4 build_dir=…` **while debugging** | **succeeds without stopping the session first.** The portal restores the session itself; the plugin must not have told you to stop it |
| T7.5 | `tb_debug action=stop slot=SLOT4` | stopped, and the plugin says what stopping loses |
| T7.6 | `tb_debug action=start slot=SLOT7` | works — the C3 is native-JTAG, so SLOT7 is JTAG-debuggable |
| T7.7 | `tb_debug action=start slot=SLOT6` | **refused** with `could not auto-detect chip type — specify chip manually or check JTAG wiring`. A bridge-only slot cannot be debugged and there is no external probe |

> `mode` accepts only `idle | flashing | resetting | monitoring | flapping | recovering |
> download | debugging`. The conflict body for a live debug session carries
> `mode: "debugging"`, which is why acquiring with `mode=debug` is not the test you think
> it is — it is a malformed request, and the portal answers 400, not 409.

T7.4 is the one that matters: it is the contract's explicit correction of the
intuitive-but-wrong workflow, and T7.7 is the other half of the same lesson.

---

## T8 — Failure modes that must fail loudly

The cases a solo user hits first, so they deserve explicit passes.

| Step | Call | Pass when |
|---|---|---|
| T8.1 | `tb_serial_output slot=SLOT1 lines=20` | **"SLOT1 is ABSENT — no board is plugged into that socket"**, naming the live slots. Not "buffer empty", and not an empty success. `tb_serial_release slot=SLOT1` must say the same rather than claim it cleared download mode |
| T8.2 | `tb_flash slot=SLOT1 bins={"0x0":"…"}` | refused before any upload |
| T8.3 | `tb_chip_info slot=SLOT6` during a SLOT6 flash | a clear error, not a corrupted flash |
| T8.4 | `tb_wifi_http url=http://192.168.4.1/ method=GET timeout=5` with no DUT on the AP | a timeout explained as "no route to that address", not a silent pass |
| T8.5 | `tb_ota target=192.168.4.50 path=wb-test-firmware.bin` with no board at that address | HTTP 504 explained as "the board never answered" |
| T8.6 | `tb_operator action=ask message="Press BOOT" timeout=2` (let it expire) | "**not a confirmation**" — a timeout or cancel is never a yes |
| T8.7 | `tb_slot_acquire slot=SLOT4 mode=flashing ttl=1`, wait 3 s, `tb_slot_release token=…` | the expired-token 404 is explained as harmless |
| T8.8 | `tb_provision` while the DUT is **not** in portal mode (it is joined as a station) | reports **"no new station appeared within Ns"** with the AP state — never `provisioned` |
| T8.9 | `tb_firmware action=list` | an empty repository reported as empty, not as a failure |
| T8.10 | `tb_serial_release slot=<an absent slot>` | **refused** with the ABSENT explanation — it must not reach the portal, which would pulse the Pi's EN/BOOT GPIO at whatever board *is* wired |

---

## T9 — The bench baseline (external oracle)

Before blaming the plugin for anything subtle, prove the bench is healthy with the
suite that does not involve the plugin at all.

```bash
cd /home/millrat/Projects/ESP_AI_Harness
python3 -m venv .venv
.venv/bin/pip install pytest requests pyserial paho-mqtt esptool
./fetch-test-partner.sh esp32s3 esp32c3

REPO="$PWD"
cd /tmp        # the repo's own pytest/ directory shadows the pytest package
PATH="$REPO/.venv/bin:$PATH" \
WT_TEST_PARTNER_IMAGE="$REPO/.fw/test-partner-esp32s3" \
  python -m pytest "$REPO/claude_git_repo/Embedded-AI-Harness-main/pytest/testbench_test.py" \
  --wt-url http://192.168.0.29:8080 --run-dut
```

**Measured on this bench, both ways:**

| Bench state | Result |
|---|---|
| WROOM (bridge-only) plugged in | `85 passed, 11 failed, 8 skipped` — 12 min 15 s |
| WROOM unplugged, native-USB S3 first-present | **`96 passed, 8 skipped, 0 failed`** — 12 min 50 s, exit 0 |

Same 104 tests both times. Unplugging the bridge-only DUT moved **all eleven** failures to
passes and changed nothing else, which proves they were the suite's first-present-device
assumption and not the bench or the plugin. The three causes are tabulated below.

Upstream's `docs/test-partner.md` records `102 passed, 0 failed, 1 skipped` over 103 tests on
its own bench. Our collection is 104 with 8 skips; the extra skips correspond to hardware
this bench reports ABSENT or PARTIAL — no SDR, no signal generator, no C3 in slot 7, no
second WiFi DUT. Skips, not failures, which is the correct shape. — the skips are all
absent-hardware preconditions (no SDR, no Si5351, no ESP-Prog).

Anything worse means the **bench** has a problem, and T0–T8 results should be re-read
in that light before changing plugin code.

> ⚠️ **DO NOT RUN THIS WITH THE WROOM PLUGGED IN.** The suite reads no environment
> variables — `/`WT_TEST_PARTNER_IMAGE`/` does not exist in this version, and an earlier
> note in this plan claiming it did was wrong. Instead `_dut_slot()` picks **the first
> present slot whose `detected_chip` has prebuilt images** under `debug-test/output/`, and
> that directory contains `esp32`. So the moment anything populates SLOT1's chip — and the
> suite's own `test_chip_info_reads_the_silicon` calls `chip_info` on every present slot —
> **SLOT1 becomes the flash target and a debug-test image is written over whatever is on
> the WROOM.** Unplug the WROOM (or accept losing its firmware) before running T9.
>
> With SLOT1 absent, the target is SLOT4/esp32s3, which is restorable:
> `tb_flash slot=SLOT4 build_dir=.fw/test-partner-esp32s3`.

---

### What a clean T9 means for everything above

`96 passed, 0 failed` against an oracle that shares no code with this plugin means the bench
is healthy, its API behaves as documented, and none of the T-phases above were reading
plugin bugs as bench faults (or the reverse). It is the independent confirmation the
self-written run record cannot provide.

## MQTT delivery — verified

No tool in this plugin can prove delivery by itself: delivery needs a second party
listening. `tools/mqtt-subscribe.py` is that party, and it ships with the preset.

```bash
pip install paho-mqtt                      # already present in the T9 venv
python3 dsh-plugin/tools/mqtt-subscribe.py --seconds 60 &
# while it listens, make the DUT reconnect — it keeps its credentials across a reboot:
#   tb_serial_exec slot=SLOT4 command=reboot
```

Observed on this bench:

```
connected rc=Success; subscribing testbench/dut/+/hello
  RECEIVED testbench/dut/d0cf13411e0c/hello  {"seq":0,"src":"test-partner"}
  RECEIVED testbench/dut/d0cf13411e0c/hello  {"seq":1,"src":"test-partner"}
  ...
7 message(s) delivered.
```

**The trap that makes this look broken:** the partner publishes on MQTT **connect** — a
short burst `seq 0..N` — and never again. A subscriber started *after* the board has
connected receives nothing, which is indistinguishable from a dead broker or a topic ACL.
Subscribe first, then reboot. The script exits 1 and prints that instruction when it
catches nothing, so it can gate a test instead of misleading one.

The DUT publishes to the broker at `192.168.4.1` (the bench seen from the AP side); this
subscriber listens on `192.168.0.29:1883` (the same mosquitto, from the wired side).
A message crossing that boundary proves the publish went over the radio, through the AP,
through the broker, and back out the LAN — not merely that some local client could open a
socket to something.

## The two channels that need a second party

### Operator confirmation — `tb_operator`

`POST /api/human-interaction` blocks until a person answers, and it answers `ok:true` in
every case — confirm, cancel, or silence. Only the `confirmed` flag separates them, so a
tool that trusts `ok:true` records your absence as your agreement. The answer comes through
the bench portal page, which polls `/api/human/status` and shows a modal with **Done** and
**Cancel**.

Verified in both directions. With nobody present:

```
A timeout is not a confirmation
```

With a person at `http://192.168.0.29:8080` pressing Done, the identical call:

```
operator CONFIRMED: "Operator channel test: click DONE to confirm you are the human at the bench."
```

### A real gdb attach

`tb_debug` reporting "session started, gdb port 3336" proves a process and a listening
socket — not that JTAG reached the core. A symbolic session needs an Xtensa-aware gdb, and
this machine's cannot even name the architecture:

```
$ gdb -batch -ex 'set architecture xtensa'
Undefined item: "xtensa".
```

What can be proven here is the half that matters — server and target — by speaking gdb's
own remote serial protocol to `:3336`:

```
?          -> S02                                  halted, SIGINT
qSupported -> PacketSize=4000; qXfer:…; vCont      real capabilities
target.xml -> <architecture>xtensa</architecture>
g          -> 608 bytes = 152 words of registers   first word 0x40000400 (S3 ROM region)
qAttached  -> 1
```

Stopping the session left the CPU running and `ping` answered `OK pong`.

Two quirks worth keeping: a **silent listener is dropped in about a second** (the server
wants traffic at once, so connect-then-read looks like a closed port), and OpenOCD's Xtensa
target ships a **minimal `target.xml`** with no register map, so register names live in
gdb's own support rather than on the wire.

## T10 — Recovery, and the two hard traps

The only destructive phase. Do it last.

| Step | Call | Pass when |
|---|---|---|
| T10.1 | kill a serial client mid-read (close a monitor abruptly), then `tb_serial_output slot=SLOT4` | succeeds, or reports "port is busy" — the wedged-proxy symptom |
| T10.2 | retry once | if it now says **"port is busy"**, that is the documented wedge |
| T10.3 | `tb_reset` | the cure. `changed[]` lists the proxy restarts; `errors` is empty. **Report what it changed rather than hiding it** |
| T10.4 | `tb_serial_output slot=SLOT4` | works again |
| T10.5 | `tb_serial_write slot=SLOT4 text="x"`, note the state, `tb_serial_release slot=SLOT4` | release clears any `download_mode`, and the plugin explains why that matters |
| T10.6 | `tb_status` | after a reset `detected_chip` is `null` on all slots and repopulates within ~10 s. Do not conclude the board vanished |

**The two hard traps, both worth a deliberate failure:**

1. **`bin@8000` is decimal.** `tb_flash bins={"8000":"…"}` must be **refused**. If
   accepted, the plugin will one day write to `0x1F40` and brick a boot. T2.2 covers it
   — treat it as the highest-severity check in this plan.
2. **`ok:true` is not success.** T2.7 and T8.6 cover the two clearest cases. If either
   reports success on a timeout, stop and fix `plugin/client.js` before trusting this
   plugin with real work.

---

> **`ssid=NOPE` is not a negative test**, and this catches people out: enter-portal
> *creates* the network you name, so provisioning onto a network that "does not exist"
> genuinely succeeds — the bench raises `NOPE` and the DUT joins it. The only real failure
> mode is a DUT that is not hosting a portal for the bench to join.

> **`ap_status` can exceed a per-poll budget.** The portal serialises long-running work,
> so a status poll issued while the previous operation is still finishing can time out —
> measured answering in 4 ms from a shell at the same moment a poll had just exceeded
> 15 s. `tb_provision` treats that as "not yet" and keeps polling to its own deadline,
> and says so in the final report. If you see `a status poll failed and was retried`,
> that is the trait, not a fault.

---

## R. Run record — what has actually been executed

Executed on this bench (`testbench-5c62`, fw `1.0.0-pi`, 2026-11-25) with the partner
firmware on Board A and the C3 leaving SLOT7 idle.

| Phase | Result | Notes |
|---|---|---|
| T0 | **all pass** | status, endpoint directory, contract lookup, and all six refusals |
| T1 | **all pass** | SLOT4 and SLOT6 resolve to the **same MAC** while being different ports; SLOT7 is a different chip; the "busy slot" trap is closed by consulting `present` |
| T2 | **all pass** | `build_dir` and explicit `bins` both flash, board boots, console answers `ping`→`pong`, bridge slot reports **INCONCLUSIVE** not pass. Also run on the WROOM: classic ESP32 over CP2102, bootloader at **0x1000**, at 115200 — booted `Project name: debug-test` |
| T3 | **all pass** | refusal half first (`en_wired: false` while unwired); then the WROOM in SLOT1 measured **`en_wired: true`, `boot_wired: true`** in 9.7 s, SLOT1 flipped to `gpio measured`, and `gpio_set` opened. Pins 16/17/18 all back to `input` |
| T4 | **all pass** | open-AP refused; WPA2 AP up/scan-refusal/down; the bench joined the DUT's own AP and fetched its page over HTTP 200 |
| T5 | **partial** | broker running, `mqtt=1`, UDP log and `since=` both work. Delivery unverified — no subscriber installed |
| T6 | **all pass** | `ble_status`, `ble_scan` (8.3 s), and clean errors for a bogus connect and a write with no connection |
| T7 | **all pass** | debug on SLOT4 and SLOT7; **flash during a live session succeeded and the session survived**; bridge slot refused; 409 reported as a value |
| T8 | **all pass** | every failure mode loud, including the absent-socket ones that used to read as success |
| T10 | **all pass** | bench reset released a stale grant, restarted three proxies, and the bench came back usable |

**The wiring measurement works, on the board that needs it.** CP2102 bridge, classic
ESP32, 330 Ω on EN and GPIO0: `serial_gpio_test` pulsed EN, caught
`rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)`, then held BOOT and confirmed
download mode. That is the whole point of the pair — a WROOM behind a bridge is exactly
the board whose auto-reset the proxy cannot always drive.

**Provisioning was the big unknown and it works**: `tb_provision` took the DUT from portal
mode to `192.168.4.17` on the bench AP in 19 s, with `mqtt=1` and a topic.

### Defects this run found, all fixed

1. **`tb_flash build_dir` never validated or displayed offsets.** It uploaded `flash_args`
   for the portal to interpret, so a `8000` in that file would have flashed to `0x1F40`.
   It now parses `flash_args` itself, normalises every offset through the same guard as
   `bins`, and prints the offset → file mapping.
2. **`flash_args` settings were dropped.** ESP-IDF writes `--flash-mode dio --flash-freq
   80m --flash-size 4MB` on one line; the parser read only the first, so flashes silently
   used the 40m default.
3. **`tb_ota` and firmware upload could not work at all.** A required `binary` parameter
   arrives through the multipart parts, but `validateArgs` looked only at the arguments,
   so it threw `missing required firmware` while the caller held the file.
4. **JTAG capability was gated on chip auto-detection.** A bench reset clears
   `detected_chip`, so for ~5 s a native-USB-JTAG board read **"flashable over UART only"**.
5. **A rejected DUT command looked like success.** `tb_serial_exec` reported "N new lines"
   when line one was `ERR unknown command`. Now flagged explicitly.
6. **One slow poll aborted the whole provisioning flow.** A transient `ap_status` timeout
   threw out of the polling loop; it now retries until the deadline and reports honestly.

7. **`tb_status` hid a correctly-wired slot.** The renderer printed the wiring column
   only when the measurement was *not* `true`, so the one state an operator looks for after
   wiring — verified good — appeared as no column at all, indistinguishable from a slot
   with no GPIO lines. A missing field also rendered as `unwired`, asserting a negative
   nobody measured.

8. **`tb_flash` used 921600 on bridge slots, which does not work here.** Measured twice on
   two different boards and two different bridge chips (CH343 + CP2102): a large write dies
   mid-image with `No more data to read from the serial port`, while the same images at
   **115200** write and hash-verify. `tb_flash` now picks the baud from the slot's own USB
   signature — 921600 for native USB-JTAG, 115200 for a bridge — and says which it chose.
   An explicit `baud` still wins.
9. **`tb_flash` accepted a `0x0` bootloader for a classic ESP32.** That offset is correct
   for S3/C3/C6/H2 only; on an ESP32 it boot-loops on `invalid header`. The tool now warns
   when a `bin@0x0` part goes to a bridge slot, because a bridge slot is where a classic
   ESP32 is most likely to be.

Each has a regression check in `tools/selftest.mjs`, which runs offline except for the
read-only probes. Tool coverage is now complete: all 25 tools have been called at least
once, including `tb_log`, `tb_mqtt` stop/start, and the `tb_operator` ask→timeout cycle.

### The pytest baseline: 11 failures, all one cause

Run with the WROOM connected. Every failure traces to the suite assuming the **first
present device** is native-USB with a JTAG tap; ours is the CP2102 WROOM.

| # | Tests | What happens | Whose assumption |
|---|---|---|---|
| 9 | 5× `TestUSBJTAGDebug`, 4× `TestAutoDebug` | `debug_start()` is called **with no slot**, so the portal auto-picks SLOT1 → `could not auto-detect chip type — specify chip manually or check JTAG wiring` | the tests never gate on `_jtag_capable()` |
| 1 | `test_wt2201_present_device_detected` | asserts the first present device has `detected_chip`; a bridge part never gets one | **the suite contradicts its own helper.** `_jtag_capable()`'s docstring says a bridge device's `detected_chip` is None *"by design — asserting a chip for it tests a premise the portal never promised"*, and 3 call sites use it. WT-2201 does not |
| 1 | `test_wt1800_flash_and_serial` | `_images()` hard-codes `"0x0": bootloader.bin` for **every** chip. That is right for S3/C3/C6/H2 and wrong for a classic ESP32, whose bootloader lives at **0x1000** — so `_dut_slot()` picks the WROOM and the board boot-loops on `invalid header` | upstream `_images()` has no per-chip offset |

Both of the last two are **upstream defects**, not bench or plugin faults, and both are
reproduced deliberately: `debug_start` with no slot fails on demand, and flashing the
classic-ESP32 images at `0x0` produced
`invalid header: 0x2045000a` in a loop until the bootloader moved to `0x1000`, after which
the board booted `Project name: debug-test`.

### Still not covered

| Gap | Why | How to close it |
|---|---|---|
| ~~**T9, the pytest baseline**~~ | **Done, both ways: 85/11/8 with the bridge DUT, 96/8/0 without.** The 11 → 0 transition confirms the diagnosis | — |
| ~~MQTT **delivery**~~ | **Verified — 7 messages delivered, exit 0.** See the section above | — |
| A **live session** listing 25 tools + 16 skills | Only a real session shows this | Select the ESP32 AICLP preset and ask it to list its tools |
| ~~`tb_operator` **confirmed yes**~~ | **Verified — a human pressed Done and the tool reported `operator CONFIRMED`.** The negative path was already covered | — |
| ~~**gdb actually connecting**~~ | **Verified at protocol level: `?`→`S02`, `target.xml`→`xtensa`, `g`→608 bytes of registers.** A *symbolic* session still needs the ESP-IDF toolchain | install `xtensa-esp32s3-elf-gdb` for breakpoints and backtraces |

---

## D. Go-solo readiness checklist

Ready to be used alone when:

- [ ] **Every T0 check passes.** The refusal surface is the safety net; a hole in it is the most expensive bug class.
- [ ] **T1.1 and T1.2 return the same MAC.** If the plugin ever presents SLOT4 and SLOT6 as different boards, the identity promise is broken.
- [ ] **T2.1 shows `0x` on every offset, and T2.2 refuses a bare one.**
- [ ] **T2.7 says `INCONCLUSIVE`, not "passed".**
- [ ] **T8.1 says `ABSENT`, not "buffer empty"** — the socket-versus-device distinction is exactly what this plugin is for.
- [ ] **T3.1 refuses and T3.5 allows** — and the gate names present slots only.
- [ ] **T3.6 released the pin.** Confirm with `tb_call endpoint=gpio_status` that no pin is left driven.
- [ ] **T4.10 got a real HTTP response from the DUT** — the first end-to-end proof.
- [ ] **T7.4 flashed during a live debug session without stopping it.**
- [ ] **T10.3 recovered a wedged slot.**
- [ ] **A real session on the ESP32 AICLP preset lists 25 `tb_*` tools and 16 skills.** A mount check cannot see this; only a session can.
- [ ] **The agent reaches for `tb_serial_exec` first** rather than `tb_serial_monitor` for a command/reply — that is the prompt section doing its job.

## E. Known-good expectations, so you do not chase ghosts

| Observation | Why it is correct |
|---|---|
| `detected_chip: null` on SLOT6 | A CH343 bridge has no JTAG TAP to interrogate |
| `detected_chip` goes `null` after `tb_chip_info` | esptool reset the chip; the cache clears and returns in ~10 s |
| `flash(...)` in `tb_log` after `tb_chip_info` | Same esptool path; nothing was written |
| SLOT4 and SLOT6 report the same MAC | One S3 devkit with both USB ports cabled |
| SLOT6 shows only `ESP-ROM:`/`load:`/`entry` lines | The bridge sees the mask ROM's UART0 handshake, not the app console — which is on USB CDC / SLOT4 |
| `tb_serial_exec` on SLOT6 returns `NO MATCH` while SLOT4 answers | Same reason. Use SLOT4 for console work |
| SLOT7 (the C3) reads `buffer empty (the slot is present…)` | Present socket, no firmware on it yet — different message from `ABSENT`, deliberately |
| `tb_status` shows `SLOT1 absent (portal reports state "idle")` | `serial_release` on an absent slot set `state` to `idle` server-side. `present: false` is the truth |
| `gpio_wired: null` on every slot but one | Only the WROOM's slot can measure true; the rest are the control case by construction |
| `wifi_scan` returns 503 while the AP is up | AP and STA are mutually exclusive |
| `sta_join` makes the AP disappear | Same reason; join and AP cannot coexist |
| `ota` returns 504, or 500 with a nonzero `returncode` | The board never answered on the OTA port — not a plugin error. Both codes are covered, because the portal raises 500 with esptool output when nothing is listening |
| An empty `tb_udplog` | No DUT is sending UDP logs — check it is on the bench AP first |
| The DUT reboots after `testap` | By design; poll for the **named** SSID, not for "is an AP" |
| `gpio_status` shows `17: {"direction":"output","value":1}` after `serial_gpio_test` | The bench leaves **EN claimed and driven HIGH** — that is the "board is running" state, and BOOT (18) is released. Only an output driven **LOW** is dangerous |
| `gpio_status` shows all three pins as `input` after `gpio_set … "z"` | High-Z. The board's own 10 kΩ pull-up holds EN high, so it keeps running |
| `tb_log` ends with `released — device should boot into firmware` while `gpio_status` still lists `17: output/@1` | The activity log and the claimed-line table disagree about GPIO17. The pin table is the physical truth; EN driven HIGH is "board running", so this is cosmetic |
| `tb_serial_output` on a just-unplugged slot used to return frozen lines (`LOOP: 283`) as if live | The portal's ring outlives the socket, so presence is now checked **before** the buffer: an absent slot reports `ABSENT` and names the newest frozen line instead of presenting it as current output |
| Flashing the S3 **over the bridge port** fails around 25% with `No more data to read from the serial port` | Observed twice on this bench, at 921600 **and** 460800, with nothing else running — and it happens on the 1.2 MB application image only. Flash Board A via **SLOT4** (native USB). This is the bridge/auto-reset class of failure the build guide describes, and it is precisely why the GPIO pair exists for bridge-only boards |

## F. Rollback

1. `tb_wifi_ap action=stop` — no AP left radiating.
2. `tb_call endpoint=sta_leave` — the bench leaves any joined network.
3. `tb_mqtt action=start` — broker back in its baseline state.
4. `tb_call endpoint=gpio_set params={"pin":16,"value":"z"}` **and** `…{"pin":17,"value":"z"}` — release both.
   `serial_gpio_test` leaves **GPIO17 claimed and driven HIGH** (harmless — EN high is
   "running"), so releasing 16 alone does not put the Pi back to letting go.
5. `tb_debug action=stop` on any session you started.
6. `tb_slot_release token=…` for any lease still held.
7. `tb_reset` as the final word — everything to baseline.
8. Restore Board A's firmware if you dumped it in C5; otherwise re-flash your own build.

**Never use `tb_serial_release` as a cleanup step on a slot you have not confirmed is
present** — on this bench it drives the Pi's GPIO17/18 regardless (see §B).

Leave the GPIO wires **on the WROOM** between sessions. `gpio_wired: true` persists per
slot label, so the measurement survives even across a bench reset, and every other slot
stays measured-as-unwired — which is what keeps the control case intact.

⚠️ **Never leave GPIO0 held LOW.** Low at reset means serial-download mode, and your
firmware will not boot. `serial_gpio_test` releases BOOT when it finishes, but a manual
`gpio_set pin 18 value 0` strands the board. Finish GPIO work with `value: "z"`.
