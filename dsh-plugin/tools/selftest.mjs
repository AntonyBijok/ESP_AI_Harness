#!/usr/bin/env node
/**
 * Self-test: mount the preset's plugin the way the preset loader does, then drive it.
 *
 * This exists because the plugin has no test suite of its own and its most important
 * behaviour is not local — whether the classifications match what the bench actually
 * answers. The fake context below is the minimum surface `tools.register`,
 * `systemPrompt.section`, `ctx.effect` and `ctx.get` need, so a green run here means
 * the row will mount, and the live calls mean its verdicts are true.
 *
 * Usage:
 *   node tools/selftest.mjs                    # structure + read-only probes
 *   node tools/selftest.mjs --bench http://…   # point at another bench
 *   node tools/selftest.mjs --mutate           # also run a reset + serial round trip
 *
 * `--mutate` calls `POST /api/bench/reset`, which is destructive to any other client
 * using the bench. It is off by default for that reason.
 *
 * @module esp-aiclp/selftest
 */
import { apply } from '../plugin/index.js'
import { loadManifest } from '../plugin/manifest.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}

const bench = value('bench', undefined)
const mutate = flag('mutate')

/** Collect registrations from a throwaway context. */
function fakeContext () {
  const tools = new Map()
  const sections = []
  const effects = []
  const logs = []
  return {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    effect: (factory) => { effects.push(factory()) },
    get: () => undefined,
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(`warn: ${message}`) },
    _tools: tools,
    _sections: sections,
    _effects: effects,
    _logs: logs,
  }
}

const ctx = fakeContext()
apply(ctx, bench === undefined ? {} : { baseUrl: bench })

let failures = 0
const pass = (label, detail = '') => console.log(`  PASS  ${label}${detail === '' ? '' : `  ${detail}`}`)
const fail = (label, detail = '') => { failures++; console.log(`  FAIL  ${label}${detail === '' ? '' : `  ${detail}`}`) }
const check = (condition, label, detail) => condition ? pass(label, detail) : fail(label, detail)

console.log('── mount ───────────────────────────────────────────────')
check(ctx._tools.size > 0, `registered ${ctx._tools.size} tools`)
check(ctx._sections.length === 1, `registered ${ctx._sections.length} prompt section`, ctx._sections[0]?.name)
check(ctx._effects.length === 1, `${ctx._effects.length} effect(s) held for disposal`)

const names = [...ctx._tools.keys()].sort()
console.log(`  tools: ${names.join(' ')}`)

// Every definition must satisfy the registry's real contract.
for (const [name, definition] of ctx._tools) {
  check(typeof definition.description === 'string' && definition.description.length > 40, `${name}: has a real description`)
  check(definition.output !== undefined && typeof definition.output.render === 'function', `${name}: output.render present`)
  check(definition.output?.schema?.type === 'string', `${name}: output schema is a string`)
}

const manifest = loadManifest()
const neverCall = new Set(manifest.neverCall)
const leaked = names.filter((name) => neverCall.has(name))
check(leaked.length === 0, 'no tool wraps a never_call endpoint', leaked.join(','))

const run = async (name, args = {}) => {
  const definition = ctx._tools.get(name)
  if (definition === undefined) throw new Error(`no such tool ${name}`)
  return definition.execute(args, { signal: undefined })
}

console.log('\n── live probes (read-only) ─────────────────────────────')
const status = await run('tb_status')
check(/bench http/.test(status), 'tb_status reaches the bench')
check(/flashable now:/.test(status), 'tb_status reports flashable slots')
console.log(status.split('\n').map((line) => `        ${line}`).join('\n').slice(0, 1_400))

const directory = await run('tb_endpoints')
check(/callable endpoint/.test(directory), 'tb_endpoints returns a directory')
check(/never_call/.test(directory), 'tb_endpoints lists the refused endpoints')

const refuse = await run('tb_call', { endpoint: 'hotplug' })
check(/NOT client-callable/.test(refuse), 'tb_call refuses hotplug')
const unavailable = await run('tb_endpoints', { id: 'sdr_endpoints' })
check(/UNAVAILABLE/.test(unavailable), 'tb_endpoints explains an unavailable capability')

const contract = await run('tb_endpoints', { id: 'serial_monitor' })
check(/matched/.test(contract) && /SUCCESS RULE/.test(contract), 'tb_endpoints gives a full contract with the success rule')

