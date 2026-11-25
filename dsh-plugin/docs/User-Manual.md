# ESP32 AICLP — User Manual

A development setup for ESP32 microcontrollers that runs **AI Closed-Loop
Programming** on the DeepSeek Harness: the agent writes firmware, flashes it onto
real silicon, measures it against a specification, and corrects itself until the
tests derived from that specification run clean.

It is a port of [SensorsIoT/Embedded-AI-Harness](https://github.com/SensorsIot/Embedded-AI-Harness)
(Andreas Spiess' "The Harness") from Claude Code to this harness. The method, the
testbench and the API contract are the same. What changed is how the agent reaches
the hardware, and what the harness gives the method that Claude Code could not.
**[§12](#12-differences-from-the-claude-code-version) is the section to read if you
know the original.**

---

## Contents

1. [What this is](#1-what-this-is)
2. [What you need](#2-what-you-need)
3. [Installing](#3-installing)
4. [The first five minutes](#4-the-first-five-minutes)
5. [Pointing at a different bench](#5-pointing-at-a-different-bench)
6. [The tool surface](#6-the-tool-surface)
7. [The loop: four phases and four gates](#7-the-loop-four-phases-and-four-gates)
8. [Harness features the method uses](#8-harness-features-the-method-uses)
9. [Operating the bench: traps and how they are closed](#9-operating-the-bench-traps-and-how-they-are-closed)
10. [Customising](#10-customising)
11. [Troubleshooting](#11-troubleshooting)
12. [Differences from the Claude Code version](#12-differences-from-the-claude-code-version)
13. [Attribution and licence](#13-attribution-and-licence)

> **Testing this against your own bench?** [`Test-Plan.md`](Test-Plan.md) is the
> step-by-step validation: what to plug into which port, a phase per subsystem, and
> what each result must say before you trust the plugin on its own.

---

## 1. What this is

Three things ship together, and they are one directory:

| Part | What it is | Where |
|---|---|---|
| **Preset** | A composition — the agent's identity, tools, and which harness features it gets | `agent.cordis.yml`, `preset.yml` |
| **Plugin** | 25 bench tools generated from the bench's own API manifest, plus the loop's prompt section | `plugin/` |
| **Skills** | 16 procedures: the four AICLP phases and the instrument skills | `skills/` |

The bench is a Raspberry Pi holding ESP32 boards. It exposes everything over one
HTTP API — flashing, serial, Wi-Fi, BLE, MQTT, GPIO, JTAG — and the plugin turns
that API into tools the agent can call. Nothing else is required: no MCP server to
register, no separate process, no environment variables.

**The loop.** The specification is the setpoint, the firmware on the chip is the
plant, the tests are the sensor, failing tests are the error signal, and the agent is
the controller. It exits at zero. That is the whole idea, and everything below
serves it.

---

## 2. What you need

**A commissioned testbench.** The plugin speaks the API documented in
`TESTBENCH-PLUGIN-API.md` and enumerated in `testbench-api-manifest.json`, both in
the parent directory. This preset was built and verified against a Pi 4B at
`http://192.168.0.29:8080` with an ESP32-S3 in SLOT4 and its CH343 bridge in SLOT6.

**Node.js 22+** — not for you, for the harness. The plugin uses `fetch`, `FormData`
and `AbortSignal.any`, all native there.

**Optionally**, for building firmware yourself:

| Tool | Use |
|---|---|
| ESP-IDF (`idf.py`) | the ESP-IDF lifecycle skill |
| PlatformIO (`pio`) | the PlatformIO skill |
| `esptool` on `PATH` | the shipped pytest suite shells out to it |

The bench flashes firmware the agent already built. It does not compile for you —
compilation happens in your workspace or in CI.

**Network reach** to the bench's port 8080. The bench API has **no authentication**
(§1 of the contract), so the network *is* the security boundary. Keep the bench on a
network you trust, and treat access to it as access to physically reprogrammable
hardware.

---

## 3. Installing

```bash
cd dsh-plugin
./install.sh
```

That copies the whole directory to `${DSH_HOME:-$HOME/.dsh}/.agent-presets/esp-aiclp/`.
Re-running replaces it. There is nothing else to install — no `npm install`, no
package registration, no MCP configuration.

**Why there is no package step.** A locally authored preset lives under your home
directory, where Node's `node_modules` walk never reaches the harness installation,
so a plugin there cannot `import '@deepseek-ai/dsh-tools'`. Rather than plant
symlinks or write into the application tree (both of which an upgrade breaks), the
plugin imports **nothing outside Node builtins**. The tool registry's real
requirement is small — `{ name, parameters, output: { schema, render } }` — and
`plugin/tool.js` meets it directly. The benefit is that this directory is portable:
copy it into any deployment, select the preset, done.

**Verify the install:**

```bash
node tools/selftest.mjs            # structure + read-only probes against the bench
node tools/selftest.mjs --mutate   # adds bench reset and a serial round trip
```

`--mutate` is off by default because it calls `POST /api/bench/reset`, which stops
debug sessions and releases grants belonging to **any** client.

**Select the preset.** In the harness, choose **ESP32 AICLP** for a session. The
roster rescans preset roots on every call, so a newly installed preset appears
without restarting; a session already running keeps its composition until you start
a new one.

---

## 4. The first five minutes

Start a session on the preset and say what you are working on. The agent opens with
`tb_status`, which is the only place slot ports, chips and capabilities come from:

```
bench http://192.168.0.29:8080  up 12448s  fw 1.0.0-pi
host 192.168.0.29 (testbench-5c62)  7 slots configured, 2 running

slots (numerically sorted; ports are read, never computed):
  SLOT1   absent                                   serial :4001  gdb :3333  fanout :-
  SLOT4   idle          flashable + JTAG           esp32s3  gpio unmeasured  serial :4004  gdb :3336  fanout :5004
  SLOT6   idle          flashable over UART only   chip unknown  gpio unmeasured  serial :4006  gdb :3338  fanout :5006
  …

flashable now: SLOT4, SLOT6
JTAG-debuggable now: SLOT4
detected_chip is null on a bridge-only slot by design — not absence.
capabilities ABSENT on this bench: external_probe_debug, sdr, rf_loopback
capabilities PARTIAL: gpio, signal_generator — see tb_endpoints for the gate
```

Three things in that output are worth internalising, because they are the bench's
shape:

- **`detected_chip: null` on SLOT6 is correct**, not a fault. A CH343 bridge has no
  JTAG TAP to interrogate, so there is nothing to report. Only a 303a native-USB part
  identifies itself over the debug bus.
- **`gpio unmeasured` means never measured, not absent.** Pins are configured; wires
  are unproven. Nothing should drive them until `serial_gpio_test` passes.
- **One board presents two slots.** The S3 gives native USB *and* a UART bridge, so
  there are more slots than boards. That is why a label identifies a socket, never a
  device.

Then a typical first exchange, once a board is present:

```
tb_slot_acquire slot=SLOT4 mode=flashing ttl=300   → lease token (advisory)
tb_chip_info    slot=SLOT4                          → MAC — proves which board this is
tb_flash        slot=SLOT4 build_dir=build          → flashes, hard-resets into it
tb_serial_reset slot=SLOT4                          → boot log, which is the real verdict
tb_slot_release token=…
```

---

## 5. Pointing at a different bench

The address is one line in the composition:

```yaml
- id: esp-aiclp
  name: ./plugin/index.js
  config:
    baseUrl: http://192.168.0.29:8080
    owner: dsh-esp-aiclp
    floorTimeoutMs: 15000
```

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | the manifest's `bench.base_url` | The bench origin. No trailing slash needed. |
| `owner` | `dsh-esp-aiclp` | The name this session writes into a slot lease, so an operator can see who holds what in `GET /api/slot/mode`. |
| `floorTimeoutMs` | `15000` | Minimum request timeout. Per-endpoint budgets from the manifest override it upward (`bench/reset` gets 90 s, `flash` 300 s). |
| `section` | `true` | Whether to install the loop's prompt section. `false` leaves the tools without the discipline text. |
| `sectionText` | the built-in text | Replace the prompt section wholesale. |

**Never address the bench by hostname or `.local`.** A container cannot resolve
mDNS, and the contract is explicit about this. If you do not know the address,
`skills/esp-idf-handling/discover-testbench.py --url --name <hostname>` answers over
UDP 5888 and refuses to guess when two benches reply.

**After editing an installed preset:** the roster compares the composition file's
mtime and size, so an edited `agent.cordis.yml` re-mounts automatically. But
**editing `plugin/*.js` requires restarting the harness** — Node caches ES modules,
and only the composition file is stamped. Skill files are watched, so skill edits
are live.

---

## 6. The tool surface

### 6.1 Why 25 tools and not 68

The manifest describes **72 endpoints**: 63 `available`, 5 `partial`, 2 `unavailable`,
2 `never_call`. Its own introduction says to emit one tool per available endpoint,
which is what the Claude version effectively did with a 70-tool MCP server.

That advice is right for a separate MCP server and wrong for a preset. These schemas
live in the **main tool catalog**, which is re-sent with every request — 68 endpoint
schemas cost on the order of 8–15k tokens per turn, paid forever, to make every
endpoint directly callable. So the surface is split:

- **23 curated tools** covering 36 endpoints — the hot path, grouped by the job a
  person is doing rather than by the endpoint's URL.
- **`tb_endpoints`** — the directory. No arguments gives compact signatures by group;
  `id=<id>` gives that endpoint's full contract, defaults, status codes and traps.
- **`tb_call`** — the dispatcher for the remaining 32 endpoints, with arguments
  validated against the manifest before the request is sent.

This mirrors the harness's own Inspect pattern — a compact directory to navigate,
then one exact contract — so an agent that has learned to read one such provider
reads the other for free.

### 6.2 The curated tools

| Tool | Wraps | What it adds over the endpoint |
|---|---|---|
| `tb_status` | `wifi_ping`, `get_info`, `get_devices` | One call: reachability, identity, slot table with **ports read from the bench**, plus the `flashable` / `JTAG-debuggable` predicates the API never exposes, plus which capabilities this bench lacks |
| `tb_reset` | `bench_reset` | Surfaces `changed[]`; states that `ok:true` with a non-empty `errors[]` is a partial reset |
| `tb_slot_acquire` | `slot_acquire` | Treats 409 as a **value, not an exception** — returns the incumbent, mode, and expiry. Defaults `owner`; sizes `ttl` for a flash |
| `tb_slot_release` | `slot_release` | Explains an expired-token 404 as harmless |
| `tb_serial_exec` | `serial_write` + `serial_output` | **Write then read.** Removes the race where a reply beats a monitor opened afterwards; reports `matched` / `NO MATCH` with the "inconclusive, not a pass" reading, and **flags a DUT rejection** (`ERR …`, `unknown command …`) rather than counting lines and calling it a success |
| `tb_serial_write` | `serial_write` | Rejects "neither text nor hex" and "both" itself |
| `tb_serial_output` | `serial_output` | Warns that timestamps are not unique, so `since=<last ts>` drops same-batch lines |
| `tb_serial_monitor` | `serial_monitor` | A timeout is printed as **`INCONCLUSIVE`**, never as a pass; includes the lines seen while waiting |
| `tb_serial_reset` | `serial_reset` | Returns the boot capture, and says a silent capture means wrong slot or dead board |
| `tb_serial_release` | `serial_release` | Explains why download mode must be cleared |
| `tb_flash` | `flash` | **Always emits `bin@0x…`** and rejects a prefix-less string; accepts `build_dir` and reads `flash_args` itself; only sends `erase` when asked |
| `tb_chip_info` | `chip_info` | Frames the MAC as the only per-board identifier; turns a 502 into "wrong slot or charge-only cable". **Warns that esptool resets the chip** — the program stops and the cached `detected_chip` clears for ~10 s |
| `tb_wifi_ap` | `ap_start`, `ap_stop`, `ap_status` | Takes `password`, sends `pass`; **refuses to start an open AP**; lists stations so no DUT IP is guessed |
| `tb_wifi_http` | `wifi_http` | Accepts and returns plain text; base64s both directions for you |
| `tb_wifi_scan` | `wifi_scan` | An empty result is "the air was empty"; the AP-running 503 is explained as a mode condition |
| `tb_provision` | `enter_portal` + `ap_status` | Owns the order that works (the AP and STA are mutually exclusive), polls for the new station, and **refuses to guess** when two appear |
| `tb_udplog` | `udplog_get`, `udplog_clear` | Incremental polling; returns a ready-made `since=` for the next call |
| `tb_log` | `get_log` | The bench's own activity log — where asynchronous work reports progress |
| `tb_operator` | `human_interaction`, `human_status`, `human_done`, `human_cancel` | A timeout and a cancel are printed as **not a confirmation** |
| `tb_debug` | `debug_start`, `debug_stop`, `debug_status` | Prints a ready `target extended-remote` line; says not to stop a session just to flash |
| `tb_mqtt` | `mqtt_status`, `mqtt_start`, `mqtt_stop` | Frames the broker as shared infrastructure a test must not restart |
| `tb_firmware` | `firmware_list`, `firmware_upload`, `firmware_delete` | Returns the HTTP URL a DUT pulls its OTA image from |
| `tb_ota` | `ota` | Explains 504 as "the board never answered" |
| `tb_endpoints` | — | Progressive disclosure over all 68 callable endpoints |
| `tb_call` | — | The remaining 32 endpoints, with manifest validation |

### 6.3 The 32 endpoints behind `tb_call`

`slot_mode`, `slot_renew`, `proxy_start`, `proxy_stop`, `serial_recover`,
`serial_gpio_test`, `flash_read`, `wifi_mode_get`, `wifi_mode_set`, `sta_join`,
`sta_leave`, `wifi_events`, `net_portscan`, `tls_mirror_status`, `tls_mirror_start`,
`tls_mirror_stop`, `debug_probes`, `debug_group`, `gpio_status`, `gpio_set`,
`ble_status`, `ble_scan`, `ble_connect`, `ble_disconnect`, `ble_write`,
`firmware_download`, `test_progress`, `test_update`, `siggen_status`,
`siggen_frequencies`, `siggen_start`, `siggen_stop`.

They are not second-class. `tb_call` validates their arguments, classifies their
results with the same success predicates, applies their runtime gates, and refuses
`unavailable` and `never_call` by name. What they lack is a dedicated description —
which is what `tb_endpoints id=…` is for.

### 6.4 What is refused, and why

| Endpoint | Availability | Behaviour |
|---|---|---|
| `siggen_atten` | `unavailable` | Refused: no PE4302 attenuator on this bench |
| `sdr_endpoints` | `unavailable` | Refused: no RTL-SDR dongle attached |
| `hotplug` | `never_call` | Refused with an explanation: a udev callback fired **on the Pi**. Sending it fabricates an OS event |
| `wifi_lease_event` | `never_call` | Same — a dnsmasq callback |

The four-value `availability` vocabulary is the trap the contract warns about: a
generator that handles three values silently emits the two callbacks that must never
be sent. Here the filter is explicit and `never_call` is refused by name.

---

## 7. The loop: four phases and four gates

The workflow is upstream's, unchanged. Four phases; each ends at a gate **derived
from project state, never declared**; each gate is graded by a **fresh checker that
did not do the work**.

| Phase | Skill | Gate | Opens when |
|---|---|---|---|
| **P0 Definition** | `define` | Load defined | every Must/Should carries a verification contract; three documentation planes exist |
| **P1 Harness** | `harness` | AI harnessed | a fresh session can state its position and name the next act, unprompted |
| **P2 Commission** | `commission` | DUT ready | this board, its wiring and its peers are proven working **here** |
| **P3 Build** | `build` | Ready for shipment | every requirement met, journey green, reconcile empty both directions |
| ⚑ Shipment | `git tag` | Shipped | release published, journey green on the released bytes |

Two rules bind all of it:

- **No code without a clause.** Work no requirement covers enters through Definition
  or not at all.
- **A change is done when its requirement is met and the journey still runs.**

**Why the gate discipline matters more than it sounds.** The session that built
something is the worst judge of whether it landed — it reads its own intent into
half-written artefacts. So a gate is never self-graded. In the Claude version that
rule was stated and left to discipline. Here the harness has the primitives to
enforce the shape; see the next section.

**The four layers a gate can demand**, and which phase produces each:

| Layer | Lives in | Produced in |
|---|---|---|
| Verification contract | the FSD, beside the requirement | P0 |
| Test declaration | `testing/test-plan.yaml` | P1 (journey), P3 (per requirement) |
| Executable test | `tests/{host,target,bench}/` | P3, **before** the code |
| Result + commit | back in the plan entry | every run; once more at release |

A declaration without an executable is the backlog. An executable without a result
is not done. A result without a commit is not evidence.

---

## 8. Harness features the method uses

This is where the port earns its keep. The method's rules were designed for a
harness that could not express them; this one can.

### 8.1 Fresh checkers → `subagent`, `subagent_fork`, `workflow`, `ralph`

| Need | Primitive | Shape of the call |
|---|---|---|
| Grade one gate | `subagent` | Give it the gate file and the repository. **Never** a summary of what you did |
| Dry-run the next session | `subagent_fork: false` | A genuinely fresh agent, no conversation seed |
| Audit a requirement list | `workflow` | A JS fan-out: one subagent per requirement, structured findings back |
| A gate that keeps returning SHUT | `ralph` | A new child each round, workspace as memory, bounded report across rounds |

`ralph` deserves a note. Upstream's gate rule says "re-run the whole check with a
**new** checker — a checker that has seen the first round is no longer fresh." A
Ralph loop is exactly that rule given a mechanism: each round opens a child with no
prior conversation, so round *n+1* cannot inherit round *n*'s bias.

### 8.2 Long convergence → `create_goal`

P3 is a convergence objective with no single deliverable. A goal persists the
objective across rounds and is disarmed by a context fold rather than lost. Say
"continue" and it rearms.

### 8.3 The chain → `todo_write`

The build chain is per-requirement, not per-project: contract → declared test →
executable test → code → build → flash → verify → green. One requirement walks the
whole chain before the next starts. A todo list is the honest rendering of that, and
`allowParallelInProgress` is enabled because independent requirements genuinely can
run in parallel.

### 8.4 Long builds → background jobs

`idf.py build` and `pio run` are minutes long. Start one in the background and keep
reading the board; collect it when it links. A foreground build blocks the loop for
no reason.

### 8.5 Thinking before touching hardware → plan mode

Plan mode's instruction on this preset also forbids touching the plant: you may read
the bench (`tb_status`, `tb_endpoints`, `tb_serial_output`, `tb_log`) while planning,
but you may not flash, reset, acquire a slot, or drive a DUT. A plan is not a licence
to move hardware.

### 8.6 Two kinds of question

| Question | Tool | Why |
|---|---|---|
| "Which board is in SLOT4?" | `tb_status`, `tb_chip_info` | Discoverable — inspect, do not ask |
| "Press the BOOT button now" | `tb_operator` | Physical, and it is the bench's own screen |
| "Should the watchdog reset or reboot?" | `ask_user_question` | A user-owned decision, answerable in this GUI |

The preset has both channels deliberately. Upstream's `human_interaction` blocks on
the Pi's display, which is right for "swap this cable" and wrong for a design
question nobody at the bench can answer.

### 8.7 Skills

The four phase skills and the instrument skills load on demand via the `skill` tool.
The prompt section carries only what must never be out of sight — the loop, the four
gates, and which primitive discharges each — because it is in every request and the
procedure is not.

---

## 9. Operating the bench: traps and how they are closed

Contract §0 lists five things that break naive clients. Each is closed in code, not
in a warning the model may skip.

| Trap | How it bites | Closed by |
|---|---|---|
| **Never compute a port** | `4000+n` happens to hold today; a config change makes it a lie | Every port a tool prints came from `GET /api/devices`. None is computed |
| **`ok:true` is not success** | `serial_monitor` answers `ok:true, matched:false` on timeout; `human-interaction` answers `ok:true, confirmed:false`; `net_portscan` `ok:true, complete:false`; `bench/reset` `ok:true` with `errors[]` | `client.js` classifies with each endpoint's own success field from the manifest, and renders `[FAILED]` when it disagrees. `tb_serial_monitor` prints `INCONCLUSIVE`, `tb_operator` prints "not a confirmation" |
| **A label identifies a socket, not a board** | Flashing the wrong board while believing a label | `tb_chip_info` frames the MAC as the identifier; `tb_status` warns when two slots are flashable |
| **A debug session blocks leasing, not flashing** | Stopping a session before a flash *loses* the restoration the portal would have done | `tb_flash`/`tb_debug` descriptions say so; `tb_debug stop` explains what is lost |
| **`rfc2217://` is not a read** | Opening the socket asserts DTR/RTS → download mode and reset on a native-USB part | `tb_serial_write` and `tb_serial_exec` are the only write paths, and say why |

Beyond §0:

| Trap | Closed by |
|---|---|
| `bin@8000` is **decimal** 8000 (`int(offset, 0)`) — a write to the wrong address and a board that will not boot | `tb_flash` always emits `bin@0x…`; `offsetToPartName` refuses a prefix-less string with the reason |
| A misspelled `password` for `ap_start` **silently starts an open AP** and reports `ok:true` | `tb_wifi_ap` maps `password` → `pass` and refuses an empty one; `client.js` rejects unknown parameters |
| A reply can beat a monitor opened afterwards | `tb_serial_exec` writes, then reads the continuous recording |
| **MQTT delivery needs a subscriber, started first** | `tools/mqtt-subscribe.py` listens on the bench broker and exits nonzero if nothing arrives. The partner publishes only on MQTT *connect* (a burst of `seq 0..N`), so a subscriber started after the board connected sees an empty topic — identical to a broken broker |
| An unplugged board's **ring buffer keeps answering** | `tb_serial_output` checks presence *before* the buffer, so an absent socket says `ABSENT` and names the newest frozen line as history. Otherwise a removed board reads as a healthy one that has gone quiet — the counter simply never moves again |
| A DUT rejects a command by **printing**, and still answers HTTP 200 | `tb_serial_exec` flags `ERR`/`error:`/`unknown command` and says the DUT refused it. Without that flag a rejected command reads as success — one real run logged `sent "mqtt_message" → 2 new line(s)` where line one was `ERR unknown command` |
| A required `binary` parameter is a multipart part, not an argument | `validateArgs` treats `options.files` as satisfying it, so `ota` and firmware upload work; a genuinely missing file names the part it wants |
| `flash_args` never reaches you as addresses | `tb_flash build_dir` parses that file, normalises every offset with the same `0x` guard, and prints `bin@0x…  ← file` before flashing |
| `since=<last ts>` drops lines: timestamps are **not unique** | `newLines()` removes overlap by text, not by stamp |
| Provisioning before raising the AP fights itself (AP and STA are mutually exclusive) | `tb_provision` owns the order and polls `ap_status` for a new station |
| Two new stations appear and nothing binds either to the DUT | `tb_provision` **refuses to guess** and names both, with how to correlate (UDP log source, chip MAC) |
| An empty Wi-Fi scan is read as a failure | `tb_wifi_scan` says the air was empty |
| A GPIO pin left driven blocks the next boot | `tb_call` refuses `gpio_set` on a slot whose wiring was never measured, and names `serial_gpio_test` |
| A `partial` capability is used as if complete | `tb_call` gates `gpio_set` and `siggen_*`, and quotes the bench's own gate |
| A wedged slot ("port is busy" forever) is retried | Both the timeout message and `tb_slot_acquire`'s out-of-band branch name `bench reset` as the cure |
| An **absent** socket reads like a silent DUT — "buffer empty" invites you to blame the firmware | Every serial read checks presence and says `ABSENT — no board is plugged into that socket`, naming the live slots |
| `serial_release` on an absent slot **pulses the Pi's GPIO17/18 anyway** and answers `ok:true`, so it can reset a board wired to a different socket | `tb_serial_release` refuses on an absent slot before calling the portal; `tb_status` shows presence rather than the portal's `state` |
| A devkit with two USB ports presents **two slots**, and they carry different traffic — the bridge port sees the mask ROM's log, the native port sees the application console | The tools say which; `tb_serial_exec` on a bridge slot that answers nothing is reported as inconclusive *and* flags "a bridge slot may be the wrong port" |
| `bench/reset` is destructive to other clients — there is no run lock | Its description says so, and `tools/selftest.mjs` keeps it behind `--mutate` |

---

## 10. Customising

### 10.1 Changing the agent

Edit `agent.cordis.yml`. The rows are `standard`'s plus two:

- `esp-aiclp` — this plugin, with `baseUrl`
- `skill-filesystem` — pointed at `skills/` inside the preset, via `baseUrl`

Everything else is a shipped row you can disable, retune or remove. Rows that
publish a service sit inside a `cordis:group` with an `isolate` realm — required,
because a service published into the root realm is process-global and a second
session collides with it. Presets must never own the sandbox, approval, persistence
or model-route rows; those are host-plane.

**Use the `cordis` preset to edit this one.** That is what it exists for.

### 10.2 Adding a tool

Add it to `plugin/tools/core.js` following an existing entry, then reinstall and
restart (plugin JS is cached). Every definition needs `name`, `description`,
`parameters`, and — via `TEXT_OUTPUT` — `output`.

Reach for a curated tool only when it *composes* something. A one-to-one wrapper of
an endpoint belongs behind `tb_call`.

### 10.3 When the bench changes

Re-run the commissioning capture to produce a new `testbench-api-manifest.json`, drop
it in as `plugin/manifest.json`, reinstall. Nothing else needs touching: every path,
parameter name, timeout, success predicate and gate is read from the manifest at load
time. `tools/selftest.mjs` will tell you if the new manifest breaks an assumption.

### 10.4 Removing it

Delete `${DSH_HOME}/.agent-presets/esp-aiclp/`. Nothing else was installed.

---

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The preset is not in the picker | Not installed where the roster looks. `./install.sh`; check `${DSH_HOME:-$HOME/.dsh}/.agent-presets/esp-aiclp/agent.cordis.yml` exists |
| Preset listed but mounting fails | Read the error: `PresetMountError` names the row. Usually a specifier that does not resolve, or two rows publishing the same service outside an `isolate` realm |
| `ERR_MODULE_NOT_FOUND` mentioning `@deepseek-ai/...` | Something added a harness import to `plugin/`. Use Node builtins only — see §3 |
| Tools vanish after a restart | Expected for a **dynamic** Cordis plugin, not this one. If this preset's tools vanish, the row failed to load; check the harness log |
| `tb_status` says the bench is unreachable | Wrong `baseUrl`, the Pi is down, or you are on the wrong network. `curl http://<ip>:8080/api/wifi/ping`. Never use a hostname |
| Every tool returns 502 on a slot | No board in that socket, or a charge-only cable. `tb_status` distinguishes absent from present-but-silent |
| "port is busy" forever after a client died | A wedged proxy. `tb_reset`. This is the documented cure, not a workaround |
| `tb_serial_monitor` keeps returning no match | Inconclusive by design. Check the command, the baud, and whether that slot is the DUT console at all — a bridge slot may be the wrong port |
| `tb_call` rejects a parameter you expected to work | The portal does not read it. The tool names the declared parameters — this is the `password`/`pass` class of bug being caught |
| An edited composition has no effect | You edited the workspace copy, not the installed one. Reinstall, or edit the installed file (which re-mounts on mtime) |
| An edited `plugin/*.js` has no effect | ES modules are cached; only the composition file is stamped. Restart the harness |
| Skills not updating | They are watched; a skill edit lands live. If it does not, check the frontmatter has `name` and `description` and the name matches its directory |

---

## 12. Differences from the Claude Code version

Read this section if you know the original. The method and the bench are the same;
four things changed materially, and the rest follows from them.

### 12.1 At a glance

| Axis | Claude Code version | This version |
|---|---|---|
| **How the bench is reached** | `mcp/testbench_mcp.py` — a 70-tool stdio MCP server, registered with `claude mcp add` | 25 tools registered directly in the harness's own tool registry, generated from the manifest. No MCP, no second process, no registration |
| **Tool schema source** | Hand-written `SPECS` table in the MCP server | `testbench-api-manifest.json`, reconciled against `portal.py` and live calls |
| **Schema fidelity** | Drifted (§12.3 of the contract): `wifi_ap_start` takes `password` but the portal reads `pass`, so the AP starts **open**; `enter_portal` takes dead args; `siggen_start` needs `wpm` nested; `serial_output` default is 50 not 40; `debug_start` slot is optional | Generated from the reconciled manifest. Unknown parameters are **rejected**, so the drift class cannot recur |
| **Success semantics** | MCP flattens HTTP status; `ok:true` is the only signal a client reliably sees | Per-endpoint predicates (`matched`, `confirmed`, `complete`, `errors[]`), and a `[FAILED]` banner when they disagree |
| **Trust boundary** | Claude Code permissions | Harness sandbox + approval policy for files and commands. The bench API itself still has **no auth** in either version |
| **Model** | Claude | DeepSeek |
| **Where config lives** | `.claude/skills/` (project) or `~/.claude/skills/` (global), plus MCP registration, plus `CLAUDE.md` | One directory: `${DSH_HOME}/.agent-presets/esp-aiclp/`. Composition, plugin and skills together |
| **Always-on context** | `CLAUDE.md` | `persona` row + a ~1-page prompt section. The procedure stays in skills, loaded on demand |
| **Instruction file** | `CLAUDE.md` | `AGENTS.md` preferred; **`CLAUDE.md` is still read** as a fallback |
| **Phase commands** | `/define`, `/harness`, `/commission`, `/build` as Claude Code slash commands | The same names as harness skills, user-invocable — `/define` resolves to the `define` skill |
| **Portability** | Two installs (skills + MCP server) | `cp -r` one directory |

### 12.2 The consequential difference: the method now has primitives

Upstream's gate discipline was a rule enforced by good behaviour:

> *"Run the check in a fresh checker, not in this session — the session that built
> the harness is the worst judge of whether it landed. Spawn it with `testing/gates/`
> and the repo, nothing else — never memory, transcripts, or a summary."*

Claude Code has no mechanism that makes "a fresh checker with no memory of this
session" a thing you can actually invoke. You could ask; nothing enforced the shape.

Here, four primitives map onto that rule directly:

| Upstream rule | Harness primitive | Why it is now enforceable |
|---|---|---|
| "a fresh checker that did not author the work" | `subagent` | A child agent with its own context. Give it the gate file and the repository |
| "a checker that has seen the first round is no longer fresh" | `ralph` | Each round is a new child with no prior conversation — the rule given a mechanism |
| "spawn it with the gate and the repo, nothing else" | `subagent_fork: false` | No conversation seed at all, as opposed to a fork that inherits |
| "re-run the **whole** check, not only the part that failed" | `workflow` | Declarative: every requirement's check runs, so a partial re-run is not even expressible |

Three more, less central but real:

- **The convergence is a persisted objective.** "Ready for shipment" is a
  convergence condition with no single deliverable. `create_goal` keeps it across
  rounds and context folds; upstream had only the session.
- **Builds do not block the loop.** `idf.py build` in a background job, board work
  continues. Upstream ran builds in the foreground.
- **Planning cannot touch the plant.** Plan mode here explicitly forbids flashing,
  resetting, leasing or driving a DUT while planning — reading the bench is allowed.
  That is a real hazard in a hardware loop and it did not exist upstream.

### 12.3 What deliberately did **not** change

- **The method.** Four phases, four gates, derived never declared, fresh checkers,
  no code without a clause, a change is done when the requirement is met and the
  journey still runs. The skills are upstream's text, minimally adapted.
- **The bench and its contract.** The API, its traps, and the `availability`
  vocabulary are unchanged. This plugin's whole job is to obey the contract, not to
  improve on it.
- **The manifest's authority.** Where upstream documentation and `portal.py` disagree,
  the code wins and the manifest records it. That reconciliation is the most valuable
  artefact in the source repo and it is used here as-is.
- **The skills as documentation.** The instrument skills still contain `curl`
  commands. They are kept because the exact field names and `ok` semantics are the
  skill's subject — they are now labelled as the wire protocol underneath the tools,
  to be read as the contract and reached for when a tool misbehaves. Every skill got
  a "Step 0" replacement explaining the tools and how to read the `curl` blocks.

### 12.4 Deliberate omissions, and why

| Omitted | Reason | What to do instead |
|---|---|---|
| `sdr-receiver`, `signal-generator` skills (2 of 18) | This bench has `sdr: unavailable` and `signal_generator: partial` (gpclk only — no Si5351, no PE4302). Skills documenting hardware you do not own generate confident wrong plans | `tb_endpoints id=siggen_status` explains the gate; `tb_call` refuses `siggen_atten` |
| 68 first-class tools | 8–15k tokens per request, forever, to make every endpoint directly callable | 23 curated + `tb_endpoints` + `tb_call` (§6.1) |
| The MCP server | Its schemas are drifted and it flattens status codes — the plugin is generated from the same reality more faithfully | Keep `mcp/testbench_mcp.py` if you also drive the bench from Claude Desktop; it does not conflict |
| A GUI panel for slot/gate status | Not requested; the Web GUI already renders tool cards | Could be added as a client half; the plugin is host-only today |

### 12.5 Caveats worth knowing

- **The prompt section is a summary, not the method.** If an agent skips a skill, it
  will follow the loop's shape without the procedure's detail. The phase skills are
  the authority; the section is what survives being forgotten.
- **`tb_call` is a weaker surface than a curated tool** — it relies on the model
  having read `tb_endpoints id=…` first. The `description` says so, but a model in a
  hurry will not. When you notice an endpoint being used wrong repeatedly, promote it
  to a curated tool: that is exactly how `tb_serial_exec` came to exist.
- **One bench, one tenant.** With no authentication there is no run lock. Two clients
  on the bench destroy each other's state, in either version, and `bench reset` is
  destructive to everyone.
- **The bench is real hardware.** `erase: true` wipes NVS and calibration data.
  `gpio_set` without releasing leaves a pin driven and can block the next boot. The
  tools warn; none of them can save a board.
- **This is a port, not a fork.** Upstream `docs/`, `pi/` and the pytest suite are
  unchanged and still the authority for the bench itself.

---

## 13. Attribution and licence

The method, the testbench design and the skills are the work of **Andreas Spiess** /
SensorsIoT, MIT licensed:

> MIT License — Copyright (c) 2026 Sensors IoT.
> Full text: `claude_git_repo/Embedded-AI-Harness-main/LICENSE`.

The 16 skills in `skills/` are **derived from** `.claude/skills/` in that repository:
bytes copied, then adapted for this harness (Step 0 replaced with tool guidance,
`.claude/skills/` → `skills/`, `CLAUDE.md` → `AGENTS.md`, and a harness note added to
each phase skill). Their content is upstream's; the adaptations are noted at each
site. All upstream files remain under their original MIT licence and copyright.

The operating contract (`TESTBENCH-PLUGIN-API.md`) and the machine-readable manifest
(`testbench-api-manifest.json`) are original work from commissioning this bench, and
are the source of truth the plugin is generated from.

This preset, its plugin and this manual are original work. It is not affiliated with
or endorsed by Sensors IoT.
