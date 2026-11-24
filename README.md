# ESP AI Harness — Testbench Build Guide

A practical build, wiring and commissioning guide for the
[Embedded AI Harness](https://github.com/SensorsIot/Embedded-AI-Harness) testbench,
written from a real build rather than from the manual.

The bench is a Raspberry Pi 4 that puts four ESP32 boards under test: it exposes each
board's serial port over RFC2217, serves a control/report portal over HTTP, runs a
Wi-Fi access point for DUTs to join, and coordinates BLE, MQTT, GPIO, signal
generation and hardware debugging from one place.

## What's here

| Path | Contents |
|---|---|
| `TESTBENCH-BUILD-GUIDE.md` | The guide: parts list, assembly, Pi setup, OS/flashing, USB slot model, ESP-Prog/JTAG wiring, commissioning checklist, and the gotchas that actually bite |
| `claude_git_repo/Embedded-AI-Harness-main/` | Reference copy of the upstream project as inspected during the build, including a patched `pi/install.sh` |
| `.gitignore` | Excludes the local virtualenv and Python caches |

## Hardware this was written against

- Raspberry Pi 4 Model B, 2 GB, 64-bit Raspberry Pi OS Lite (Debian 13 trixie)
- ESP-Prog (FT2232H) for hardware JTAG on classic ESP32 boards
- Classic ESP32-WROOM dev boards (CP2102 bridge)
- ESP32-S3 / C3 / C6 dev boards with native USB-JTAG
- Deliberately **no** RF instrumentation (no RTL-SDR, no Si5351/PE4302), so the
  SDR and signal-generator sections describe what is skipped and why

## Notes on the patched installer

`claude_git_repo/Embedded-AI-Harness-main/pi/install.sh` carries one local fix on top
of upstream: it unblocks the Wi-Fi radio during install (`nmcli radio wifi on`, plus
`rfkill unblock wlan`) alongside upstream's Bluetooth unblock. Without it, a fresh
Debian 13 image leaves `wlan0` soft-blocked — and because NetworkManager re-blocks it
from its own state file on every boot, `hostapd` fails with
`Failed to set beacon parameters` and the test AP never radiates. Upstream's
Bluetooth-only unblock does not cover this case.

## Running the acceptance suite

The suite is HTTP-only against the bench's portal, but three details are easy
to get wrong:

```bash
# 1. Toolchain in a venv. esptool is required even though the tests are
#    "HTTP-only": the flash tests shell out to `python3 -m esptool` over the
#    bench's RFC2217 proxy, and they resolve `python3` from PATH.
python3 -m venv .venv
.venv/bin/pip install pytest requests pyserial paho-mqtt esptool

# 2. Fetch the partner firmware (no local ESP-IDF needed — CI publishes it).
./fetch-test-partner.sh esp32s3

# 3. Run from OUTSIDE the repo root: the repository's own pytest/ directory
#    shadows the pytest package, so `python3 -m pytest` from the root fails
#    with "No module named pytest.__main__".
REPO="$PWD"
TESTS="$REPO/claude_git_repo/Embedded-AI-Harness-main/pytest/testbench_test.py"
cd /tmp
PATH="$REPO/.venv/bin:$PATH" \
WT_TEST_PARTNER_IMAGE="$REPO/.fw/test-partner-esp32s3" \
  python -m pytest "$TESTS" --wt-url http://<bench-ip>:8080 --run-dut
```

`--run-dut` enables the tests that need a partner board; without it they skip.
`WT_TEST_PARTNER_IMAGE` matters because `WT-1800` flashes a throwaway image over
the partner to prove flashing works — without a bundle to restore from, the next
run starts against a board that answers nothing.

Expected result on a bench with an ESP32-S3 partner, no SDR and no Si5351:
**97 passed, 7 skipped** — the skips are all absent-hardware preconditions.

## Provenance and licence

The guide and the installer patch in this repository are original work.

`claude_git_repo/Embedded-AI-Harness-main/` is a **vendored reference copy** of
[SensorsIot/Embedded-AI-Harness](https://github.com/SensorsIot/Embedded-AI-Harness),
included so the guide's line references and the patch remain reviewable.

> MIT License — Copyright (c) 2026 Sensors IoT.
> The full text is retained at
> `claude_git_repo/Embedded-AI-Harness-main/LICENSE`.

All upstream files remain under their original MIT licence and copyright. This
repository is not affiliated with or endorsed by Sensors IoT.
