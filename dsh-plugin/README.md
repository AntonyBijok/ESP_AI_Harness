# ESP32 AICLP — DeepSeek Harness plugin

AI Closed-Loop Programming for ESP32 on real hardware, ported from
[SensorsIoT/Embedded-AI-Harness](https://github.com/SensorsIot/Embedded-AI-Harness)
to the DeepSeek Harness.

The agent writes firmware, flashes it onto a real board through a Raspberry Pi
testbench, measures it against a specification, and corrects itself until the tests
derived from that specification run clean.

**Read [`docs/User-Manual.md`](docs/User-Manual.md).** If you know the Claude Code
original, start at
[§12 Differences from the Claude Code version](docs/User-Manual.md#12-differences-from-the-claude-code-version).

## Install

```bash
./install.sh          # → ${DSH_HOME:-$HOME/.dsh}/.agent-presets/esp-aiclp/
node tools/selftest.mjs
```

Then select **ESP32 AICLP** for a session. No `npm install`, no MCP registration, no
environment variables — the plugin imports nothing outside Node builtins, so the
directory is the install.

## What is here

| Path | Contents |
|---|---|
| `agent.cordis.yml` | The composition: persona, tools, delegated harness features, the bench plugin, the skills root |
| `preset.yml` | The name and description the preset picker shows |
| `plugin/` | 25 bench tools generated from `manifest.json`, plus the loop's prompt section |
| `skills/` | 16 skills: the four AICLP phases and the instrument skills |
| `docs/User-Manual.md` | The manual — install, the loop, the tool surface, traps, customising, and the Claude comparison |
| `docs/Test-Plan.md` | Step-by-step bench validation: wiring, phases T0–T10, pass criteria, rollback |
| `tools/selftest.mjs` | Mounts the plugin against a fake context and probes the live bench |
| `install.sh` | Copies this directory into the preset root |

## The tool surface in one paragraph

68 of the bench's 72 endpoints are callable. 23 curated `tb_*` tools cover the 36 on
the hot path — grouped by the job, not by the URL — and each one closes a documented
trap in its shape rather than in a warning: `tb_serial_exec` writes then reads so a
fast reply cannot beat the monitor; `tb_flash` always emits `bin@0x…` so the
`bin@8000`-is-decimal bug is unreachable; `tb_wifi_ap` takes `password` and sends
`pass` so the access point is never silently open. `tb_endpoints` is the directory and
`tb_call` is the dispatcher for the other 32. The bench's four-value `availability`
vocabulary is enforced: `unavailable` hardware and the two `never_call` udev callbacks
are refused by name.

## Verifying

```bash
node tools/selftest.mjs            # mount contract + read-only probes
node tools/selftest.mjs --mutate   # adds bench reset and a serial round trip
```

`--mutate` calls `POST /api/bench/reset`, which is destructive to any other client
using the bench. That is why it is not the default.

## Licence and provenance

The skills are derived from MIT-licensed upstream work (Copyright (c) 2026 Sensors
IoT) — see `NOTICE.md` and the manual's
[§13](docs/User-Manual.md#13-attribution-and-licence). The plugin, composition and
manual are original work. Not affiliated with or endorsed by Sensors IoT.
