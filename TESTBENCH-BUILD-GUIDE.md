# Building the Embedded AI Harness Testbench — Your Build

A tailored build guide for the Raspberry Pi testbench described by
[SensorsIot/Embedded-AI-Harness](https://github.com/SensorsIot/Embedded-AI-Harness).

**Your build:**

| Decision | Choice |
|----------|--------|
| Host | **Raspberry Pi 4 Model B, 2 GB** — built-in **gigabit Ethernet**, dual-band WiFi, BT 5.0/BLE, **4 USB-A ports** (2× USB 2.0 + 2× USB 3.0) |
| Topology | **Direct** — no USB hub, no USB-Ethernet adapter. Slots come off the board. |
| Instruments | **Core only** — serial, flash, WiFi, BLE, MQTT. No SDR, no Si5351/PE4302. |
| Debug | **USB-JTAG** (free, for the S3/C6) **+ ESP-Prog** (hardware JTAG, makes your classic ESP32-WROOM boards debuggable too) |
| DUTs | ESP32-S3, ESP32-C6/C3 (native USB), **and classic ESP32-WROOM dev boards** |
| Status | Pi ordered; ESP-Prog and WROOM boards in hand; PSU, card, cables, S3/C6 to buy |

Grounded against `claude_git_repo/Embedded-AI-Harness-main/` — `pi/install.sh`,
`pi/portal.py`, `pi/debug_controller.py`, `docs/Harness-User-Manual.md` §1–§3,
§6, §16, `docs/Harness-FSD.md` FR-026, and
`.claude/skills/testbench-{install,debug}/SKILL.md`.

**[REQ]** required · **[OPT]** optional · **[SKIP]** deliberately out of scope

---

## 0. The short answers

### What do I flash onto the Pi?

**Raspberry Pi OS Lite (64-bit)**, straight from Raspberry Pi Imager. Nothing
else. There is **no custom image, no prebuilt `.img`, no ISO to hunt down.**

Then clone the repo and run one installer, which puts the software where the
service expects it:

```bash
git clone https://github.com/SensorsIot/Embedded-AI-Harness.git
cd Embedded-AI-Harness/pi
sudo bash install.sh
```

`install.sh` apt-installs everything (hostapd, dnsmasq, mosquitto, bluez,
pyserial, libgpiod), pip-installs the rest (esptool ≥ 5, bleak, smbus2),
downloads `openocd-esp32`, copies 17 Python modules into `/usr/local/bin/`,
installs a systemd unit plus a udev hotplug rule, enables I²C, and takes `wlan0`
away from NetworkManager so the portal owns that radio.

> **The repo checkout is not what runs.** The service executes from
> `/usr/local/bin/`. Editing files in `~/Embedded-AI-Harness/` on the Pi changes
> nothing until they're copied and the service restarted — this one fact
> explains most "my fix didn't take effect" reports.

### SD card, or something else?

**microSD. 32 GB, A1/A2.** 16 GB works; nothing needs more.

- At **2 GB** there's no forced swapfile and no OOM-crash cycle, so card wear is
  a non-issue. A normal reputable A1/A2 card is fine.
- **No `overlayroot`** — removed from the project, so no power-loss protection.
  Shut down cleanly (`sudo shutdown -h now`).
- **USB SSD?** Works, but eats one of your four USB ports — which is where the
  slots live. Stick to the card.

### Do I need ESP-IDF on the Pi?

**No.** The AI loop builds firmware in GitHub Actions and flashes the artifact.
The bench only needs `esptool` (installed for you). ESP-IDF 6.x belongs on a
laptop, and only if you *choose* to hand-build the bench's own test-partner
firmware (§6).

### What the Pi 4 changes for the better

Your original diagram — `eth0` wired into the LAN, `wlan0` as the test AP, four
slots — **is now literally correct as drawn**.

| Was a constraint on a Pi 3 A+ | On a Pi 4 2 GB |
|------------------------------|----------------|
| No Ethernet → USB adapter required | **Built-in gigabit `eth0`** |
| 1 USB port → hub required, one slot lost to Ethernet | **4 USB-A ports**, direct |
| 512 MB → hardening mandatory, OOM → SD corruption | **2 GB → hardening optional** |
| Single 480 Mbit/s bus shared by everything | **2 ports on USB 2.0, 2 on USB 3.0** |
| "Never reset two ESP32s at once" (3B+ undervoltage) | **Does not apply to a Pi 4** |

One thing got *worse*: **cooling**. A Pi 4 under sustained four-slot + `hostapd`
load will throttle at 80 °C, and throttling presents as flaky USB — the worst
kind of bug to chase. Budget $10–15 for a fan case.

### ⚠️ Your old power supply will not fit

The Pi 4 takes **USB-C at 5.1 V/3 A**. A weaker supply limits current to the USB
ports, and your DUTs then brown out mid-flash in ways that look like bad cables.
Buy the official supply. (If your Pi 4 turns out to be an **early Rev 1.1**, an
e-marked USB-C cable is also a known reason it won't power on at all.)

### The ESP-Prog changes the plan in three ways

1. **It earns its keep on exactly one board type: the classic ESP32.** Your
   ESP32-WROOM dev boards have no USB-JTAG (they sit behind a CP2102/CH340 bridge
   chip), so without the probe they can be flashed, monitored and tested — but
   **not debugged**. With the ESP-Prog they become full first-class debug
   targets. Your S3/C6 don't need it at all.
2. **It costs one of your four USB ports.** Four ports minus the probe = **3 DUT
   slots**. That's the real trade; see §4.4.
3. **It gives you serial *and* JTAG simultaneously**, on physically separate
   connections. `printf` keeps scrolling in the serial console while you
   single-step in GDB. USB-JTAG can't do that as cleanly.

### One naming correction to make now

Your diagram says `testbench_7e71`. **That name cannot exist.** Underscore isn't
a legal hostname character (RFC 1123), and systemd doesn't reject it — it
*silently strips* it, so the kernel hostname becomes `testbench7e71` while
`/etc/hosts` still says `testbench_7e71`, and every `sudo` then stalls on
"unable to resolve host". `install.sh` renames the machine to
**`testbench-<last4ofMAC>`** with a hyphen.

Also: **address the bench by IP, never `.local`** — mDNS doesn't cross a Docker
bridge and most of this workflow runs in a devcontainer.

---

## 1. The mental model

**A slot is a hole, not a device.** SLOT1 is always the same physical USB jack,
so it's always TCP 4001 — swap boards freely and no script or `platformio.ini`
goes stale.

Feedback loops the bench gives the AI: **serial** (bytes in/out), **reset** (GPIO
or DTR/RTS), **flash** (esptool over RFC2217 *or* over `<host>/api/flash`),
**debug** (OpenOCD + GDB, via USB-JTAG or the probe), **WiFi** (the DUT joins the
Pi's AP), **BLE** (the Pi scans/connects), **UDP :5555** (DUT pushes logs when
USB is busy).

```
        LAN 192.168.0.x
              |
              | eth0 (built-in gigabit)
              v
   ┌──────────────────────────────┐
   │  Raspberry Pi 4 Model B 2 GB │
   │  hostname: testbench-XXXX    │
   │                              │
   │  wlan0 → test AP 192.168.4.1/24   (the DUT joins this)
   │  hci0  → BLE scan / connect
   │  UDP :5555  → log receiver
   │  :8080      → HTTP portal + REST API
   └──────────┬───────────────────┘
              │ 4× built-in USB-A
   ┌──────────┼──────────────┬─────────────┐
   │          │              │             │
 SLOT1      SLOT2          SLOT3         SLOT4
 :4001      :4002          :4003         :4004     ← RFC2217 serial
 :3333      :3334          :3335         :3336     ← GDB
 :4444      :4445          :4446         :4447     ← OpenOCD telnet
   │          │              │             │
 ESP32-S3   ESP32-C6     ESP32-WROOM    ESP-Prog
 (USB-JTAG) (USB-JTAG)   (bridge chip)  (FT2232H)
                              ▲             │
                              └── 4 JTAG wires ──┘
```

The ESP-Prog lives in a USB port of its own and reaches the WROOM board's JTAG
pins over jumper wires. It is a **shared resource, not a slot** — the portal
notices that port holds only a probe (no DUT), drops it from the slot list, and
routes JTAG requests for any slot through it. **One probe, one JTAG session at a
time.**

---

## 2. Parts list

### 2.1 What you have

| Part | Note |
|------|------|
| Raspberry Pi 4 Model B, 2 GB | On order. Check the **rev** when it arrives (§5.2). |
| **ESP-Prog** debug probe | FT2232H-based, enumerates as `0403:6010`. Channel A = JTAG, channel B = UART. |
| **Classic ESP32 / ESP32-WROOM dev boards** | Behind a CP2102/CH340 bridge chip — no USB-JTAG, so the ESP-Prog is what makes them debuggable. |

### 2.2 Buy — required

| # | Part | Qty | Est. | Why / spec |
|---|------|-----|------|-----------|
| 1 | **Official Raspberry Pi 4 USB-C PSU, 5.1 V/3 A** | 1 | $10–12 | **[REQ]** Non-negotiable. A weak supply starves the USB ports and browns out DUTs mid-flash. **A 3 A+ micro-USB PSU will not fit.** |
| 2 | **microSD card, 32 GB, A1/A2** | 1 | $8–15 | **[REQ]** §0. |
| 3 | **USB-A → USB-C *data* cables** (match your boards' connectors) | 2–4 | $4 ea | **[REQ]** **Data-capable, not charge-only** — the commonest "device not detected" cause. Short (< 1 m). |
| 4 | **ESP32-S3 dev board** with **native USB** | 1 | $10–15 | **[REQ]** `303a:1001` → free JTAG. The bench's own test partner is built for it. |
| 5 | **ESP32-C6 or C3 dev board** with **native USB** | 1 | $8–15 | **[REQ]** A second, *different* chip type. Unlocks per-slot debug isolation. |
| 6 | **USB-A → micro-USB data cable** for the ESP-Prog | 1 | $4 | **[REQ]** The ESP-Prog's own USB port — most are USB-B or micro-USB. Check yours. |
| 7 | **Ethernet patch cable**, Cat5e | 1 | $3 | **[REQ]** Unless you have spares. |
| 8 | **Jumper wires, female–female, 20 cm** | 1 pack | $5 | **[REQ now]** You need **4** for the ESP-Prog JTAG link (TCK/TDI/TDO/TMS) **+ 1** for ground, and 2 more if you wire GPIO reset control (§4.5). This moved from optional to required because you own a probe. |
| 9 | **330 Ω resistors** | 4 | $1 | **[REQ now]** Series protection on the GPIO17/18 EN/BOOT lines — see below for why this matters *more* with WROOM boards. |

> **Why the GPIO wiring just became more important.** Your WROOM boards sit
> behind a USB-UART bridge, and their external DTR/RTS auto-reset circuit often
> can't be driven reliably through the RFC2217 proxy — esptool reaches the chip
> but it stays in normal boot (`Wrong boot mode detected (0x13)`). The
> deterministic fix is the **GPIO17 → EN / GPIO18 → BOOT** pair, which enters
> download mode electrically instead of hoping the bridge cooperates. It's a
> $6 purchase that removes a whole class of "it flashed on my laptop but not on
> the bench" confusion.

### 2.3 Buy — strongly recommended

| # | Part | Qty | Est. | Why |
|---|------|-----|------|-----|
| 10 | **Heatsink + case with fan** | 1 | $10–20 | **[OPT but do it]** A Pi 4 throttles at 80 °C under four-slot load, and throttling looks like flaky USB. Check `vcgencmd measure_temp`. |
| 11 | **10-pin JTAG ribbon cable** (ESP-Prog → DUT) | 1 | $5 | **[NICE]** If your WROOM board has the matching 10-pin JTAG header, this replaces 5 loose jumpers and can't be mis-plugged. Most bare dev boards **don't** have the header, so jumpers are the general answer. |

### 2.4 Buy — optional

| # | Part | Qty | Est. | Buys you |
|---|------|-----|------|----------|
| 12 | **GPIO breakout HAT (BCM-labelled)** | 1 | $5–12 | **[NICE]** 40-pin header is unlabelled and cramped. Saves hours of off-by-one debugging. |
| 13 | **Powered USB 2.0 hub** | 1 | $15–25 | **[NICE]** With the ESP-Prog taking a port you're down to 3 DUT slots. A hub takes you back to 6+ and adds current headroom. Buy it when the port count, not the power, becomes the annoyance. |
| 14 | **A spare classic ESP32 dev board** | 1 | $8 | **[NICE]** Two boards can land in a state where neither is free. |
| 15 | **USB power meter** | 1 | $10 | **[NICE]** Faster than `vcgencmd get_throttled` when you suspect a supply. |

### 2.5 Deliberately skipped

| Part | Why it's fine to skip | What you lose |
|------|----------------------|---------------|
| **RTL-SDR dongle + antenna** | **[SKIP]** Independent of everything else | 433/315/868 MHz receive, `rtl_433` decode, live console, power sweeps, AI Sherlock. **WT-1909 cannot pass without a dongle.** |
| **Si5351 + PE4302** | **[SKIP]** | Programmable RF source and 0–31.5 dB attenuation. **Cheap to skip:** the documented reference run on a bench with no Si5351 skipped exactly **one** test. You still get a free carrier from **GPCLK** with zero hardware (§4.7). |

### 2.6 Budget

| | |
|---|---|
| Required (#1–9) | **~$55–80** |
| Required + cooling + ribbon | **~$70–105** |

---

## 3. Pre-flight

1. **Confirm the board when it arrives** — `cat /proc/device-tree/model` should
   read `Raspberry Pi 4 Model B Rev 1.x`.
2. **Give the bench a fixed IP** — DHCP reservation for the Pi's Ethernet MAC.
   Everything refers to `$BENCH`.
3. **Trusted network only.** **No authentication** on the API or RFC2217.
4. **Check which WROOM boards you have.** Look at `lsusb`: `10c4:ea60` = CP2102
   (`/dev/ttyUSB0`), `1a86:7523` = CH340. Either way they're bridge chips — the
   ESP-Prog is their only route to GDB.
5. **Check the WROOM boards expose JTAG pins.** GPIO12/13/14/15 must be broken
   out to a header or test points. Most DevKitC-style boards do; many production
   modules don't. Check the schematic — *no accessible pins, no JTAG, regardless
   of the probe.*

---

## 4. Assembly

### 4.1 Bench layout

```
   [ mains strip ]
        |
   [ 5.1V/3A USB-C PSU ] → [ Pi 4 in a fan case ]
                                  |
                     [ 4× built-in USB-A ]  ← label in marker pen
                        |      |      |      |
                     [S3]   [C6]  [WROOM]  [ESP-Prog]
                                                  |
                                    4 JTAG wires + GND
                                                  |
                                            [WROOM JTAG pins]
```

**Label the USB jacks.** "Same connector, same port, always" holds regardless —
but labels save you when SLOT3 misbehaves and SLOT1 doesn't.

**Keep the ESP-Prog lead short.** It's carrying a 20 MHz-capable JTAG clock on
loose jumper wires; 20 cm is fine, 50 cm with a coil of slack next to a WiFi
antenna is asking for `JTAG scan chain interrogation failed`.

### 4.2 Stage 1 — Pi

1. Fit the heatsink; fit the fan case (fan to pins 4 = 5 V, 6 = GND).
2. Insert the microSD (flashed per §5.1).
3. **Do not plug in any board or probe yet.** First boot should be a clean Pi.
4. Connect Ethernet.
5. Apply power **last**.

### 4.3 Stage 2 — network

| Link | Interface | Carries |
|------|-----------|---------|
| Pi → router | **`eth0`** (built-in gigabit) | HTTP API :8080, RFC2217 :4001+, GDB :3333+, OpenOCD :4444+ |
| Pi → DUTs | **`wlan0`** | WiFi test AP at `192.168.4.1/24`, channel 6 default |

**These must never overlap**, and the installer enforces it: `wlan0` marked
unmanaged in NetworkManager, `wpa_supplicant.*` disabled, `hostapd` masked,
`dnsmasq`/`mosquitto` disabled (started on demand), plus a `dhcpcd` stanza so the
bench never takes DNS from a test network.

> ⚠️ **Wire it; don't bootstrap over WiFi.** `install.sh` takes `wlan0` away from
> NetworkManager, so a WiFi-only SSH session dies and doesn't come back. You have
> Ethernet built in — use it and leave WiFi unconfigured in the Imager.

### 4.4 Stage 3 — USB slots and the port budget

Plug each DUT into a USB-A port with a short **data** cable. The portal walks
`/sys/bus/usb/devices/`, finds every downstream hub, and creates **one slot per
usable port** — but it also recognises your ESP-Prog and **excludes it from the
slot list**.

| Layout | DUT slots | Debug available |
|--------|-----------|-----------------|
| 3 boards, **no probe** | **3** | S3 + C6 only (native USB-JTAG) |
| 2 boards + probe | **2** | those two, plus any WROOM board wired to the probe |
| 3 boards + probe | **3** | all three; WROOM via probe, others native |
| Probe + powered hub | 6+ | all, plus room to grow |

**Which port for what?** A Pi 4 exposes **2× USB 2.0 (black)** and **2× USB 3.0
(blue)**, all four becoming slots with identical behaviour. Put native-USB-JTAG
boards on the **black USB 2.0** ports — that path is more forgiving for Espressif
CDC/JTAG enumeration and the DTR/RTS timing the portal depends on. The **ESP-Prog
is FTDI and is happiest on USB 2.0 as well**; put it on black if you can, and
keep the WROOM's data cable on whichever port remains. If a board misbehaves on
blue, move it to black before suspecting anything else.

**The probe is auto-recognised.** The portal scans each port's devices for FTDI
probe PIDs — `6010` (FT2232H), `6011` (FT4232H), `6014` (FT232H), `6015`
(FT230X) — and treats a port holding *only* those as a **probe-only slot, not a
DUT**. An FT232R (`6001`) is deliberately *not* a probe; it's a plain USB-UART.

**Verify before touching software:**

```bash
lsusb                            # each board, plus 0403:6010 for the probe
lsusb -d 303a:1001               # native-USB-JTAG boards only (S3/C6)
lsusb -d 0403:6010               # the ESP-Prog
ls /dev/ttyACM* /dev/ttyUSB*     # ttyACM = native USB; ttyUSB = bridge chip + probe
```

The ESP-Prog shows **two** `/dev/ttyUSB*` nodes (channel A and B). That's normal —
channel A gets unbound from the kernel driver the moment OpenOCD needs it.

If a board is missing from `lsusb`, it's a **cable or power** problem. Swap for a
known data cable and test one board alone.

> **Expected DUT slot count: 4 without the probe, 3 with it.** Unlike a Pi 3B+ —
> which reports a phantom fifth port at `0:1.4` that the portal filters from a
> per-model table — the Pi 4 has no phantom ports. Auto-detection is trustworthy
> here; you don't need `testbench.json` for slots at all, only for the probe
> declaration (§4.6.3).

### 4.5 Stage 4 — GPIO reset/boot control

Recommended for you specifically, because your WROOM boards' bridge-chip reset
can't be driven reliably over the network (see §2.2).

| Pi GPIO (BCM) | Header pin | Function | DUT pin |
|---------------|-----------|----------|---------|
| **17** | pin 11 | Hardware reset, **active LOW** | `EN` / `RST` |
| **18** | pin 12 | Boot mode select, **active LOW** | `GPIO0` (ESP32) / `GPIO9` (C3, C6) |
| **GND** | 6, 9, 14, 20, 25, 30, 34, 39 | Common ground | `GND` |

```
   Pi pin 11 (GPIO17) ──[ 330 Ω ]──┬──────── DUT EN / RST
                                   │
   Pi pin 12 (GPIO18) ──[ 330 Ω ]──┼──────── DUT GPIO0 / GPIO9
                                   │
   Pi pin 6  (GND)     ────────────┴──────── DUT GND      ← common ground is mandatory
```

- Wire this to whichever slot holds the board most likely to boot-loop — for you,
  the WROOM.
- These defaults are already in the shipped config: `"gpio_boot": 18, "gpio_en": 17`.
- **API pins are restricted to `{16…27}`** (`pi/portal.py` line 119). The User
  Manual's §8 lists "5, 6, 12, 13, 16–27" — **stale**; 5/6/12/13 belong to the
  signal generator and the API refuses them. Use **17 and 18**.
- **Always release a held pin** with `{"value": "z"}`. A pin left LOW stops the
  DUT booting.

### 4.6 Stage 5 — ESP-Prog hardware JTAG

This is the section that makes your WROOM boards first-class.

#### 4.6.1 Wiring — ESP-Prog to DUT

The ESP-Prog's 10-pin JTAG header to your board's JTAG pins. **Pin numbers are
the ESP-Prog header's, not the DUT's:**

| ESP-Prog pin | Signal | Classic ESP32 (WROOM) | ESP32-C3 / C6 / H2 | ESP32-S3 / S2 |
|:---:|---|:---:|:---:|:---:|
| 1 | VDD 3.3 V *(see warning)* | 3V3 | 3V3 | 3V3 |
| 2 | **TMS** | **GPIO14** | GPIO7 | GPIO42 |
| 3 | GND | GND | GND | GND |
| 4 | **TCK** | **GPIO13** | GPIO4 | GPIO39 |
| 5 | GND | GND | GND | GND |
| 6 | **TDO** | **GPIO15** | GPIO6 | GPIO41 |
| 7 | GND | GND | GND | GND |
| 8 | **TDI** | **GPIO12** | GPIO5 | GPIO40 |
| 9 | GND | GND | GND | GND |
| 10 | NC | — | — | — |

For your WROOM boards you need exactly **five wires**: TCK → GPIO13,
TDO → GPIO15, TMS → GPIO14, TDI → GPIO12, and **at least one GND**. A resistor
or two in series is cheap insurance, but 20 cm of jumper is fine uncut.

> ⚠️ **Do not wire pin 1 (VDD) to a board that is USB-powered.** The probe can
> source 3.3 V to the target, and feeding a board that already has USB power is
> how you get two supplies arguing. Leave pin 1 unconnected unless you're
> debugging a bare module with no other power source.

> ⚠️ **GPIO12 is a strapping pin on the classic ESP32.** TDI is GPIO12, which is
> *also* the flash-voltage selector. If it's HIGH at power-on, the chip
> configures **1.8 V flash** and crashes on a 3.3 V board. The bootloader on some
> WROOM devkits survives this; some don't, and the symptom is a board that
> "suddenly won't boot" the first time you connect a probe. Two mitigations:
> burn the `VDD_SDIO` eFuse once to force 3.3 V (§4.6.4), or tell OpenOCD not to
> fight the strapping pin with `reset_config none`.

> **GPIO12/13/14/15 also collide with the SD-card interface** on boards that have
> a microSD slot. If your WROOM board has one, check the schematic before wiring —
> the pins are often shared and the SD card wins.

#### 4.6.2 The kernel grabs channel A — the portal handles it

The Linux `ftdi_sio` driver claims **both** FT2232H channels as serial ports, so
OpenOCD can't open channel A (JTAG) until it's released from that driver:

```bash
echo '1-1.4:1.0' | sudo tee /sys/bus/usb/drivers/ftdi_sio/unbind
#  └─ {bus}-{port}:1.0 ── interface 0 = channel A = JTAG
```

**You don't do this by hand — the portal does it.** `debug_controller.py` unbinds
channel A before every OpenOCD attempt and **rebinds it on stop**, restoring
`/dev/ttyUSB0`. Channel B (UART) stays bound throughout.

But it only knows *which* interface to unbind if you tell it — that's the
`bus_port` field in the config below. **Omit `bus_port` and the unbind never
happens**, OpenOCD fails to open the probe, and the error message blames your
wiring.

Find the value:

```bash
lsusb -d 0403:6010
# Bus 001 Device 020: ID 0403:6010 FTDI ... FT2232C/D/H Dual UART/FIFO IC

# Now resolve that device to its sysfs port path:
for d in /sys/bus/usb/devices/*/; do
  [ "$(cat $d/idVendor 2>/dev/null)" = "0403" ] && \
  [ "$(cat $d/idProduct 2>/dev/null)" = "6010" ] && echo "$d"
done
# → /sys/bus/usb/devices/1-1.4/   ⇒ bus_port = "1-1.4:1.0"
```

#### 4.6.3 Declare the probe

There is **no default `testbench.json`** — create it for this one purpose:

```bash
sudo nano /etc/rfc2217/testbench.json
```

```json
{
  "gpio_boot": 18,
  "gpio_en": 17,
  "debug_probes": [
    {
      "label": "PROBE1",
      "type": "esp-prog",
      "interface_config": "interface/ftdi/esp_ftdi.cfg",
      "bus_port": "1-1.4:1.0"
    }
  ]
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `label` | **yes** | Name you'll pass as `"probe"` — code does `cfg["label"]` with no fallback, so this is the one field that will crash if missing |
| `type` | no | Defaults to `esp-prog` |
| `interface_config` | no | Defaults to `interface/ftdi/esp_ftdi.cfg`. If OpenOCD can't identify the probe, the FSD's alternative is `interface/ftdi/esp32_devkitj_v1.cfg` |
| `bus_port` | **effectively yes** | `{bus}-{port}:1.0` from §4.6.2. Optional in the schema, required in practice: without it the `ftdi_sio` unbind is skipped |
| `usb_serial` | no | Recorded but not used for selection; leave it out unless you own several probes |

Apply and verify:

```bash
sudo systemctl restart rfc2217-portal
curl -s http://localhost:8080/api/debug/probes | jq
# → {"ok": true, "probes": [{"label": "PROBE1", "type": "esp-prog",
#                            "in_use": false, "slot": null}]}
```

**Do not** pin slots in this file unless you want to — auto-detection is correct
on a Pi 4, and the probe is found by USB inspection, not by slot config.

#### 4.6.4 Start a debug session

The probe is a **shared resource, not tied to a slot**: the portal records which
slot's DUT is currently attached to it and refuses a second concurrent request.

```bash
# A WROOM board in SLOT3, classic ESP32
curl -X POST http://$BENCH:8080/api/debug/start \
  -H 'Content-Type: application/json' \
  -d '{"slot":"SLOT3","chip":"esp32","probe":"PROBE1"}'
```

```json
{"ok": true, "slot": "SLOT3", "probe": "PROBE1", "chip": "esp32",
 "gdb_port": 3333, "telnet_port": 4444,
 "gdb_target": "target extended-remote $BENCH:3333"}
```

`chip` tells OpenOCD which target config to load (`target/esp32.cfg` for a
WROOM). Then:

```bash
# GDB from your laptop
gdb -ex 'target remote $BENCH:3333'

# OpenOCD telnet: reset / halt / inspect
echo "reset halt" | nc $BENCH 4444
echo "halt"       | nc $BENCH 4444
```

Stop it — **this is what rebinds channel A and frees the probe:**

```bash
curl -X POST http://$BENCH:8080/api/debug/stop \
  -H 'Content-Type: application/json' -d '{"slot":"SLOT3"}'
```

**What you keep during a probe session:** the serial console. Unlike a native
USB-JTAG session, the probe uses the JTAG pins and never touches the USB serial
path, so the RFC2217 proxy stays up — you can watch `printf` output while
single-stepping. What you *lose* is flashing: esptool can't run while the CPU is
halted at a breakpoint, and `/api/flash` is refused outright while a debug
session is active.

**If `chip` is unknown**, ask the bench — the portal auto-detects by trying
target configs in order (`esp32`, `esp32s3`, `esp32c3`, `esp32c6`, `esp32h2`,
`esp32s2`), and `GET /api/devices` reports what it found.

#### 4.6.5 The 1.8 V flash trap — fix it once, permanently

On a classic ESP32, wire everything from §4.6.1 and then check the board still
boots. If it doesn't, or you see crashes that smell like flash problems, the
strapping pin has latched 1.8 V flash. Burn the `VDD_SDIO` eFuse to force 3.3 V:

```bash
espefuse.py --port rfc2217://$BENCH:<PORT> set_flash_voltage 3.3V
# port is the slot's serial port from /api/devices — e.g. 4001 for SLOT1
```

**This is permanent and one-way.** Do it only after you've confirmed the board is
a 3.3 V-flash part (essentially all WROOM devkits are). Alternative that changes
nothing permanently: add `-c "reset_config none"` to OpenOCD so it doesn't toggle
signals during connection — see §4.6.7.

#### 4.6.6 Channel B — the probe's second serial port, and why you'll ignore it

The ESP-Prog's channel B is a full UART (`/dev/ttyUSB1`) with a 6-pin PROG header
(TX/RX/GND). It's genuinely useful — a serial console that survives even when the
DUT's USB port is busy or absent.

**But the portal does not expose it.** The probe's port is classified as a
*probe-only slot*, and probe-only slots are excluded from the DUT list — so
channel B never appears as a SLOT and never gets an RFC2217 port. To use it you'd
have to reach `/dev/ttyUSB1` on the Pi directly over SSH, which is exactly what
the project's own rules tell you not to do for operations.

So: use the probe for JTAG, use the board's USB for serial. One job each.

#### 4.6.7 Manual OpenOCD (only when you're debugging the bench itself)

The portal runs this for you; here it is for reference or for a bench you're
building by hand:

```bash
openocd-esp32 -s /usr/local/share/openocd-esp32/scripts \
  -f interface/ftdi/esp_ftdi.cfg \
  -f target/esp32.cfg \
  -c "gdb port 3333" -c "telnet port 4444" -c "bindto 0.0.0.0"
```

Add `-c "reset_config none"` on classic ESP32 boards if the strapping pin is
fighting you. Run it as root, or as `pi` with the udev rule the installer already
wrote (`ATTRS{idVendor}=="0403", MODE="0666"`). If it fails with a libftdi error,
the probe's shared libraries are missing:

```bash
sudo apt-get install -y libftdi1-2 libudev1
```

### 4.7 Stage 6 — the free RF carrier (no parts needed)

Si5351/PE4302 are skipped, so the siggen falls back to **GPCLK** — a BCM hardware
clock on **GPIO5** (pin 29) or **GPIO6** (pin 31), **122 kHz–250 MHz**, integer
dividers only, zero hardware.

```bash
curl http://$BENCH:8080/api/siggen/status
curl -X POST http://$BENCH:8080/api/siggen/start \
  -H 'Content-Type: application/json' -d '{"freq_hz":3500000,"backend":"gpclk"}'
```

`GET /api/siggen/frequencies` matters with GPCLK — integer dividers can't hit
arbitrary targets. Expect **one skipped test** (`TestSiggen`).

---

## 5. Software

### 5.1 Flash the OS

**Raspberry Pi Imager** → **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**.

Lite — no desktop needed. 64-bit — `openocd-esp32` is fetched as `arm64`.

**Tested baselines:** Debian 12 *bookworm* (Python 3.11, esptool 4.x) and Debian
13 *trixie* (Python 3.13, esptool 5.x). The installer pins nothing and handles
both — it even unblocks Bluetooth, which trixie soft-blocks via `rfkill` on a
fresh image (leaving `hci0` DOWN and every `/api/ble/*` call failing).

> Prefer **bookworm** if you get a choice — it matches what CI tests against
> (Python 3.11). Trixie works too, but note Python 3.13 removed `telnetlib`,
> `cgi`, `imp`, `distutils`, and **esptool 5 renamed things**: `esptool.py` →
> `esptool`, `flash_id` → `flash-id`, and output fields changed (`Chip is` →
> `Chip type:`). The portal uses the old spellings for compatibility, so accept
> both wordings in anything that parses esptool output.

Imager settings (gear icon):

| Setting | Value | Why |
|---------|-------|-----|
| Hostname | `testbench` | The installer overwrites it to `testbench-XXXX` from the MAC. |
| Enable SSH | **yes**, public-key auth | For install and code deployment. |
| Username | **`pi`** | Every doc and skill uses `pi@`. |
| **Wireless LAN** | **leave empty** | `wlan0` becomes the test AP. |
| Locale / timezone | your region | |

### 5.2 First boot

```bash
ssh pi@<pi-ip>
cat /proc/device-tree/model      # Raspberry Pi 4 Model B Rev 1.x
ip -br addr                      # eth0 UP with a LAN lease
iw dev                           # wlan0 present
free -h                          # ~1.8 GB usable
vcgencmd measure_temp
```

Won't power on at all, and it's a **Rev 1.1**? Try the official supply before
anything else — an e-marked USB-C cable is a known cause.

### 5.3 Memory hardening — optional at 2 GB

The manual says outright: **"On a Pi 3/4/5 with 1 GB or more you can skip."** At
2 GB there's no OOM cycle. Two cheap items are still worth doing headless:

```bash
echo "gpu_mem=16" | sudo tee -a /boot/firmware/config.txt

sudo mkdir -p /etc/systemd/journald.conf.d
cat <<'EOF' | sudo tee /etc/systemd/journald.conf.d/size.conf
[Journal]
SystemMaxUse=16M
EOF
sudo systemctl restart systemd-journald
```

Reboot, then confirm `vcgencmd get_mem gpu` → `gpu=16M` and
`vcgencmd get_throttled` → `0x0`. **Do not add a swapfile** — unnecessary at
2 GB, and swap on SD is what actually wears the card.

### 5.4 Install

```bash
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/SensorsIot/Embedded-AI-Harness.git
cd Embedded-AI-Harness/pi
sudo bash install.sh
```

What it does (idempotent, under `set -e`): apt packages (hostapd, dnsmasq,
mosquitto, bluez, rtl-sdr/rtl-433, pyserial, libgpiod) → pip (esptool ≥ 5,
bleak, smbus2) + I²C enable + Bluetooth unblock → `openocd-esp32` from GitHub
releases into `/usr/local/bin/` (alongside Debian's `openocd`) → stand down
`hostapd`/`dnsmasq`/`mosquitto`/`wpa_supplicant` and mark `wlan0` unmanaged →
directories → 17 Python modules into `/usr/local/bin/` → config defaults →
systemd + udev rules (including `60-openocd.rules`, which gives `0403:*` FTDI
devices mode `0666`) → rename host to `testbench-<mac4>` → enable and start.

> **Read the last line, not the middle.** `set -e` plus the copy order means one
> missing file aborts the install *before* the service exists, ending on a bare
> `cp: cannot stat` with no summary. `curl /api/info` is the only proof.

### 5.5 Verify

```bash
curl -s http://localhost:8080/api/info      | jq
curl -s http://localhost:8080/api/devices   | jq
curl -s http://localhost:8080/api/debug/probes | jq
```

Then prove each subsystem imported — a bad import takes down only its own
endpoint and leaves the portal cheerfully answering:

```bash
for ep in sdr/status siggen/status mqtt/status wifi/mode debug/probes gpio/status; do
  echo "--- $ep"; curl -s "http://localhost:8080/api/$ep"; echo
done
```

Open **`http://<bench-ip>:8080`** — live dashboard of every slot, WiFi state,
activity log, test progress and the operator-interaction modal.

### 5.6 Slot config — optional

Auto-detection is correct on a Pi 4, so you only need `testbench.json` for the
**probe** (§4.6.3), custom labels or fixed ports. If you want the rest:

```bash
sudo rfc2217-learn-slots        # prints a config for your actual topology
```

Ports default to `4000+i` / `3332+i` / `4443+i` — **SLOT1 → 4001/3333/4444**.
Matching is **prefix-based**, so `"1-1"` catches every port on that hub.

---

## 6. The bench's own test-partner firmware

`test-firmware/` is an ESP32 image the bench uses to test *itself*: it joins the
test AP, hosts one of its own, answers HTTP, publishes MQTT, advertises BLE as
`WB-Test`, and answers a serial console (`ping`, `status`, `scan`, `info`,
`mark`, `wifi`, `testap`, `forget`, `reboot`). Not a DUT; not your firmware.

**You don't need to build it.** CI builds it (`.github/workflows/test-firmware.yml`,
targets **`esp32c3` and `esp32s3`**, ESP-IDF `v6.0.2`) and releases attach the
images as assets.

> ⚠️ **Note the targets: C3 and S3 only.** There is **no classic-ESP32 build** of
> the test partner. Your WROOM boards can be DUTs and debug targets, but they
> cannot be the bench's *partner* — so keep one S3 or C6 permanently available.

**A. Flash a release asset** (no ESP-IDF anywhere):

```bash
curl -X POST http://$BENCH:8080/api/firmware/upload \
  -F project=test-firmware -F file=@wb-test-firmware.bin

esptool --port 'rfc2217://$BENCH:4001?ign_set_control' \
        --chip esp32s3 --baud 460800 write_flash @flash_args
```

**B. Build it yourself** — ESP-IDF **6.x** on a laptop:

```bash
cd test-firmware
idf.py set-target esp32s3     # or esp32c3
idf.py build                  # → build/wb-test-firmware.bin
```

Use `flash_args` — it carries the authoritative offsets.

---

## 7. Commissioning checklist

| # | Check | Command | Pass |
|---|-------|---------|------|
| 1 | Portal alive | `curl -s $BENCH:8080/api/info` | JSON with `ok: true` |
| 2 | Slots detected | `curl -s $BENCH:8080/api/devices` | one entry per DUT jack, **none for the probe** |
| 3 | Subsystems loaded | loop from §5.5 | every endpoint answers |
| 4 | **Probe registered** | `curl -s .../api/debug/probes` | `PROBE1`, `in_use: false` |
| 5 | Board seen | plug a board in | appears in the right slot within seconds |
| 6 | Serial over network | `esptool --port rfc2217://$BENCH:4001 flash-id` | chip identified |
| 7 | Boot visible | `POST /api/serial/reset` `{"slot":"SLOT1"}` | boot banner in `/api/serial/output` |
| 8 | **Native USB-JTAG** | `lsusb -d 303a:1001`, then `/api/devices` | `debugging: true`, port 3333+ |
| 9 | **Probe JTAG on the WROOM** | `POST /api/debug/start` `{"slot":"SLOT3","chip":"esp32","probe":"PROBE1"}` | `ok: true`, `gdb_target` returned |
| 10 | GDB attaches over probe | `gdb -ex 'target remote $BENCH:3333'` | halts; `reset halt` works |
| 11 | **Serial survives debug** | monitor SLOT3 while GDB is attached | output still flows |
| 12 | Probe releases cleanly | `POST /api/debug/stop`, then `/api/debug/probes` | `in_use: false`, `/dev/ttyUSB0` back |
| 13 | WiFi AP | `POST /api/wifi/ap_start` `{"ssid":"TestAP","password":"password123"}` | a phone sees `TestAP` |
| 14 | BLE up | `POST /api/ble/scan` `{"timeout":5}` | devices listed (else §9 rfkill) |
| 15 | MQTT | `POST /api/mqtt/start` | `status` running |
| 16 | GPIO reset | pin 18 LOW, reset, release with `"z"` | download mode, then boots |
| 17 | Thermals | `vcgencmd measure_temp` under load | < 80 °C, `get_throttled` = `0x0` |
| 18 | **Acceptance run** | `pytest pytest/ --wt-url http://$BENCH:8080` | ≈ **47 passed, 42 skipped** empty |
| 19 | Full suite | `pytest pytest/ --wt-url http://$BENCH:8080 --run-dut` | green, minus RF |

`pytest pytest/host/` needs no hardware and runs in under a second.

**Expected skips:** `TestSiggen` (no Si5351) and `WT-1909` (no dongle).

---

## 8. Wiring summary (pin it to the wall)

**Pi header**

| Thing | Pin | BCM |
|-------|-----|-----|
| DUT EN / RST | 11 | **17** |
| DUT BOOT (GPIO0/GPIO9) | 12 | **18** |
| Ground | 6, 9, 14, 20, 25, 30, 34, 39 | GND |
| Fan power / ground | 4 / 6 | — |
| GPCLK RF out (free) | 29 *(or 31)* | GPIO5 *(or 6)* |

**ESP-Prog 10-pin header → classic ESP32**

| Pin | Signal | DUT |
|:---:|---|---|
| 1 | VDD 3.3 V | **leave disconnected if DUT is USB-powered** |
| 2 | TMS | GPIO14 |
| 3, 5, 7, 9 | GND | GND (at least one) |
| 4 | TCK | GPIO13 |
| 6 | TDO | GPIO15 |
| 8 | TDI | GPIO12 *(strapping pin — §4.6.5)* |
| 10 | NC | — |

**Ports**

| Service | Port |
|---------|------|
| HTTP portal / REST API / firmware | **8080** TCP |
| RFC2217 serial, per slot | **4001 + index** |
| GDB, per slot (native USB-JTAG) | **3333 + index** |
| GDB, probe session | **3333** (fixed) |
| OpenOCD telnet | **4444 + index**; probe telnet **4444** |
| Read-only serial fan-out | **tcp_port + 1000** |
| UDP debug log receiver | **5555** UDP |
| MQTT broker (on demand) | **1883** TCP |
| Untrusted HTTPS mirror (on demand) | **8443** TCP |
| Test AP subnet | **192.168.4.1/24** |
| Discovery probe | **5888** UDP |

---

## 9. Gotchas that will actually bite

| Symptom | Cause | Fix |
|---------|-------|-----|
| Device not detected, **but the board's LED is lit** | **Charge-only cable** — VBUS present, D+/D− absent, so the Pi logs *no USB event at all* and nothing looks wrong | Prove the port with a USB stick first, then swap the cable; `lsusb` |
| Board works in one port, not another | Fussy on the USB 3.0 (blue) controller | Move to a black **USB 2.0** port |
| Probe doesn't work in one port | Same, and FTDI prefers USB 2.0 | Move the probe to black |
| **`JTAG scan chain interrogation failed: all ones`** | **JTAG wires not connected** — usually TDI or TMS swapped | Re-check against §4.6.1; confirm **GND** is connected |
| **OpenOCD opens the wrong thing / `LIBUSB_ERROR_IO`** | `bus_port` missing, so channel A was never unbound from `ftdi_sio` | Set `bus_port` in `testbench.json` (§4.6.3) |
| `ftdi_sio` blocks OpenOCD (manual runs) | Channel A claimed by the kernel | `echo '<bus>-<port>:1.0' > /sys/bus/usb/drivers/ftdi_sio/unbind` |
| **WROOM won't boot after first probe connection** | GPIO12 (TDI) strapping → 1.8 V flash | `espefuse.py set_flash_voltage 3.3V`, or `-c "reset_config none"` (§4.6.5) |
| `probe 'PROBE1' already in use by SLOT3` | One probe = one session | `POST /api/debug/stop` first |
| `probe 'PROBE1' not found` | `debug_probes` missing, or bad `label` key, or portal not restarted | Check `/api/debug/probes`; `systemctl restart rfc2217-portal` |
| `/dev/ttyUSB0` missing after a crashed session | Channel A left unbound | Replug the probe, or write `<bus>-<port>:1.0` to `/sys/bus/usb/drivers/ftdi_sio/bind` |
| `/api/flash` refused | Debug session active | `POST /api/debug/stop` first |
| **`Wrong boot mode (0x13)` on a WROOM** | Bridge-chip DTR/RTS can't be driven through RFC2217 | **`POST /api/flash`** (local-Pi esptool, §9.1) or wire GPIO17/18 |
| Board shows **two** `/dev/ttyACM*` (or ACM+USB) nodes in one jack | The board has an **on-board USB hub** — common on S3 "Pico"-style boards, which expose native USB-JTAG *and* a bridge-chip UART | Expected: the portal groups both under one slot (`devnodes` lists both) and proxies only the primary, native node |
| Pi won't power on / reboots under load | Weak PSU, or Rev 1.1 + e-marked USB-C cable | Official 5.1 V/3 A supply; `vcgencmd get_throttled` |
| Throttling / USB flakiness | Pi 4 thermal throttle at 80 °C | Fan case; `vcgencmd measure_temp` |
| GDB port missing in `/api/devices` | Auto-detect still running | Wait 10–15 s after hotplug |
| `hostapd` says AP-ENABLED, nothing radiates | NetworkManager restarted `wpa_supplicant` over D-Bus | Confirm the `unmanaged-devices` stanza exists |
| BLE scan finds nothing | rfkill-blocked on a fresh image | `sudo rfkill unblock bluetooth && sudo hciconfig hci0 up` |
| **`ap_start` fails: `hostapd … Failed to set beacon parameters` / `Could not connect to kernel driver`** | NetworkManager ships `WirelessEnabled=false` in its own state file and **re-blocks `wlan0` at every boot** — a bare `rfkill unblock wlan` does not survive a reboot | `sudo nmcli radio wifi on` (rewrites `/var/lib/NetworkManager/NetworkManager.state`); then `rfkill list wlan` shows `Soft blocked: no`, and it stays that way across reboots |
| `python3 -m pytest` → `No module named pytest.__main__` | The repo's **`pytest/` directory shadows the pytest package** | Run from outside the repo: `cd /tmp && python3 -m pytest /path/to/repo/pytest/testbench_test.py --wt-url …` |
| `sudo` stalls on "unable to resolve host" | Hostname has a `_` | Hyphen only: `testbench-XXXX` |
| Port 5000 connection refused | Wrong port | The portal is **8080** |
| Port busy | RFC2217 allows **one writing client** | Close the other; `+1000` for read-only watchers |

### 9.1 Flashing your WROOM boards

Native-USB chips (S3/C3/C6/H2) strap into the bootloader internally and flash
fine over RFC2217. Classic ESP32 boards behind a bridge chip often don't — the
portal stops the slot's proxy, runs esptool **on the Pi** where DTR/RTS works
natively, then restarts the proxy:

```bash
curl -X POST http://$BENCH:8080/api/flash \
  -F slot=SLOT3 -F chip=esp32 -F baud=921600 \
  -F 'bin@0x1000=@.pio/build/<env>/bootloader.bin' \
  -F 'bin@0x8000=@.pio/build/<env>/partitions.bin' \
  -F 'bin@0xe000=@boot_app0.bin' \
  -F 'bin@0x10000=@.pio/build/<env>/firmware.bin'
```

Note the part naming: **`bin@` followed by the hex offset**. A part named with a
bare offset is stored but never flashed. Classic ESP32/Arduino layout is
`0x1000` bootloader, `0x8000` partitions, `0xe000` boot_app0, `0x10000` app; on
C3/S3/C6/H2 the bootloader is at `0x0` and there's no `boot_app0`. No
`/api/serial/reset` is needed afterwards. Also available: `POST /api/flash/read`
to pull flash back off a slot.

### 9.2 Diagnostics

**On the Pi:**

```bash
sudo systemctl status rfc2217-portal
sudo journalctl -u rfc2217-portal -f | grep -i -E 'debug|probe|jtag|unbind'
lsusb; lsusb -d 0403:6010; lsusb -d 303a:1001
ls -la /dev/ttyACM* /dev/ttyUSB*
ss -tlnp | grep -E '8080|400|3333|4444'
free -h; vcgencmd measure_temp; vcgencmd get_throttled
```

**From your laptop:**

```bash
ping $BENCH
curl -s http://$BENCH:8080/api/devices      | jq
curl -s http://$BENCH:8080/api/debug/probes | jq
curl -s http://$BENCH:8080/api/log
```

---

## 10. Living with it

| Task | Do this |
|------|---------|
| Daily operation | **HTTP API only.** SSH is for deploying code, nothing else. |
| Update scripts, no system changes | `cd pi && sudo bash install.sh --update` |
| Deploy one changed module | `scp pi/portal.py pi@$BENCH:/tmp/ && ssh pi@$BENCH 'sudo cp /tmp/portal.py /usr/local/bin/rfc2217-portal && sudo systemctl restart rfc2217-portal'` |
| Change probe wiring or port | edit the `debug_probes` block, restart the portal (§4.6.3) |
| Pin slots / rename labels | `sudo rfc2217-learn-slots`, edit `testbench.json`, restart |
| Change a `pi/config/` default | it won't apply — copy explicitly or delete the deployed file first (**except** `rtl_433.conf`, always overwritten) |
| Drive it from Claude | copy `.claude/skills/` into your project; optionally `claude mcp add testbench --env TESTBENCH_URL=http://$BENCH:8080 -- python3 /abs/path/mcp/testbench_mcp.py` (70 tools) |
| Shut down | `sudo shutdown -h now` — **no overlayroot, no power-loss protection** |

**Honest limits:** one *writing* serial client per board; **one probe, one JTAG
session**; probe-only slots aren't DUT slots; no authentication anywhere.

---

## 11. Build order, condensed

1. **Buy**: official **5.1 V/3 A USB-C** PSU, 32 GB microSD, USB-A→USB-C data
   cables, ESP32-S3 + ESP32-C6, **jumper wires + 330 Ω resistors**, fan case,
   USB-A→micro-USB cable for the probe.
2. **Flash** Raspberry Pi OS Lite (64-bit); SSH on; user `pi`; **no WiFi**.
3. **Boot** over Ethernet. Optional light hardening (§5.3). Reboot.
4. **Install** the repo + `sudo bash install.sh`.
5. **Verify** `/api/info`, `/api/devices`, the subsystem loop, then `:8080`.
6. **Plug in** S3 + C6 on black USB 2.0 ports → confirm 4 slots and
   `debugging: true` on both (native USB-JTAG, no probe needed).
7. **Add the ESP-Prog**: find `bus_port` (§4.6.2), write `testbench.json`
   (§4.6.3), restart, confirm `GET /api/debug/probes`.
8. **Wire the probe** to a WROOM board — **TCK 13, TDO 15, TMS 14, TDI 12, GND** —
   then `POST /api/debug/start` with `"chip":"esp32"`, attach GDB on 3333, and
   confirm serial still flows.
9. **Wire GPIO17 → EN, GPIO18 → BOOT** for deterministic flashing of the
   bridge-chip boards.
10. **Acceptance run**: `pytest pytest/ --wt-url http://$BENCH:8080` —
    ≈ 47 passed / 42 skipped.
11. **Optional**: flash the test-partner firmware (§6) — **S3 or C3 only, not
    your WROOM boards** — for the full suite.
