/**
 * Shared shaping for every tool in this plugin.
 *
 * Two rules live here, and both exist because a model reads text, not objects:
 *
 * 1. **Every tool returns one formatted string.** The harness validates the return
 *    value against the declared output schema, so a string schema plus a `render`
 *    that emits it is the whole contract — and it means the description of a result
 *    is written once, in the place that knows what the result means.
 * 2. **A failed operation is printed as a failure.** `ok: true` is not success
 *    (§9 of the contract), so `renderOutcome` prints the shortfall prominently
 *    instead of burying it in a JSON blob the model may skim past.
 *
 * @module esp-aiclp/tools/shared
 */

/** Output declaration every tool in this plugin uses: one rendered text block. */
export const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/** JSON with stable key order, for embedding in a result. */
export function json (value) {
  return JSON.stringify(value, null, 2)
}

/** A compact one-line JSON rendering, for tables and log lines. */
export function jsonLine (value) {
  return JSON.stringify(value)
}

/** Truncate a string to a readable budget, marking the cut. */
export function clip (text, limit = 4_000) {
  const raw = typeof text === 'string' ? text : json(text)
  if (raw.length <= limit) return raw
  return `${raw.slice(0, limit)}\n… (${raw.length - limit} more characters truncated)`
}

/**
 * Render a classified outcome from `client.execute`.
 *
 * The `[FAILED]` banner is deliberate. The contract's most expensive trap is a
 * client that treats `ok:true` as success; a caller reading this text cannot make
 * that mistake without ignoring an explicit word.
 * @param {object} outcome - a value returned by `client.execute`.
 * @param {object} [options] - rendering options.
 * @param {string} [options.heading] - a line to print above the payload.
 * @param {boolean} [options.includeMeta] - print endpoint/status/timing.
 * @returns {string}
 */
export function renderOutcome (outcome, options = {}) {
  const lines = []
  if (options.heading !== undefined) lines.push(options.heading)
  lines.push(
    outcome.success
      ? `${outcome.endpoint}  ok`
      : `[FAILED] ${outcome.endpoint}  ${outcome.shortfall ?? 'the operation did not take effect'}`,
  )
  if (outcome.prerequisite !== null && outcome.prerequisite !== undefined) {
    lines.push(`capability note: ${outcome.prerequisite}`)
  }
  if (options.includeMeta !== false) {
    lines.push(`HTTP ${outcome.http_status}  ${outcome.duration_ms} ms  ${outcome.method} ${outcome.path}`)
  }
  if (outcome.data !== undefined) lines.push(clip(outcome.data))
  return lines.join('\n')
}

/**
 * Format a value as a result body with an optional heading.
 * @param {string} heading - first line.
 * @param {unknown} payload - JSON-able payload.
 * @returns {string}
 */
export function report (heading, payload) {
  return `${heading}\n${clip(payload)}`
}

/**
 * Numeric sort key for a slot label.
 *
 * `/api/devices` sorts lexicographically, so `SLOT10` precedes `SLOT2`. Sorting is
 * the client's job (§2.1) and this is where it happens.
 * @param {string} label - slot label such as `SLOT4` or `AUTO-3`.
 * @returns {number}
 */
export function slotOrder (label) {
  const match = /(\d+)\s*$/.exec(String(label))
  return match === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(match[1], 10)
}

/**
 * The two predicates §2.3 defines, evaluated for one slot.
 *
 * Neither is exposed by the API; applying them is the client's job, and getting them
 * wrong in either direction is expensive — too strict and a flashable bridge slot
 * looks unusable, too loose and a flash is attempted on a HID device.
 * @param {object} slot - one entry from `slots[]`.
 * @returns {{ flashable: boolean, jtagDebuggable: boolean, why: string }}
 */
export function deriveSlot (slot) {
  const busyStates = new Set(['absent', 'flapping', 'recovering', 'resetting', 'flashing'])
  const reasons = []
  if (slot.present !== true) reasons.push('not present')
  if (slot.devnode === null || slot.devnode === undefined) reasons.push('no devnode')
  if (slot.is_probe === true) reasons.push('JTAG probe only')
  if (slot.usb_warning !== null && slot.usb_warning !== undefined) reasons.push(slot.usb_warning)
  if (busyStates.has(slot.state)) reasons.push(`state ${slot.state}`)
  const flashable = reasons.length === 0
  const hasNativeJtag = Array.isArray(slot.usb_devices) &&
    slot.usb_devices.some((device) => typeof device?.vid_pid === 'string' && device.vid_pid.startsWith('303a:'))
  // JTAG capability is a property of the USB device that enumerated, NOT of chip
  // auto-detection. `detected_chip` is cleared by a bench reset and repopulates a few
  // seconds later, so using it as a precondition made a live native-USB board read as
  // "flashable over UART only" for that window — the opposite of the truth, and exactly
  // when an operator is looking at status to decide what to do.
  const jtagDebuggable = flashable && hasNativeJtag
  const chipKnown = slot.detected_chip !== null && slot.detected_chip !== undefined
  return {
    flashable,
    jtagDebuggable,
    why: flashable
      ? jtagDebuggable
        ? chipKnown ? 'flashable + JTAG' : 'flashable + JTAG (chip not probed yet)'
        : 'flashable over UART only'
      : reasons.join('; '),
  }
}

