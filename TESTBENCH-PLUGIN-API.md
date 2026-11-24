# Testbench Plugin API — Operating Contract

**Audience:** an implementer (human or code generator) writing a program that drives
the Embedded AI Harness testbench over the network.
**Status:** normative for the bench at `192.168.0.29`, derived from the portal source
and verified by live calls against that bench.
**Companion file:** `testbench-api-manifest.json` — the same contract as machine-readable
data. Prefer the manifest for enumeration, this document for meaning, ordering and traps.

Every contract claim below is cited as `pi/<file>.py:<line>` against the vendored copy at
`claude_git_repo/Embedded-AI-Harness-main/`. Where documentation and code disagree, **the
code wins** and the discrepancy is called out in §12.

---

## 0. Read this first — the five things that break naive clients

1. **Never compute a port.** Read `tcp_port`, `gdb_port`, `openocd_telnet_port` and
   `monitor_port` from `GET /api/devices`. They are configuration, not a formula
   (`pi/portal.py:590-592`). Observed values happen to follow `4000+n` / `3332+n` /
   `4443+n` / `5000+n`, but a client that computes them will one day be wrong.
2. **A HTTP 200 does not mean success — and neither does `ok: true`.** Dozens of handlers
   return `{"ok": false, ...}` with status 200 — every Wi-Fi handler failure and several
   `/api/serial/*` "slot not found" paths among them. **Branch on the `ok` field**, not the
   status code — but note the inconsistency: the *same* class of error is a **404** in
   `/api/debug/start` and `/api/slot/mode` and a 200 elsewhere.
   And `ok` is only the *first* test: three endpoints report `{"ok": true}` while the work did
   **not** happen, because a timeout is a successful *request*:

   | Endpoint | Success shortfall | Verified |
   |---|---|---|
   | `POST /api/serial/monitor` | `{"ok":true,"matched":false,"line":null,"output":[]}` | live |
   | `POST /api/human-interaction` | `{"ok":true,"confirmed":false,"timeout":true}` | §5.7 |
   | `POST /api/net/portscan` | `{"ok":true,"complete":false,...}` on truncation | §5.4 |

   So: `ok` **and** the endpoint's own success field (`matched`, `confirmed`, `complete`).
   Conversely, route-level 404s return `{"error": "not found"}` with **no `ok` key at all**
   (`pi/portal.py:2797,2939,2949`), and `GET /api/wifi/scan` refuses with a bare
   `{"error": ...}` — code that does `body["ok"]` raises `KeyError` on all of these.
3. **A slot label identifies a socket, never a board.** Moving a board to a different USB
   jack changes its label and port. To identify a board use `POST /api/chip/info` (MAC),
   never `label`, `slot_key` or `devnode`.
4. **A debug session blocks *leasing*, not flashing.** `POST /api/slot/acquire` with any mode
   other than `debugging` is refused 409 while OpenOCD holds the slot (`FR-035`). But
   `POST /api/flash` does **not** refuse: it stops the debug session itself, flashes, then
   restarts OpenOCD and issues `reset run` so the CPU is left *running*, not halted
   (`pi/portal.py:1991-2003, 2063-2075`). So you do not need `debug/stop` before a flash —
   and if you call it you will lose the session the portal would otherwise have restored.
5. **Opening an `rfc2217://` socket directly is not a read.** RFC2217 negotiation asserts
   DTR/RTS, which on a native-USB ESP32 means *download mode and reset*. To write bytes use
   `POST /api/serial/write`; to observe use `POST /api/serial/monitor` or the read-only
   fan-out port. This is why those endpoints exist (`docs/Harness-FSD.md:1241-1246`).

---

## 1. The bench you are talking to

| Property | Value |
|---|---|
| API base | `http://192.168.0.29:8080` |
| Hostname | `testbench-5c62` (informational only — never address the bench by name) |
| Host | Raspberry Pi 4 Model B, 2 GB, Raspberry Pi OS bookworm |
| Management link | `eth0` → LAN `192.168.0.0/24`, all client traffic |
| Test radio | `wlan0` → SoftAP `192.168.4.1/24` when AP is up |
| Slots configured | 7 (`SLOT1`…`SLOT7`) |
| Currently attached | `SLOT4` = ESP32-S3 board (native USB-JTAG, chip auto-detected); `SLOT6` = that same board's CH343 UART bridge (deliberately chip-less) |

**Authentication: none.** There is no token, header, session or IP allow-list anywhere in
the portal (`pi/portal.py:2691`, dispatch begins with no check). The API is bound to
`0.0.0.0:8080`. This is a deliberate, documented position for an instrument on a trusted
lab network (`docs/Method/standards/testing.md:91-93`). A plugin should assume the network
is the security boundary and must not invent an auth flow.

**`eth0` and `wlan0` never overlap.** `eth0` is management only; `wlan0` is the Wi-Fi
instrument only (`docs/Harness-User-Manual.md:276-277`).

### 1.1 Discovery

The bench answers a UDP probe on port **5888**. Verified live:

```
send  b"DISCOVER"  →  udp/5888
recv  {"service": "testbench", "hostname": "testbench-5c62", "ip": "192.168.0.29", "port": 8080}
```

Source: `pi/portal.py:395-402`. `BEACON_PORT` is overridable by env (`pi/portal.py:149`).
Unicast to the known IP works; broadcast does not cross a container bridge, so prefer an
operator-supplied URL and use the beacon only as a fallback.

**Liveness probe:** `GET /api/wifi/ping` answers in every Wi-Fi mode and returns
`{"ok": true, "fw_version": "1.0.0-pi", "uptime": <s>}`. Use it as the reachability check;
`GET /api/devices` as the "bench alive and what is in it" check.

**Never** address the bench as `<hostname>.local`, and never drive it over SSH — every
observation has an endpoint (`docs/Method/AI-Workflow.md:65-68`).

---

## 2. The slot model

A **slot** is a fixed physical USB hub port, pre-created at boot and always visible even
when empty (`docs/Harness-FSD.md:243`). A **DUT** is the board in a slot. The bench's own
ESP32 is not a DUT — it is the *test partner*, a known counterpart the bench measures
itself against.

### 2.1 `GET /api/devices` — the discovery call

Response: `{"ok": true, "slots": [ ... ], "host_ip": str, "hostname": str}`.

`slots` is sorted **lexicographically by label**, so `SLOT10` sorts before `SLOT2`
(`pi/portal.py:2956-2960`). Sort numerically yourself; do not rely on array order.

Every slot object carries the keys below **unconditionally** (values may be `null`), with
exactly two exceptions: `debug_chip` and `debug_gdb_port` are **absent** — not `null` — unless
`debugging` is `true`. Use `.get()` for those two; indexing them is a latent `KeyError`
(§12.6).