const badParam = await run('tb_call', { endpoint: 'ap_start', params: { ssid: 'x', password: 'y' } })
check(/unknown parameter/.test(badParam), 'tb_call rejects the password/pass drift')
check(/pass/.test(badParam), 'tb_call names the real field')

const unknown = await run('tb_call', { endpoint: 'no_such_endpoint' })
check(/unknown endpoint id/.test(unknown), 'tb_call rejects an unknown id')

// `gpio_set` names a pin, not a slot; an earlier version of the gate looked up
// `params.slot`, which is never supplied, so it never fired. Assert the refusal text
// rather than the absence of a crash — a gate that returns null passes silently.
// The gate has exactly one correct state per bench state: refuse while nothing is
// measured wired, allow once something is. Asserting "must refuse" hard-coded the
// unwired bench and failed the moment a board was actually wired — the assertion, not
// the gate, was the thing that was wrong.
const wiredSlots = /gpio wired \(measured\)/.test(status)
const gated = await run('tb_call', { endpoint: 'gpio_set', params: { pin: 16, value: 1 } })
if (wiredSlots) {
  check(!/gated/i.test(gated), 'tb_call ALLOWS gpio_set now that a slot is measured wired')
  await run('tb_call', { endpoint: 'gpio_set', params: { pin: 16, value: 'z' } })
} else {
  check(/gated/.test(gated) && /serial_gpio_test/.test(gated), 'tb_call gates gpio_set on unmeasured wiring')
  check(!/SLOT1\b/.test(gated) || /present/.test(gated), 'the gpio gate names present slots only')
}

// An absent socket must not read like a quiet device. SLOT1 is configured but empty on
// this bench; if it ever becomes present, pick any other absent label instead.
const emptySlot = (await run('tb_status')).split('\n')
  .map((line) => /^\s+(SLOT\d+)\s+absent/.exec(line)?.[1])
  .find((label) => label !== undefined)
if (emptySlot === undefined) {
  console.log('  SKIP  absent-slot checks — every configured slot is present')
} else {
  const absentRead = await run('tb_serial_output', { slot: emptySlot, lines: 5 })
  check(/ABSENT/.test(absentRead), `${emptySlot}: an empty read says ABSENT, not "buffer empty"`)
  const absentRelease = await run('tb_serial_release', { slot: emptySlot })
  check(/ABSENT/.test(absentRelease), `${emptySlot}: serial_release does not claim to have cleared download mode`)
}

if (mutate) {
  console.log('\n── live probes (MUTATING — bench reset is destructive) ─')
  const reset = await run('tb_reset')
  check(/bench reset/.test(reset) || /FAILED/.test(reset), 'tb_reset answers')
  console.log(reset.split('\n').slice(0, 6).map((line) => `        ${line}`).join('\n'))

  const after = await run('tb_status')
  // Read the slot from tb_status's own verdict, not from the slot table: the table
  // lists all seven sockets and the first is usually empty.
  const flashable = /flashable now: ([^\n]+)/.exec(after)?.[1]
    ?.split(',').map((label) => label.trim()).filter((label) => /^SLOT\d+$/.test(label)) ?? []
  const slot = flashable[0]
  if (slot === undefined) {
    console.log('  SKIP  serial round trip — no slot reported')
  } else {
    const info = await run('tb_chip_info', { slot })
    console.log(info.split('\n').map((line) => `        ${line}`).join('\n'))
    const exec = await run('tb_serial_exec', { slot, command: 'ping', expect: 'pong', timeout: 5 })
    check(/NO MATCH|MATCHED/.test(exec), `tb_serial_exec returned a verdict for ${slot}`)
    console.log(exec.split('\n').slice(0, 4).map((line) => `        ${line}`).join('\n'))
    const monitor = await run('tb_serial_monitor', { slot, pattern: 'definitely-not-there', timeout: 2 })
    check(/INCONCLUSIVE/.test(monitor), 'a timed-out monitor is reported inconclusive, not as a pass')
  }
}

// ── offline regressions ──────────────────────────────────────────────────────
// Each of these was a real defect that a live run found and a green selftest missed.
console.log('\n── offline regressions ─────────────────────────────────')