/**
 * A one-line summary of a slot, for the status table.
 *
 * Absent slots print their presence and nothing else: the diagnostics that matter
 * (`detected_chip`, GPIO wiring, group) are meaningless for a socket with no board in
 * it, and repeating them per empty slot buries the two rows a reader actually needs.
 *
 * `present` is the authority, not `state`. The portal will report an empty socket as
 * `state: "idle"` — `serial/release` on an absent slot sets it, without complaint — so
 * trusting `state` makes an empty socket read as a healthy one.
 * @param {object} slot - one entry from `slots[]`.
 * @returns {string}
 */
export function slotLine (slot) {
  const derived = deriveSlot(slot)
  const ports = `serial :${slot.tcp_port}  gdb :${slot.gdb_port}  fanout :${slot.monitor_port ?? '-'}`
  if (slot.present !== true) {
    const state = slot.state === 'absent' ? 'absent' : `absent  (portal reports state "${slot.state}")`
    return `  ${String(slot.label).padEnd(7)} ${state.padEnd(13)} ${''.padEnd(26)} ${ports}`
  }
  const notes = [slot.detected_chip ?? 'chip unknown']
  if (slot.debugging === true) notes.push('DEBUGGING')
  // Print the wiring state in ALL three cases. Hiding the `true` case meant the one
  // state an operator looks for after wiring a board — "this slot is measured good" —
  // rendered as an absent column, indistinguishable from a slot with no GPIO lines at
  // all. And `undefined` fell through to "unwired", asserting a negative nobody measured.
  if (slot.has_gpio === false) {
    notes.push('no gpio lines')
  } else if (slot.gpio_wired === true) {
    notes.push('gpio wired (measured)')
  } else if (slot.gpio_wired === false) {
    notes.push('gpio unwired')
  } else {
    notes.push('gpio unmeasured')
  }
  if (slot.usb_warning !== null && slot.usb_warning !== undefined) notes.push(slot.usb_warning)
  return `  ${String(slot.label).padEnd(7)} ${String(slot.state).padEnd(13)} ${derived.why.padEnd(26)} ${notes.join('  ')}  ${ports}`
}

/**
 * Refuse a bare decimal-looking offset.
 *
 * `int(offset, 0)` on the Pi makes `bin@8000` decimal 8000, i.e. 0x1F40 — a
 * hash-verified write to the wrong address and a board that will not boot. This
 * plugin always *emits* a `0x` prefix, so the only way to reach the trap is to pass
 * a bare number here; rejecting it with the reason turns a silent brick into a message.
 * @param {string|number} offset - caller-supplied offset.
 * @returns {string} the offset formatted as `0x…`.
 */
export function offsetToPartName (offset) {
  if (typeof offset === 'number') {
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`flash: offset ${offset} is not a non-negative integer`)
    return `0x${offset.toString(16)}`
  }
  const raw = String(offset).trim()
  if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return `0x${raw.slice(2).toLowerCase()}`
  if (/^0[oO][0-7]+$/.test(raw) || /^0[bB][01]+$/.test(raw)) return raw.toLowerCase()
  throw new Error(
    `flash: offset "${raw}" has no radix prefix. The portal parses part offsets with int(offset, 0), so ` +
    '"8000" means DECIMAL 8000 (0x1F40), not 0x8000 — the board would not boot. ' +
    'Pass a number, or a string with a 0x prefix.',
  )
}

/**
 * The console line showing that the DUT *refused* a command, if there is one.
 *
 * A firmware console rejects an unknown command by printing and still answering HTTP
 * 200, so a tool that only counts new serial lines reports a rejection as a success.
 * Seen in practice: `sent "mqtt_message" → 2 new line(s)` where line one was
 * `ERR unknown command 'mqtt_message' — try ping|status|...`.
 *
 * Deliberately narrow. It matches a reply that *is* a rejection, not a log record that
 * merely has a high severity: an ESP-IDF `E (1234) wifi: ...` line is a diagnostic the
 * DUT emitted while doing what it was told, and flagging it would teach the operator to
 * ignore this warning.
 * @param {Array<string|{ text?: string }>} lines - fresh console lines.
 * @returns {string|undefined} the offending line, trimmed.
 */
export function findDutRejection (lines) {
  const pattern = /^\s*(?:ERR\b|ERROR\b|error:|unknown command\b|unrecognised command\b|unrecognized command\b|command not found\b|usage:)/i
  for (const line of lines ?? []) {
    const text = typeof line === 'string' ? line : line?.text
    if (typeof text === 'string' && pattern.test(text)) return text.trim()
  }
  return undefined
}