| Key | Type | Meaning |
|---|---|---|
| `label` | str | `SLOT<n>` for configured slots, `AUTO-<n>` for dynamically discovered ones |
| `slot_key` | str | Registry key: `_fixed_SLOT<n>` for configured slots (carries no USB info), else a udev `ID_PATH` |
| `tcp_port` | int | RFC2217 serial proxy port — always an int |
| `gdb_port` | int | GDB RSP port — always an int |
| `openocd_telnet_port` | int | OpenOCD telnet port — always an int |
| `monitor_port` | int \| null | Read-only fan-out port. The relation `tcp_port + 1000` is **descriptive only — read the field, never compute it**. **May be stale after the proxy stops** (`pi/portal.py:906-917`) |
| `url` | str \| null | Pre-computed `rfc2217://<host_ip>:<tcp_port>`. **May be non-null while `running` is false** |
| `present` | bool | At least one devnode is registered for this slot |
| `running` | bool | The proxy process is alive and both its ports are listening |
| `pid` | int \| null | Proxy PID, `null` when stopped |
| `devnode` | str \| null | Primary node, e.g. `/dev/ttyACM0` |
| `devnodes` | [str] | **All** nodes for this slot — a dual-USB board has two |
| `state` | str | One of `absent`, `idle`, `resetting`, `monitoring`, `flapping`, `recovering`, `download_mode`, `debugging`, `flashing` (`pi/portal.py:82-90`) |
| `debugging` | bool | An OpenOCD session is active for this slot |
| `detected_chip` | str \| null | Chip identified by passive detection, e.g. `esp32s3`. Persists after debug stop; cleared when the last devnode leaves |
| `jtag_slot` | str \| null | Label of the slot providing JTAG (own label when built-in, else the probe's slot) |
| `is_probe` | bool | Port holds only a JTAG probe, no DUT |
| `usb_devices` | [obj] | `{product, vid_pid}` for non-serial USB devices on the port |
| `usb_warning` | str \| null | Set when a HID/keyboard device occupies the port ("Not flashable — USB in HID mode") |
| `group`, `role` | null | **Always `null` in practice** — see §12.1. Do not use |
| `gpio_boot`, `gpio_en` | int \| null | Pi BCM pins configured for BOOT / EN |
| `has_gpio` | bool | Pins are *configured*. **Not a claim that wires exist** |
| `gpio_wired` | bool \| null | `true`/`false` only after a wiring measurement; `null` = never measured |
| `gpio_wired_detail` | str \| null | Measurement narrative |
| `flapping`, `recovering`, `recover_retries` | bool/bool/int | Hotplug-storm detection and recovery progress |
| `last_error`, `last_action`, `last_event_ts`, `seq` | mixed | Diagnostics; `seq` is a **bench-wide** counter, not per-slot |

Example (real, abridged) for the S3 in `SLOT4`:

```json
{"label":"SLOT4","slot_key":"_fixed_SLOT4","tcp_port":4004,"gdb_port":3336,
 "openocd_telnet_port":4447,"monitor_port":5004,"url":"rfc2217://192.168.0.29:4004",
 "present":true,"running":true,"devnode":"/dev/ttyACM0","devnodes":["/dev/ttyACM0"],
 "state":"idle","debugging":false,"detected_chip":"esp32s3","jtag_slot":"SLOT4",
 "is_probe":false,"usb_devices":[{"product":"USB JTAG/serial debug unit","vid_pid":"303a:1001"}],
 "gpio_boot":18,"gpio_en":17,"has_gpio":true,"gpio_wired":null,"group":null,"role":null}
```

### 2.2 `detected_chip` is `null` in three legitimate situations

A client must treat `detected_chip: null` as "unknown", not "absent":

1. **Board behind a UART bridge.** `SLOT6` on this bench is the S3 board's CH343. It has
   no JTAG TAP, so nothing can identify it (`pi/debug_controller.py:194-205,267-269`).
   It will report `present: true, detected_chip: null` forever. This is correct behaviour.
2. **Transiently after a proxy restart.** Measured on the live bench: `bench/reset`
   cleared `detected_chip`, and it repopulated within ~5 s. **Poll up to ~10 s before
   concluding anything.**
3. **Before the first hotplug event** on a freshly started slot.

The field is populated only by passive detection with a built-in USB TAP or a configured
ESP-Prog probe. A slot with neither is chip-less by design.

### 2.3 Identity rules

| Fact | Stable? |
|---|---|
| A label means "the socket whose USB prefix matches" | Yes, while `testbench.json` is unchanged |
| The same *board* appears at the same label | **No** — it follows the socket |
| The same *label* holds the same board | **No** — a different board in that socket inherits the label |
| `AUTO-<n>` labels | **No** — the counter resets on every portal restart |
| `/dev/ttyACM*` / `/dev/ttyUSB*` node names | **No** — the kernel reassigns them on re-enumeration |

The bench self-heals node-name churn by topology: udev fires `POST /api/hotplug` with the
`ID_PATH`, and the portal adopts the new node when the recorded one no longer exists
(`pi/portal.py:3089-3099`). **A client should re-read `/api/devices` after any
flash/reset instead of caching `devnode`.**

Note that `GET /api/devices` is **not purely passive**: it clears aged-out flapping flags
and may restart a dead proxy for a present slot (`pi/portal.py:1236-1255`). Polling it is
part of the recovery mechanism.

**Two things `/api/devices` does not tell you.**

First, **it exposes no lease state.** There is no `owner`/`grant` key on a slot, so finding out
whether a slot is claimed costs one `GET /api/slot/mode?slot=<label>` per candidate. (An
unknown label answers **404** with `{"ok":false,"error":"slot 'X' not found"}`; an unclaimed
slot answers `{"ok":true,"mode":"idle","owner":null,"since":null,"expires_in":null}` — both
verified live.)

Second, **it does not say which slot is the DUT.** Apply this predicate:

| Purpose | Predicate over `slots[]` |
|---|---|
| Any flashable DUT | `present` **and** `devnode != null` **and** `is_probe == false` **and** `usb_warning == null` **and** `state ∉ {absent, flapping, recovering, resetting, flashing}` |
| A JTAG-debuggable DUT | the above **and** `detected_chip != null` **and** some `usb_devices[].vid_pid` starts with `303a:` |

On this bench **both slots are flashable over UART, but only `SLOT4` can be debugged**: `SLOT6`
is the same board's CH343 bridge and has no TAP. A bridge slot is neither broken nor a debug
target — do not let "prefer `detected_chip != null`" silently exclude a slot you actually
wanted to flash.

---

## 3. Canonical lifecycle

```
diagnose            GET  /api/wifi/ping            → bench reachable?
reset to baseline   POST /api/bench/reset         → known state, every run, first
discover            GET  /api/devices             → pick a slot, read its ports
lease the slot      POST /api/slot/acquire        → token, mode, ttl   (409 = someone else has it)
  ┌ work ─────────────────────────────────────────────────────────────┐
  │ flash (optional)   POST /api/flash                               │
  │ reboot             POST /api/serial/reset                        │
  │ write              POST /api/serial/write                        │
  │ observe            POST /api/serial/monitor  or  fan-out port    │
  │ provision Wi-Fi    POST /api/enter-portal   then poll ap_status  │
  │ drive the DUT      POST /api/wifi/http                           │
  └───────────────────────────────────────────────────────────────────┘
release             POST /api/slot/release        → slot back to idle
```

### 3.1 `POST /api/bench/reset` — first call of every run

Returns the whole bench to a defined baseline (`pi/portal.py:1662`). Its docstring is the
specification:

> A test that starts from whatever the previous test left behind is measuring history.

Per subsystem it stops every debug session, **restarts every present slot's proxy
unconditionally**, stops the SoftAP, leaves any joined network, stops SDR work, clears a
pending operator prompt, ends the test session, and *ensures* the MQTT broker is running
— shared infrastructure is never stopped, because other work may depend on it.

The proxy restart is unconditional on purpose: RFC2217 is single-client, and a client that
died without closing leaves the connection in `CLOSE-WAIT`, so the proxy is alive but
refuses everyone with "port is busy".

Response (real):

```json
{"ok": true,
 "changed": ["stopped debug session on SLOT4","restarted proxy for SLOT4",
             "restarted proxy for SLOT6","left WiFi network"],
 "errors": []}
```

Every step is attempted even if an earlier one fails; `changed` is empty when the bench was
already clean. Treat `errors: []` as the success condition alongside `ok`.

**This is also the only documented way to clear a wedged slot.** On "port is busy", call
`bench/reset` rather than retrying (`docs/Harness-FSD.md:1190-1202`).

### 3.2 Ordering constraints

1. `bench/reset` **before** acquiring anything — it releases all grants ("released N slot
   grant(s)" appears in `changed`). It is also **run-exclusive**: see §3.3.
2. **After `bench/reset`, `detected_chip` has been cleared.** It repopulates within ~5 s
   (measured). If you intend to *choose* a slot by chip, poll `/api/devices` for up to ~10 s
   first (§2.2). If `present` is all you need, do not wait.
3. **You do not need to stop debug before flashing.** `/api/flash` stops the session itself,
   flashes, and restarts OpenOCD with `reset run` (`pi/portal.py:1991-2003, 2063-2075`). What
   refuses on a live debug session is `slot/acquire` (409 — §4), not the flash.
4. **Flashing over RFC2217 does not reboot the device** — esptool runs with
   `--after no-reset`, so follow with `POST /api/serial/reset`. (`POST /api/flash` is the
   exception: the portal fixes `--before default_reset --after hard_reset`, so the board ends
   up running. A `serial/reset` after a `flash` is still worth doing *to capture boot
   output*, not to make the board boot.)
5. **Release a slot left in `download_mode`** with `POST /api/serial/release`.
6. `enter-portal` is **asynchronous** — a 200 means "started", not "provisioned". Poll
   `GET /api/wifi/ap_status` or `GET /api/log`. Do **not** raise the AP first (§8.5).

### 3.3 `bench/reset` is destructive and run-exclusive

The same call that gives you a clean baseline **destroys** everyone else's state: it stops all
debug sessions, restarts every proxy, releases all slot grants, stops the SoftAP, leaves any
joined network, and clears a pending operator prompt. The API has no authentication and no
run-lock, so two plugins sharing this bench will silently sabotage each other.

A plugin must therefore treat the bench as **single-tenant while it holds a run**, and should
say so to its operator: one dispatcher, or an out-of-band agreement, before the first
`bench/reset`. `bench/reset` mid-run is also the documented cure for a wedged slot (§11), so
"reset whenever something looks stuck" is a valid and antisocial move — record what it changed
(`changed[]`) and report it rather than hiding it.

---

## 4. Slot leases (`FR-031`–`FR-035`)

The documentation says any consumer that touches a slot — including the portal's own
operations — is expected to acquire first (`docs/Harness-FSD.md:1066-1071`). **The code does
not enforce that.** Read §4.1 before you build a lock around it.

```
POST /api/slot/acquire  {"slot":"SLOT4","mode":"flashing","owner":"my-plugin","ttl":300}
```

**Modes** (`pi/portal.py:1772-1773`): `idle`, `flashing`, `resetting`, `monitoring`,
`flapping`, `recovering`, `download`, `debugging`.

**TTL**: default 60 s, clamped to 1…3600 s (`pi/portal.py:1774-1775`).

| Outcome | Status | Body |
|---|---|---|
| Granted | 200 | `{"ok":true,"token":"<12 hex>","mode":str,"expires_in":float}` |
| Held by someone | **409** | `{"ok":false,"error":"held","mode","owner","since","expires_in"}` |
| Held by a debug session | **409** | `{"ok":false,"error":"held","mode":"debugging","owner":"debug-session",...}` |
| Held out of band (stray process on the devnode) | **409** | `{"ok":false,"error":"device held out of band","pid","cmdline"}` |
| Bad mode / no owner | 400 | `{"ok":false,"error":...,"modes":[...]}` |

**A refusal is a normal outcome, not an exception.** Read who holds the slot and why; never
retry in a loop. The manager **refuses, never pre-empts** (`FR-033`).

While working longer than the TTL, `POST /api/slot/renew {"token":...}` extends by the
original ttl. When done, `POST /api/slot/release {"token":...}` returns the slot to `idle`.
Expired grants vanish on their own; an expired token yields 404 on renew/release.

`GET /api/slot/mode?slot=SLOT4` returns `{"ok":true,"mode","owner","since","expires_in"}`.
When no grant exists but a debug session is active, it reports
`{"mode":"debugging","owner":"debug-session"}` — observed live.

### 4.1 A lease is advisory, not an interlock

The grant table (`_grants`) is consulted in exactly four places: `slot/acquire`, `slot/renew`,
`slot/release` and `slot/mode`. **No work handler checks it** — flashing, serial writes, resets,
debug start and every Wi-Fi handler run without looking at who holds the slot (verified by
searching `pi/portal.py` for any reference to the grants table outside those four).

Consequences a plugin must plan for:

- Holding a lease does **not** stop you from flashing your own slot, and does **not** stop
  another client from flashing it.
- Another client's lease does **not** make your flash fail. You will not get a 409 from
  `/api/flash` because someone else leased the slot.
- The only real interlocks are (a) `FR-035` — a live OpenOCD session refuses non-`debugging`
  leases, and (b) `_unexpected_holders()` — a stray process on the devnode refuses any lease.

So use leases for two things: **agreement** between cooperating clients, and **visibility** —
`GET /api/slot/mode` is how an operator learns what your plugin is doing. Never rely on a lease
to guarantee exclusivity, and never report "the bench was busy" on the strength of one.

**Choose the TTL for the work, not the 60 s default.** A flash may take up to 300 s and an OTA
up to 180 s, so a 60 s grant expires mid-operation. Pass `ttl` ≈ the expected duration (up to
3600) and renew past half of it. Because nothing enforces the grant, a lapse is harmless; it
only makes you invisible.

**`mode` is not validated against the operation.** You may acquire `flashing` and then only
read serial output; nothing objects. The eight lease modes are *intent labels*, and they are
**not** the same vocabulary as a slot's `state` — `download` (lease mode) vs `download_mode`
(slot state) is the trap (§12.6).

---

## 5. API surface available on this bench

Full parameter lists, defaults and response shapes are in `testbench-api-manifest.json`.
This section gives the grouping and the semantics that tables cannot carry.

### 5.1 Serial (the primary DUT channel)

| Endpoint | Purpose |
|---|---|
| `POST /api/serial/write` | Send bytes. `{"slot","text"}` or `{"slot","hex"}`, plus `newline` (default **true**). Returns `{"ok":true,"written":<bytes>}`. **Use this instead of opening RFC2217.** |
| `POST /api/serial/monitor` | Blocking read for up to `timeout` s (default 10), returning early on `pattern`. Returns `{"ok","matched":bool,"line","output":[str]}`. Reads the **read-only fan-out**, so it coexists with a writing client. **On timeout it still returns `ok: true`** with `matched:false,"line":null,"output":[]` (verified live) — check `matched`. `pattern` is a **case-sensitive substring** match against each stripped line (`pi/portal.py:1357,1364`); omitting it is legal and returns `matched:false` after the timeout. |
| `GET /api/serial/output` | Passive buffer read. `?slot=&lines=` (default 50) `&since=`. Returns `{"ok":true,"lines":[{"ts","text"}]}`. Ring holds 1000 lines. **`since` is exclusive** — passing the last `ts` you saw returns only strictly newer lines (verified). `lines` has **no upper clamp**: `lines=99999` returns the whole ring. **But `ts` values are not unique**: a burst of lines shares one stamp (the §8.3 sample has three lines on `1795560078.2`), so `since=<last ts>` silently drops a reply that arrived in the same batch. Either poll from `since = last_ts - 1e-6` and drop the overlap by counting lines rather than comparing stamps, or just re-read a short `lines=` tail and look for your token. |
| `POST /api/serial/reset` | DTR/RTS reset (or JTAG reset when debugging) + boot capture. Returns `{"ok","output":[str]}`. |
| `POST /api/serial/release` | BOOT→high-Z and pulse EN. Clears `download_mode`. |
| `POST /api/serial/recover` | Start flap recovery. Returns "started", **not** the outcome — poll `/api/devices`. |
| `POST /api/serial/gpio-test` | Measure whether BOOT/EN are actually wired (~15 s, synchronous). |

**The monitor-before-write race.** A reply to a one-line command arrives in milliseconds.
Open the monitor first, or write and then check `GET /api/serial/output` — the portal
records continuously, which is what makes write-then-read reliable rather than
usually-reliable (`pytest/testbench_driver.py:952-967`).

**Which line is the reply?** The ring interleaves the DUT's own logging (`heartbeat 49`,
`wifi=0 ble=0`, …), so "the first new line" is usually not your answer. Match a token you can
name — `OK pong` for the partner firmware's `ping`, a version banner, an error prefix — and if
you cannot name one, treat "no matching line" as an inconclusive result rather than a pass.

**A silent port is not evidence of a silent device.** Until a positive control (a known
command producing a known reply) has been observed, silence is a claim about the observer
(`docs/Harness-FSD.md:913`).

### 5.2 Flashing and identification

| Endpoint | Notes |
|---|---|
| `POST /api/flash` | **Multipart.** Text fields `slot` (required), `chip` (`"auto"`), `baud` (`"921600"`), `flash_mode` (`"dio"`), `flash_freq` (`"40m"`), `flash_size` (`"keep"`), `erase` (**off by default**; truthy only for `"1"`/`"true"`/`"yes"`/`"on"`). Images arrive in one of **two forms**: (a) parts **named `bin@<offset>`**, or (b) an ESP-IDF `flash_args` text part plus the `.bin` files it references, each named by bare basename. The portal stops the proxy, runs esptool against the devnode, restarts the proxy and hard-resets. Returns `{"ok","output","returncode"}`. It does **not** refuse on a debug session — it stops and restores it (§0.4). Server-side esptool timeout 300 s. |
| `POST /api/flash/read` | `{"slot","offset","length","chip"}` → `{"ok","offset","length","sha256","data_b64"}`. 120 s budget. |
| `POST /api/chip/info` | `esptool flash-id`. Returns `chip`, `revision`, `features`, `crystal`, `usb_mode`, **`mac`**, flash identity. **The only per-board identifier** — use `mac` to confirm you are talking to the right board. 502 if the device does not answer. 60 s budget. |

**Part naming — the rules that actually bite.** Field names are read with
`name.startswith("bin@")` and the offset with `int(offset, 0)` (`pi/portal.py:4200-4206`):

| You write | Portal does | Result |
|---|---|---|
| `bin@0x8000` | parses as hex → 32768 | **correct** |
| `bin@8000` | `int("8000", 0)` → **decimal 8000** (= `0x1F40`) | **wrong address, board will not boot** |
| `Bin@0x8000` | does not match `bin@` → treated as a plain file | 400 `"no binaries to flash"` |
| `bin@zzz` | offset fails to parse | 400 `"invalid offset in 'bin@zzz'"` |

So **always write the `0x` prefix**, and keep the part name lowercase and exact. `int(x, 0)`
also accepts `0o…`/`0b…`. The part's **`filename`** becomes the key esptool writes, so it must
match what `flash_args` expects and **must not contain `/` or `..`** (rejected 400 as path
traversal).

Minimal valid body, RFC 7578 framing (any correct multipart encoder is fine — boundaries are
yours to choose). Real bytes, elided as `<…>`:

```
--B0UNDARY\r\n
Content-Disposition: form-data; name="slot"\r\n\r\n
SLOT4\r\n
--B0UNDARY\r\n
Content-Disposition: form-data; name="chip"\r\n\r\n
esp32s3\r\n
--B0UNDARY\r\n
Content-Disposition: form-data; name="bin@0x0"; filename="bootloader.bin"\r\n
Content-Type: application/octet-stream\r\n\r\n
<bootloader bytes>\r\n
--B0UNDARY\r\n
Content-Disposition: form-data; name="bin@0x8000"; filename="partition-table.bin"\r\n
Content-Type: application/octet-stream\r\n\r\n
<partition bytes>\r\n
--B0UNDARY--\r\n
```

**The `flash_args` form is the better one when you have an ESP-IDF build.** Upload esptool's
own `build/flash_args` as a part named `flash_args`, plus every `.bin` it references as a part
named by its bare basename; the portal parses the offsets, and honours `--flash_mode`,
`--flash_freq` and `--flash_size` from the same file (`pi/portal.py:4233-4263`). A referenced
file that was not uploaded fails with a 400 saying it `references '<name>' but it was not
uploaded` — a much better error than a silent misfire.

**Offsets must come from the firmware's own `flash_args`/partition table, never guessed.** A
guessed offset yields a hash-verified write and a device that will not boot. A common S3 layout
is `0x0` bootloader, `0x8000` partition table, `0xf000` ota_data, `0x20000` app; a classic
ESP32 layout is `0x1000` bootloader, `0x8000` partitions, `0xe000` boot_app0, `0x10000` app.

**Do not send `erase` unless you mean it.** It is the one field whose *absence* has a default
worth guarding: omitting it preserves NVS and any calibration data on the board, while
`erase=1` wipes the whole flash. A test that does not need a virgin chip should not ask for
one.

### 5.3 Wi-Fi

Radio modes (`pi/wifi_controller.py:114-131`): **`wifi-testing`** (default; AP/STA/scan for
the DUT) and **`serial-interface`** (radio reserved for relaying the bench's own LAN).

In `serial-interface` mode every Wi-Fi endpoint except `GET /api/wifi/mode` and
`/api/wifi/ping` fails with `ok: false` and an error beginning
`WiFi testing disabled` — the message is prose, so match that prefix case-insensitively rather
than the whole string. **That is a mode condition, not a fault** — do not retry, do not report
broken.

| Endpoint | Notes |
|---|---|
| `POST /api/wifi/ap_start` | `{"ssid","pass","channel"(default 6),"internet"(False)}` → `{"ok","ip":"192.168.4.1"}`. **The password field is `pass`, not `password`.** |
| `POST /api/wifi/ap_stop` | Stops the SoftAP. |
| `GET /api/wifi/ap_status` | `{"ok","active","ssid","channel","stations":[...]}`. **Read DUT addresses here; never assume one.** |
| `POST /api/wifi/sta_join` | `{"ssid","pass","timeout"}` → `{"ok","ip","gateway"}`. |
| `POST /api/wifi/sta_leave` | Leaves the joined network. |
| `POST /api/wifi/http` | HTTP relay from the Pi to a device on the test network. `{"method","url","headers","body"(base64),"timeout"}` → `{"ok","status","headers","body"(base64)}`. **This is how you reach a DUT's own web server.** |
| `GET /api/wifi/scan` | `{"ok","networks":[...]}`. **An empty list means the air was empty; it never means the scan failed.** While the AP is running the scan is *refused* with **503 and a body that has no `ok` key at all**: `{"error":"cannot scan while the AP is running: this radio cannot beacon and survey at once. Stop the AP first (POST /api/wifi/ap_stop)."}` (`pi/wifi_controller.py:808-818`). Handle it as a mode condition, not a fault. |
| `GET /api/wifi/events?timeout=` | Long-poll for station join/leave; returns `{"ok","events":[...]}`. `0` returns immediately. |
| `POST /api/enter-portal` | Provision a captive-portal DUT onto the bench AP. **Asynchronous.** |

**AP and STA are mutually exclusive** — starting either stops the other
(`docs/Harness-User-Manual.md:610`). The AP is always `192.168.4.1/24` with DHCP
`192.168.4.2`–`.20`; a DUT's address is always a lease in that range.

`POST /api/enter-portal` fields: `portal_ssid` (default `"iOS-Keyboard-Setup"`),
`portal_ip` (default `"192.168.4.1"`), `ssid`, `password`, `save_path` (`"/connect"`),
`field_ssid` (`"ssid"`), `field_password` (`"password"`), `extra`, `method` (`"POST"`),
`internet` (false). Returns `{"ok":true,"message":"enter-portal started in background"}`.
A second concurrent call returns `{"ok":false,"error":"enter-portal already running"}`.

### 5.4 Networking helpers

| Endpoint | Notes |
|---|---|
| `POST /api/net/portscan` | TCP connect check of **one host on the AP subnet (192.168.4.0/24) — not the Pi, not the LAN**. `{"host","ports":"1-65535","timeout_s":120}` → `{"ok","host","open":[int],"scanned","complete","elapsed_s"}`. Any LAN address, hostname or network range is refused with 400 and no connection attempt (`docs/Harness-FSD.md:2017-2019`). Bounded 1–600 s. |
| `POST /api/tls-mirror/start` / `stop` / `GET status` | Serves the firmware repo over HTTPS (port 8443, self-signed) as *an untrusted peer a DUT must refuse*. `status` returns the cert `sha256` when running. |
| `GET /api/mqtt/status`, `POST /api/mqtt/start` / `stop` | Mosquitto test broker on **1883**, anonymous, all interfaces, reachable from the LAN (verified). `bench/reset` ensures it runs and never stops it. |

### 5.5 Debug (JTAG)

| Endpoint | Notes |
|---|---|
| `GET /api/debug/status` | `{"ok","slots":{label:{"debugging":true,"chip","gdb_port","telnet_port","pid","probe"} or {"debugging":false}}}` |
| `GET /api/debug/probes` | `{"ok","probes":[{"label","type","in_use","slot"}]}`. Empty on this bench — no ESP-Prog attached. |
| `POST /api/debug/start` | `{"slot","chip","probe"}`. `slot` is optional (auto-finds the first present slot). Returns `{"ok","slot","chip","gdb_port","telnet_port","probe","gdb_target":"target extended-remote <ip>:<port>"}`. **Mostly 200 — check `ok`** — but two failure paths answer **404** with `ok:false`: `"no device found"` and `"slot 'X' not found"` (`pi/portal.py`, `_handle_debug_start`). |
| `POST /api/debug/stop` | `{"slot"}`; performs `reset run` before killing OpenOCD. |
| `GET /api/debug/group` | Returns `{"ok","groups":{}}` — see §12.1. |

Ports for a session: GDB on `gdb_port`, OpenOCD telnet on `openocd_telnet_port`, and TCL on
`6666 + (gdb_port - 3333)` (`pi/debug_controller.py:85`).

**A live debug session blocks far less than the documentation claims.** Nothing in the serial or
flash path refuses outright; only the lease does:

| Operation while a session is live | What actually happens |
|---|---|
| `POST /api/flash`, `POST /api/chip/info` | both run through `flash_device`, which stops the session, does the work, then reattaches and leaves the CPU **running** (§0.4) |
| `POST /api/serial/reset` | **switches to a JTAG reset** (`jtag_reset_capturing`), falling back to DTR/RTS only if that fails (`pi/portal.py:3508-3518`) |
| `POST /api/serial/monitor`, `GET /api/serial/output` | unaffected — they read the fan-out, not the port |
| `POST /api/slot/acquire`, any mode except `debugging` | **409** — the one hard refusal (`FR-035`) |

The upstream claim that a `debugging` slot "rejects `serial/reset`, `serial/monitor` and
`enter-portal`" is not what the code does, and chasing a refusal that never comes is how you end
up calling `debug/stop` and destroying a session the portal would have restored.

**Only native-USB parts (Espressif VID `303a`) have built-in JTAG.** A classic ESP32 or any
bridge-only board needs an ESP-Prog, which this bench does not currently have.

### 5.6 GPIO

`POST /api/gpio/set` with `{"pin":<int>,"value":0|1|"z"}`. **Allowlist is `{16…27}`**
(`pi/portal.py:119`); anything else is 400. `"z"` = input with pull-up (released).

**Always release a pin with `"z"` when done.** A pin left LOW prevents the DUT from booting
and the next user will not know why (`docs/Harness-User-Manual.md:633-634`).

**`has_gpio: true` does not mean the wiring exists.** It means pins are *configured*
(`pi/portal.py:2490-2495`). Only `gpio_wired: true`, set by a successful
`POST /api/serial/gpio-test`, authorises the GPIO-based recovery path. On this bench
`gpio_wired` is `null` — **never measured** — so GPIO recovery must not be assumed.

Pin `18` (BOOT) and `17` (EN) are the configured defaults. Do not drive pins the RF
backend owns while the signal generator runs.

### 5.7 Observability

| Endpoint | Notes |
|---|---|
| `GET /api/log?since=` | `{"ok","entries":[{"ts","msg","cat"}]}`. `cat` is one of `ok`/`step`/`info`/`err`-style categories. Ring holds 200 entries. `since` is compared lexically against the ISO-8601 `ts`. |
| `GET /api/udplog?since=&source=&limit=` | `{"ok","lines":[{"ts":<float epoch>,"source":"192.168.4.17","line":"..."}]}`. DUTs push to **UDP 5555**. Buffer holds 2000 lines. **Poll incrementally with `since`; the `ts` is a float, not ISO.** |
| `DELETE /api/udplog` | Clears the buffer. |
| `GET /api/test/progress`, `POST /api/test/update` | Drives the Pi's own display panel. Optional for a plugin — use it to show the operator what is running. |
| `GET /api/human/status`, `POST /api/human-interaction` | Ask the operator to do something physical and **block** until Done/Cancel on the Pi display or `timeout` (default 120 s). Returns `{"ok","confirmed":bool}`; on timeout `{"ok":true,"confirmed":false,"timeout":true}`. Only one pending at a time — a second returns 409. **No server-side cap on `timeout`.** |

### 5.8 Firmware repository and OTA

| Endpoint | Notes |
|---|---|
| `GET /api/firmware/list` | `{"ok","files":[{"project","filename","size","modified"}]}` |
| `POST /api/firmware/upload` | Multipart: text field `project`, file part **named `file`**. → `{"ok","project","filename","size"}` |
| `DELETE /api/firmware/delete` | `{"project","filename"}`. Path traversal rejected. |
| `GET /firmware/<project>/<filename>` | **Binary** download (`application/octet-stream`). This is what a DUT pulls for HTTP OTA. No CORS header. **There is no `ok` field on this endpoint at all** — success is HTTP 200 with a non-empty body, and an error is a *JSON* `{"error":...}` body, so branch on status and `Content-Type`, never on `ok`. |
| `POST /api/ota` | Multipart: text `target` (board IP), `port` (`"3232"`), `auth`; file part **named `firmware`**. Relays ArduinoOTA via espota. 504 on timeout (180 s), 501 if espota is missing. |

### 5.9 Low-level proxy control — avoid

`POST /api/start` and `POST /api/stop` start/stop a slot's RFC2217 proxy directly.
They bypass the lease manager and `bench/reset` already does the right thing. Use them only
for diagnosis; do not build them into normal flows.

### 5.10 Not callable by a client

`POST /api/hotplug` and `POST /api/wifi/lease_event` are udev/dnsmasq callbacks fired **on
the Pi itself**. Never call them; they exist so the OS can inform the portal
(`mcp/testbench_mcp.py:39-40`).

---

## 6. Side channels (direct sockets)

| Port | Proto | Purpose | Client-usable |
|---|---|---|---|
| 8080 | TCP/HTTP | Entire API + UI + firmware download | **Yes — primary** |
| `tcp_port` (4004 here) | TCP/RFC2217 | Serial proxy for one slot | Only via esptool-style tools with `?ign_set_control`; **DTR/RTS trap** |
| `monitor_port` (5004 here) | **raw TCP** | Read-only fan-out, `tcp_port + 1000`, many concurrent readers | **Yes — safest way to watch a slot** |
| `gdb_port` (3336 here) | TCP/GDB RSP | `target extended-remote 192.168.0.29:3336` | Yes, when a session is running |
| `openocd_telnet_port` (4447 here) | TCP/telnet | OpenOCD commands (`reset run`) | Yes, when a session is running |
| 5555 | UDP | DUT debug-log receiver | DUTs only (send); read via `/api/udplog` |
| 5888 | UDP | Discovery beacon | Yes — `DISCOVER` |
| 1883 | TCP/MQTT | Test broker, anonymous | Yes |
| 8443 | TCP/HTTPS | Untrusted TLS mirror | Yes (as the *untrusted* peer) |
| 3232 | TCP | ArduinoOTA target port for `/api/ota` | Indirect |

The fan-out at `monitor_port` is verified to be a **plain TCP byte stream**, not RFC2217 —
so it asserts no control lines and is safe for many watchers. **RFC2217 is single-client**;
one writer per board, many readers via the fan-out.

Older documentation's port arithmetic (`4001+`, `3333+`, `4444+`) is the same value set as
`4000+n`/`3332+n`/`4443+n` for 1-based `n`. **Read them from `/api/devices` regardless.**

---

## 7. Capability matrix for this bench

Documented so a generator does not emit tools that can only fail.

| Capability | Status | Notes |
|---|---|---|
| Slots, serial, flash, reset, fan-out | **Available** | 7 configured, 2 present |
| Native USB-JTAG debug | **Available** | S3 on `SLOT4`, `303a:1001` |
| ESP-Prog / external probe debug | **Unavailable** | `probes: []`; no probe attached |
| Classic ESP32 (CP2102/CH340) flashing | **Available in principle** | Needs a board in a slot; reset via `/api/flash`, not RFC2217 |
| Wi-Fi AP/STA/scan/provision/relay | **Available** | Mode `wifi-testing` |
| MQTT broker | **Available** | Running on 1883 |
| TLS mirror | **Available** | Stopped by default |
| BLE | **Available** | `state: idle` (bleak installed) |
| UDP logging | **Available** | Receiver live on 5555 |
| GPIO | **Conditional** | Pins configured, **wiring never measured** (`gpio_wired: null`) |
| Signal generator | **Partial** | Only the Pi's `gpclk` backend; **no Si5351, no PE4302 attenuator**. `GET /api/siggen/status` reports `hardware: {si5351:false, gpclk:true, pe4302:true}` — the `pe4302` flag is optimistic; do not rely on attenuation. Frequencies are discrete — enumerate `GET /api/siggen/frequencies`, never sweep blindly. |
| SDR (RTL-SDR) | **Unavailable** | `available: false`, `hardware.device: false` — tools installed, **no dongle**. All `/api/sdr/*` endpoints will fail or return `available:false`. |
| RF loopback / RF measurement | **Unavailable** | Depends on both of the above |

**Recommendation:** implement tools for §5.1–§5.8 and skip `/api/sdr/*` entirely. If you
expose siggen, name it for what it is (a GPIO square-wave source), not an RF generator.

---

## 8. Worked flows (all payloads observed on the live bench)

### 8.1 Is the bench alive and what is in it?

```
GET /api/info
{"ok":true,"host_ip":"192.168.0.29","hostname":"testbench-5c62",
 "slots_configured":7,"slots_running":2}
```

### 8.2 Reset, then find a usable slot

```
POST /api/bench/reset   {}
→ {"ok":true,"changed":["stopped debug session on SLOT4","restarted proxy for SLOT4",
                        "restarted proxy for SLOT6","left WiFi network"],"errors":[]}

GET /api/devices
→ choose slots[] where present==true; read tcp_port, gdb_port, monitor_port from the entry.
```

If you intend to *choose* a slot by `detected_chip`, wait for it (poll up to ~10 s — §2.2,
§3.2); if `present` is enough, proceed immediately.

### 8.3 Talk to a DUT over serial

```
POST /api/serial/write  {"slot":"SLOT4","text":"ping","newline":true}
→ {"ok":true,"written":6}

GET /api/serial/output?slot=SLOT4&lines=6
→ {"ok":true,"lines":[
     {"ts":1795560078.2,"text":"I (10424) app_main: heartbeat 1 | wifi=0 ble=0"},
     {"ts":1795560078.2,"text":"OK pong"},
     {"ts":1795560078.2,"text":"I (50424) app_main: heartbeat 5 | wifi=0 ble=0"}]}
```

**Better, when you know the expected reply — but get the order right.** The reply often arrives
within milliseconds, so a monitor *opened after* the write can miss it entirely:

```
# correct: already watching, then write
(thread) POST /api/serial/monitor {"slot":"SLOT4","pattern":"OK pong","timeout":8}
         → {"ok":true,"matched":true,"line":"OK pong","output":[...]}
         POST /api/serial/write     {"slot":"SLOT4","text":"ping"}

# equally correct, and simpler: write, then read the recording
         POST /api/serial/write     {"slot":"SLOT4","text":"ping"}
         GET  /api/serial/output?slot=SLOT4&since=<ts you last saw>
```

Write-then-`serial/output` is the **primary** pattern, not the fallback: the portal records
continuously, so the reply cannot be missed. And when you do use `serial/monitor`, remember
that a timeout is reported as `ok:true, matched:false` — a monitor that "succeeded" and matched
nothing must be treated as a missing reply, not a pass.

### 8.4 Check what a slot is doing before touching it

```
GET /api/slot/mode?slot=SLOT4
→ {"ok":true,"mode":"debugging","owner":"debug-session","since":null,"expires_in":null}
```

That answer means **the slot is claimed for debugging — `POST /api/slot/acquire` will refuse
with 409.** It does *not* mean you cannot flash: `/api/flash` stops the session itself and
restores it afterwards (`pi/portal.py:1991-2003`). Two legitimate responses:

```
# you want the session gone for good
POST /api/debug/stop   {"slot":"SLOT4"}
POST /api/flash        (multipart; see §5.2)

# you only want to flash, and want the session back afterwards
POST /api/flash        (multipart; see §5.2)   ← portal stops and restores OpenOCD itself
```

Then, optionally, `POST /api/serial/reset {"slot":"SLOT4"}` — not because the flash left the
board halted (it hard-resets), but because you want the boot log.

### 8.5 Stand up a test network and reach a DUT

Two different jobs, and they want opposite orders.

**A. A plain test network (no captive-portal DUT):**

```
POST /api/wifi/ap_start {"ssid":"WT-1A2B3C","pass":"testpass123","internet":true}
→ {"ok":true,"ip":"192.168.4.1"}
```

**B. Provisioning a captive-portal DUT — do NOT start the AP first.** `enter-portal` has to
join the *DUT's* portal as a station, and AP/STA are mutually exclusive, so raising the bench AP
first makes the flow fight itself. `_do_enter_portal` performs one sequence: join `portal_ssid`
as STA → submit credentials to `save_path` → leave → **raise the bench AP on `ssid`**
(`pi/portal.py:3900-3960`). Your only job is to start it and poll.

```
POST /api/enter-portal  {"portal_ssid":"WB-Test-Setup","ssid":"WT-1A2B3C",
                         "password":"testpass123","save_path":"/connect",
                         "field_ssid":"ssid","field_password":"password","internet":true}
→ {"ok":true,"message":"enter-portal started in background"}

GET  /api/wifi/ap_status   → poll: first until active:true, then until stations[] is non-empty
→ {"ok":true,"active":true,"ssid":"WT-1A2B3C","channel":6,
   "stations":[{"mac":"...","ip":"192.168.4.17"}]}

POST /api/wifi/http {"url":"http://192.168.4.17/"}
→ {"ok":true,"status":200,"headers":{...},"body":"<base64>"}
```

Note the field-name inconsistency you must **not** "tidy up": `enter-portal` takes
**`password`**, while `ap_start` takes **`pass`** (§12.3).

**Which station is the DUT?** `stations[]` carries `{mac, ip}` and nothing binds it to the board
you just provisioned. Snapshot the list *before* starting, then accept exactly one **new**
station. If two appear, do not guess: correlate through `GET /api/udplog` (a DUT logging to UDP
5555 arrives with its IP in `source`) or the MAC from `chip/info`, and otherwise fail loudly
with both candidates named.

Use the IP from the station list. Never assume `.17`, and never point station tests at the
house LAN.

---

## 9. Error-handling contract

Order of tests: **`ok`** → the endpoint's **own success field** → **`error`** → status code.
Skipping the second step is the most common way a generated client reports a timeout as a pass:

| Endpoint | `ok` is `true`… | …but you must also require |
|---|---|---|
| `POST /api/serial/monitor` | on timeout | `matched == true` |
| `POST /api/human-interaction` | on operator timeout **or Cancel** | `confirmed == true` |
| `POST /api/net/portscan` | when truncated | `complete == true` |
| `POST /api/bench/reset` | with a non-empty `errors[]` | `errors == []` |
| `GET /firmware/<project>/<filename>` | it has no `ok` at all | HTTP 200 **and** a non-empty non-JSON body |
| everything else | — | nothing further |

The manifest carries the same rule per endpoint in a `success_predicate` field, so a generator
should read that rather than keep a list of special cases.

| Status | Meaning | Typical `error` |
|---|---|---|
| 200 | **May still be a failure** — check `ok` |
| 400 | Malformed/invalid request | `"empty body"`, `"missing 'slot' field"`, `"unknown mode 'x'"`, `"pin N not in allowed set"`, `"need 'text' or 'hex'"`, `"missing ssid"` |
| 404 | No such route, slot or token | `{"error":"not found"}` (**no `ok`**), `{"ok":false,"error":"slot 'X' not found"}`, `"unknown or expired token"` |
| 409 | Conflict, not a bug | `"held"` (slot leased), `"device held out of band"`, `"another request pending"` |
| 500 | Server-side operation failed | flash/OTA/ble failures, with `output`/`returncode` |
| 501 | Feature not installed here | `"espota.py not installed"`, `"BLE not available (bleak not installed)"` |
| 502 | Device did not answer esptool | chip-info failure |
| 503 | Subsystem unavailable/refused | `"signal generator not available"`, `"SDR receiver not available"`, Wi-Fi scan radio refusal |
| 504 | OTA timeout | `"espota timed out (board unreachable?)"` |

Two traps:

- **`{"error": "not found"}` has no `ok` key.** Code that does `if not body["ok"]` raises
  `KeyError` on an unknown route. Use `body.get("ok")`.
- **Malformed JSON is an unhandled exception** (`pi/portal.py:2710-2714`) — the connection
  closes instead of returning 400. Always send valid JSON. A stdlib client cannot reliably tell
  the two failure modes apart (the error surfaces the same way at 1 ms and at 200 s), so decide
  from *what you were doing*: a connection that fails before any response, on a small request,
  is a defect in your request; one that drops part-way through a long operation (flash, OTA,
  portscan) is far more likely the portal or the network, and `bench/reset` is then the
  documented recovery (§11) — not a reason to keep retrying.

Blocking calls and their real budgets: `serial/monitor` (client `timeout`, default 10 s),
`wifi/events` (client `timeout`, default 0), `human-interaction` (client `timeout`, default
120 s, **uncapped**), `net/portscan` (clamped 1–600 s), `bench/reset` (~90 s — the biggest
one, and it is your *first* call), `flash` (300 s), `flash/read` (120 s), `chip/info` (60 s),
`ota` (180 s), `serial/gpio-test` (~15 s), `serial/reset` (~7 s). Set your own client timeouts
*above* these. Non-blocking calls (`wifi/ping`, `devices`, `slot/mode`, `log`) are fast; allow
5–10 s so a briefly busy Pi is not reported as down.

---

## 10. Rules a plugin must not break

1. **Call `bench/reset` at the start of every run**, and report what it changed.
2. **Acquire before touching a slot, and release when done** — but know that it is **advisory**
   (§4.1), so it prevents collisions by agreement only. Do not pre-empt a 409; report the
   incumbent and stop.
3. **Never open `rfc2217://` just to read.** Use the monitor endpoint or the fan-out.
4. **Do not stop a debug session just to flash.** `/api/flash` stops and restores it for you
   (§0.4); call `debug/stop` only when you want the session gone for good.
5. **Release GPIO pins to `"z"`**; never leave one driven.
6. **Leave the DUT in a state you would want to find it.** A flash is not finished until
   the board boots something coherent — reflash a known image or say plainly what you left.
7. **Read addresses and ports from the bench.** No hardcoded slot, port, or DUT IP.
8. **Never point `net/portscan` at the LAN**; it is for the `192.168.4.0/24` test network.
9. **Do not treat `detected_chip: null` as absence**, and do not treat an empty Wi-Fi scan
   as a failure.
10. **Do not build on `group`/`role`** — they are always `null` (§12.1).
11. **Check `ok` *and* the endpoint's own success field.** `ok:true` alone means the *request*
    worked, not the *operation* (§9).
12. **Tell your operator that `bench/reset` is destructive to anyone else's run** (§3.3). The
    API cannot arbitrate, so the plugin must.

---

## 11. Traps with hardware causes

- **Charge-only USB cables.** A board can light up on VBUS with no D+/D− data lines, so it
  never enumerates. Symptom: silence, zero USB events. Verify a cable with a known-good
  device before blaming the bench.
- **Bridge-only boards cannot be reset over RFC2217.** esptool needs DTR/RTS, which the
  proxy may assert for you, giving `Wrong boot mode`. Use `POST /api/flash` instead.
- **A wedge is not a failure.** After a client dies mid-flash, the slot answers "port is
  busy" forever until `bench/reset`.
- **Slot count grows with hub topology.** An S3 board with an on-board hub presents *two*
  serial slots (native USB + CH343). Expect more slots than boards.
- **`ttyACM` numbers move.** Always re-read `/api/devices` after a flash or reset.

---

## 12. Where the upstream source contradicts its own documentation

A generator that reads upstream `docs/` instead of this file will encode these bugs.

**12.1 `group` / `role` are documented but never populated.** `_make_slot` accepts both
(`pi/portal.py:645-647,665-666`) but no call site passes them — the config loader
(`pi/portal.py:587-593`) never reads `group`/`role`, and `_make_dynamic_slot`
(`pi/portal.py:994`) does not either. Consequences: `GET /api/debug/group` **always**
returns `{"ok":true,"groups":{}}`; `role` is always `null`; the `role == "debug"` branch at
`pi/portal.py:4657` is dead. Pairing two interfaces of one board is therefore **not
implementable** today. Identify boards by `mac` from `/api/chip/info`.

**12.2 Failure codes reported at HTTP 200.** `/api/start`, `/api/enter-portal`,
`/api/human/done`, `/api/human/cancel`, `/api/debug/stop`, every Wi-Fi handler exception, and
several `/api/serial/*` "slot not found" paths return `{"ok":false}` with status 200. The same
class of error is **404** in `/api/debug/start` ("no device found", "slot 'X' not found") and
`/api/slot/mode` — so a client cannot assume either convention.

**12.3 The `mcp/testbench_mcp.py` tool schema has drifted from the portal.** If you model
your tools on it, copy these corrections:

| Tool | MCP says | Portal actually reads |
|---|---|---|
| `wifi_ap_start` | `password` | **`pass`** — a `password` arg is silently ignored and the AP starts **open** |
| `enter_portal` | `slot`, `resets` | dead args; portal reads `portal_ip` (unexposed) |
| `siggen_start` | `wpm` | must be nested inside a `morse` object |
| `serial_output` | `lines` default 40 | default **50** |
| `debug_start` | `slot` required | `slot` **optional** (auto-finds) |
| `gpio_set` | `value` as string | accepts `0`, `1`, or `"z"` |
| `wifi_mode_set` | `mode` only | `ssid` is required for `serial-interface` |

The MCP wrapper also flattens HTTP status codes, so a generated tool should call the HTTP
API directly rather than proxy through it.

**12.4 `_handle_flash` is defined twice** in `pi/portal.py` (3583 and 4123). The second
wins; the first is dead code describing a different, wrong parameter contract. Trust §5.2.

**12.5 Smaller inconsistencies**, all resolved in favour of the code above: `serial_output`
defaults, GPIO release (`"z"` is implemented; some spec text says drive HIGH), flap
threshold (code says 10 events/30 s, one doc table says 6), retry count (code 2, one doc
says 4), and the slot `state` enumeration (nine values, some tables list seven).

**12.6 Other source-vs-documentation gaps**, resolved in favour of the code:

| Topic | Documentation implies | The code actually does |
|---|---|---|
| Slot leases | "any consumer … is expected to acquire first" | **no work handler consults the grant table**; leases are advisory (§4.1) |
| Flash vs debug | flashing is refused while debugging | `/api/flash` stops the session and restores it with `reset run` (§0.4) |
| `debug_chip`, `debug_gdb_port` | keys present on every slot | **absent**, not `null`, unless `debugging` is true — use `.get()` |
| Lease `mode` vs slot `state` | one vocabulary | two overlapping ones: `download` (lease) vs `download_mode` (state); `debugging` appears in both |
| The `output` field | one shape | three: `[str]` in `serial/monitor` and `serial/reset`; `[{ts,text}]` under the name `lines` in `serial/output`; a plain `str` in `flash`, `chip/info`, `ota` |
| Failure bodies | always `{"ok": false, …}` | some carry **no `ok` key**: `{"error":"not found"}`, and `wifi/scan` while the AP runs |
| `availability` vocabulary | three words | four: `available`, `partial`, `unavailable`, `never_call` (§13) |

---

## 13. Manifest

`testbench-api-manifest.json` is the machine-readable companion; this document is the
semantics. It mirrors this document structurally:

```
{
  "bench":        { base_url, hostname, slots_configured, attached[], discovery },
  "conventions":  { auth, success_test, error_shapes, buffers, blocking_budgets_seconds, ... },
  "ports":        { service → port },
  "endpoints":    [ { id, method, path, group, purpose, params[], returns, ... }, ... ],
  "capabilities": { feature → available|partial|unavailable },
  "forbidden":    [ rules as strings ],
  "canonical_lifecycle": [ ordered steps ]
}
```

Each endpoint entry carries `id`, `method`, `path`, `group`, `purpose`,
`params[{name, in, type, required, default}]`, `returns`, `blocking`, `timeout_s`,
`availability`, `status_codes` and `notes` — 72 entries for the hardware on this bench.

**`availability` has four values, and the fourth is the one that bites:**

| Value | Count | What a generator should do |
|---|---|---|
| `available` | 63 | Emit a tool |
| `partial` | 5 | Emit a tool **plus** the runtime gate named in `prerequisite` |
| `unavailable` | 2 | Do **not** emit |
| `never_call` | 2 | Do **not** emit — `hotplug` and `wifi_lease_event` are udev/dnsmasq callbacks fired on the Pi itself |

A generator that switches on only the three values documented elsewhere will crash on the
fourth, or — worse — silently emit two callbacks that must never be sent.

`partial` is not self-explanatory, so each such entry names its gate:

| Endpoint | `prerequisite` |
|---|---|
| `gpio_set` | A successful `POST /api/serial/gpio-test` for that slot (`gpio_wired: true`). `GET /api/gpio/status` reports pin ownership only and says nothing about wiring. |
| `siggen_*` | `GET /api/siggen/status` → only the `gpclk` backend exists here; `siggen_atten` is separately `unavailable` (no PE4302). |

**Capture-time facts are volatile.** `bench.attached`, `slots_present_at_capture`,
`detected_chip`, devnodes and every port describe the bench when this was written — and §2.2
to §2.3 explain why none of them is stable. Never generate a constant from them; read
`GET /api/devices` at run time.

**Vocabulary.** §7 uses a fourth word, "Conditional", for GPIO. Where §7's prose and the
manifest's `availability` disagree, **the manifest wins** — it is the file the generator reads.