// A required `binary` parameter arrives through the file parts, not the args. Checking
// only args made `ota` and `firmware_upload` impossible to call at all.
{
  const { validateArgs } = await import('../plugin/manifest.js')
  const ota = manifest.byId.get('ota')
  const without = validateArgs(ota, { target: '1.2.3.4' }, { providedFiles: new Set() })
  check(without.missing.length > 0 && /firmware/.test(without.missing.join(' ')),
    'a required file part is reported missing when no file is supplied')
  check(/file part/.test(without.missing.join(' ')),
    'the missing-file message says how to supply it')
  const with_ = validateArgs(ota, { target: '1.2.3.4' }, { providedFiles: new Set(['firmware']) })
  check(with_.missing.length === 0, 'a required file part satisfied by files is not reported missing')
}

// `detected_chip` is cleared by a bench reset. JTAG capability is a USB fact, so the
// label must not flip to "UART only" during the few seconds before it repopulates.
{
  const { deriveSlot } = await import('../plugin/tools/shared.js')
  const base = { present: true, devnode: '/dev/ttyACM0', state: 'idle', is_probe: false, usb_warning: null }
  const native = { ...base, usb_devices: [{ vid_pid: '303a:1001' }] }
  check(deriveSlot({ ...native, detected_chip: null }).jtagDebuggable === true,
    'native USB-JTAG stays JTAG-debuggable while the chip is unprobed')
  check(/not probed yet/.test(deriveSlot({ ...native, detected_chip: null }).why),
    'the unprobed case says so instead of claiming UART-only')
  check(deriveSlot({ ...native, usb_devices: [{ vid_pid: '1a86:55d3' }], detected_chip: null }).jtagDebuggable === false,
    'a bridge-only slot is not JTAG-debuggable')
}

// A DUT that rejects a command prints ERR and still answers HTTP 200. The tool used to
// report "N new lines" and nothing else. Asserted on the detector itself, because the
// tool's own execute is wrapped by defineTool and its source is not reachable.
{
  const { findDutRejection } = await import('../plugin/tools/shared.js')
  const rejected = [
    "ERR unknown command 'mqtt_message' — try ping|status|scan|info|mark|wifi|testap|forget|reboot",
    'ERR wifi needs an ssid',
    'error: invalid argument',
  ]
  for (const line of rejected) {
    check(findDutRejection([{ text: line }]) !== undefined, `a rejection is detected: "${line.slice(0, 34)}…"`)
  }
  const benign = [
    ['OK pong', 'OK'],
    ['OK status wifi=1 ap_mode=0', 'OK status'],
    ['I (280) heap_init: At 3FCE9710 len 00005724 (21 KiB): RAM', 'an ESP-IDF info log'],
    ['E (1234) wifi: esp_wifi_get_config failed', 'an ESP-IDF error log (a diagnostic, not a rejection)'],
  ]
  for (const [line, label] of benign) {
    check(findDutRejection([{ text: line }]) === undefined, `${label} is not mistaken for a rejection`)
  }
}

// The wiring state must be visible in all four cases. Hiding `true` made a correctly
// measured slot render with no gpio column at all — identical to a slot with no GPIO
// lines, and the worst case to be silent about, since it is the state you wired for.
{
  const { slotLine } = await import('../plugin/tools/shared.js')
  const base = {
    label: 'SLOTX', present: true, state: 'idle', devnode: '/dev/ttyX', is_probe: false,
    usb_warning: null, tcp_port: 4001, gdb_port: 3333, monitor_port: 5001,
    usb_devices: [{ vid_pid: '303a:1001' }], detected_chip: 'esp32s3', has_gpio: true,
  }
  check(/gpio wired \(measured\)/.test(slotLine({ ...base, gpio_wired: true })), 'a measured-good wiring is shown, not omitted')
  check(/gpio unwired/.test(slotLine({ ...base, gpio_wired: false })), 'a measured-bad wiring is shown')
  check(/gpio unmeasured/.test(slotLine({ ...base, gpio_wired: null })), 'an unmeasured wiring says unmeasured')
  check(/gpio unmeasured/.test(slotLine({ ...base })), 'a MISSING gpio_wired is unmeasured, never "unwired"')
  check(/no gpio lines/.test(slotLine({ ...base, has_gpio: false })), 'a slot without GPIO lines says so')
}

// The tool's own enum should reject a bad value without a round trip to the portal.
{
  let threw = null
  try {
    await run('tb_slot_acquire', { slot: 'SLOT4', mode: 'debug' })
  } catch (error) {
    threw = error.message
  }
  check(threw !== null && /must be one of/.test(threw), 'an out-of-enum argument is rejected locally', threw ?? '(accepted)')
}

console.log('\n────────────────────────────────────────────────────────')
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
