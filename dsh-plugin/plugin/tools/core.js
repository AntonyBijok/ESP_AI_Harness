/**
 * The curated tool set: the part of the bench a closed loop touches constantly.
 *
 * These are not one-tool-per-endpoint. Each one is a *composite* built around the
 * failures the operating contract documents, so the trap is removed by the shape of
 * the tool rather than by a warning in its description:
 *
 * | Trap (§ of TESTBENCH-PLUGIN-API.md) | Where it is closed |
 * |---|---|
 * | `ok:true` is not success (0.2, 9) | every tool renders `[FAILED]` when the endpoint's own field disagrees |
 * | a reply can beat a monitor you opened afterwards (5.1) | `tb_serial_exec` writes *then* reads the recording |
 * | `bin@8000` is decimal 8000 (5.2) | `tb_flash` always emits `bin@0x…`, and rejects a prefix-less string |
 * | `ap_start` takes `pass`, not `password` (12.3) | `tb_wifi_ap` accepts `password` and sends `pass` |
 * | provisioning before raising the AP fights itself (8.5) | `tb_provision` owns the order and poll |
 * | a lease is advisory, and 409 is normal (4) | `tb_slot_acquire` returns the incumbent instead of throwing |
 * | ports must be read, never computed (0.1) | every port a tool reports came from `/api/devices` |
 * | an empty scan is not a failure (5.3) | `tb_wifi_scan` says so, and names the AP-running refusal |
 * | a GPIO pin left driven blocks the next boot (5.6) | `tb_call` refuses `gpio_set` on a slot whose wiring was never measured |
 *
 * The long tail — signal generator, BLE, port scan, TLS mirror, raw proxy control —
 * is reachable through `tb_call` in `dispatch.js` rather than costing a schema here.
 *
 * @module esp-aiclp/tools/core
 */
import { defineTool } from '../tool.js'
import {
  TEXT_OUTPUT,
  clip,
  deriveSlot,
  findDutRejection,
  offsetToPartName,
  renderOutcome,
  slotLine,
  slotOrder,
} from './shared.js'

/**
 * Read a DUT's serial buffer and work out which lines are new.
 *
 * The buffer's `ts` values are **not unique** — a burst of lines shares one stamp —
 * so `since=<last ts>` silently drops a reply that arrived in the same batch. The
 * overlap is therefore removed by matching text rather than by comparing stamps.
 * @param {object[]} before - lines captured before the action.
 * @param {object[]} after - lines read afterwards.
 * @returns {object[]} lines that were not present before.
 */
function newLines (before, after) {
  const beforeText = before.map((line) => line.text)
  const afterText = after.map((line) => line.text)
  let keep = 0
  const limit = Math.min(beforeText.length, afterText.length)
  for (let overlap = limit; overlap > 0; overlap--) {
    if (beforeText.slice(-overlap).join('\u0000') === afterText.slice(0, overlap).join('\u0000')) {
      keep = overlap
      break
    }
  }
  return after.slice(keep)
}

/**
 * Distinguish "this socket is empty" from "the board said nothing".
 *
 * An absent slot has no proxy, no devnode and no ring buffer, so every serial
 * operation against it is a statement about the *socket*. Reporting that as "buffer
 * empty" or "download mode cleared" reads exactly like a silent, healthy DUT — and a
 * silent DUT is the single most misleading observation in this whole loop.
 * @param {object} client - the bench client.
 * @param {string} slot - slot label the caller named.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<string|null>} an explanation when the slot is absent, else null.
 */
async function absenceNote (client, slot, signal) {
  const devices = await client.execute('get_devices', {}, { signal })
  if (!devices.success) return null
  const slots = devices.data?.slots ?? []
  const record = slots.find((candidate) => candidate.label === slot)
  if (record === undefined) return `${slot} is not a slot on this bench (it reports ${slots.length} slots).`
  if (record.present === true) return null
  const present = slots.filter((candidate) => candidate.present === true).map((candidate) => candidate.label)
  return [
    `${slot} is ABSENT — no board is plugged into that socket.`,
    `  present slots: ${present.length > 0 ? present.join(', ') : 'none'}`,
    '  An absent socket has no proxy and no live devnode, so nothing can be produced, written, reset',
    '  or released here. This is a fact about the socket, not about any device. (Its ring buffer may',
    '  still hold frozen lines from the board that was last attached — see tb_serial_output.)',
  ].join('\n')
}

/**
 * Register the curated bench tools on the context.
 * @param {object} deps - resolved dependencies.
 * @param {object} deps.ctx - Cordis context carrying the tool registry.
 * @param {object} deps.client - the bench client from `client.js`.
 * @param {object} deps.manifest - the loaded manifest.
 * @param {object} deps.config - the resolved plugin config.
 * @returns {void}
 */
export function registerCoreTools ({ ctx, client, manifest, config }) {
  const { manifest: doc } = manifest
  const capabilities = doc.capabilities ?? {}
  const benchUrl = client.baseUrl

  /** Register one tool and return the disposer list entry. */
  const add = (definition) => ctx.tools.register(defineTool({ output: TEXT_OUTPUT, ...definition }))

  // ── system ────────────────────────────────────────────────────────────────

  add({
    name: 'tb_status',
    description:
      'The bench in one call: reachability, identity, and the slot table with ports read from the bench ' +
      'itself. Start every session here. Each slot is annotated flashable / JTAG-debuggable using the ' +
      'contract\'s own predicates, so you never have to re-derive them. Reports which capabilities this ' +
      'bench does NOT have — checked before you build a plan on top of them.',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute (_args, exec) {
      const ping = await client.execute('wifi_ping', {}, { signal: exec.signal })
      if (!ping.success) return renderOutcome(ping, { heading: `bench at ${benchUrl} is not answering` })

      const devices = await client.execute('get_devices', {}, { signal: exec.signal })
      if (!devices.success) return renderOutcome(devices)

      const info = await client.execute('get_info', {}, { signal: exec.signal })
      const slots = [...(devices.data.slots ?? [])].sort((a, b) => slotOrder(a.label) - slotOrder(b.label))
      const flashable = slots.filter((slot) => deriveSlot(slot).flashable)
      const jtag = slots.filter((slot) => deriveSlot(slot).jtagDebuggable)

      const absent = Object.entries(capabilities)
        .filter(([key, value]) => value === 'unavailable' && !key.endsWith('_note'))
        .map(([key]) => key)
      const partial = Object.entries(capabilities)
        .filter(([key, value]) => value === 'partial' && !key.endsWith('_note'))
        .map(([key]) => key)

      const lines = [
        `bench ${benchUrl}  up ${ping.data.uptime}s  fw ${ping.data.fw_version}`,
        `host ${info.data?.host_ip ?? devices.data.host_ip} (${info.data?.hostname ?? devices.data.hostname})  ` +
        `${info.data?.slots_configured ?? '?'} slots configured, ${info.data?.slots_running ?? '?'} running`,
        '',
        'slots (numerically sorted; ports are read, never computed):',
        ...slots.map((slot) => slotLine(slot)),
        '',
        `flashable now: ${flashable.map((s) => s.label).join(', ') || 'NONE — check cables and /api/devices'}`,
        `JTAG-debuggable now: ${jtag.map((s) => s.label).join(', ') || 'none (needs a 303a native-USB part)'}`,
        `detected_chip is null on a bridge-only slot by design — not absence.`,
      ]
      if (absent.length > 0) lines.push(`capabilities ABSENT on this bench: ${absent.join(', ')}`)
      if (partial.length > 0) lines.push(`capabilities PARTIAL: ${partial.join(', ')} — see tb_endpoints for the gate`)
      if (flashable.length === 0) {
        lines.push('', 'No flashable slot. Do not plan firmware work until a board is present.')
      } else if (flashable.length > 1) {
        lines.push('', `More than one flashable slot: ${flashable.map((s) => s.label).join(', ')}. ` +
          'A label identifies a socket, not a board — confirm with tb_chip_info (MAC) before flashing.')
      }
      return lines.join('\n')
    },
  })

  add({
    name: 'tb_reset',
    description:
      'Return the whole bench to a defined baseline. The FIRST call of every run — a test that starts from ' +
      'what the previous one left behind is measuring history. Stops every debug session, restarts every ' +
      'proxy, releases every slot grant, stops the SoftAP and leaves any joined network. ' +
      'DESTRUCTIVE TO OTHER CLIENTS: there is no run lock, so warn the operator before using it mid-run. ' +
      'Also the documented cure for a wedged slot ("port is busy") — use it instead of retrying.',
    parameters: {},
    async execute (_args, exec) {
      const outcome = await client.execute('bench_reset', {}, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const changed = outcome.data.changed ?? []
      return [
        'bench reset: baseline restored',
        changed.length === 0 ? '  (nothing needed changing — the bench was already clean)' : changed.map((c) => `  · ${c}`).join('\n'),
        '',
        'Note: detected_chip is cleared by a reset and repopulates within ~5 s. If you are choosing a slot ' +
        'by chip, poll tb_status first; if `present` is enough, proceed now.',
      ].join('\n')
    },
  })

  // ── slots ─────────────────────────────────────────────────────────────────

  add({
    name: 'tb_slot_acquire',
    description:
      'Announce intent on a slot and get a lease token. IMPORTANT: the lease is ADVISORY — no work handler ' +
      'consults it, so it neither blocks your own flash nor protects you from another client. It is for ' +
      'cooperation and visibility (tb_slot_mode is how an operator sees what is happening). A refusal is a ' +
      'NORMAL outcome: this returns who holds the slot and since when. Never retry in a loop, and never ' +
      'pre-empt. Size ttl to the work — a flash can take 300 s, so the 60 s default can lapse mid-operation.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label, e.g. SLOT4.' },
      mode: {
        type: 'string',
        description: 'Intent label: idle | flashing | resetting | monitoring | flapping | recovering | download | debugging.',
        enum: ['idle', 'flashing', 'resetting', 'monitoring', 'flapping', 'recovering', 'download', 'debugging'],
      },
      ttl: { type: 'number', description: 'Lease seconds, 1..3600 (clamped). Size it to the work, not to the default.' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('slot_acquire', {
        slot: args.slot,
        mode: args.mode ?? 'monitoring',
        owner: config.owner,
        ttl: args.ttl ?? 300,
      }, { signal: exec.signal })

      if (outcome.http_status === 409 || outcome.data?.error === 'held') {
        const hold = outcome.data ?? {}
        return [
          `slot ${args.slot} is HELD — do not retry, report this and stop`,
          `  mode: ${hold.mode ?? '?'}  owner: ${hold.owner ?? '?'}  since: ${hold.since ?? '?'}  ` +
          `expires_in: ${hold.expires_in ?? '?'}s`,
          '',
          'A 409 here does NOT mean the bench is unusable: the lease is advisory, so a flash would still ' +
          'work. It means another client has declared intent. Coordinate out of band, or pick another slot.',
        ].join('\n')
      }
      if (outcome.data?.error === 'device held out of band') {
        return [
          `slot ${args.slot} is held OUT OF BAND by a stray process on the devnode`,
          `  pid: ${outcome.data.pid}  cmdline: ${outcome.data.cmdline}`,
          '',
          'Something on the Pi still owns the serial device. bench reset (tb_reset) is the documented cure.',
        ].join('\n')
      }
      if (!outcome.success) return renderOutcome(outcome)
      const token = outcome.data.token
      return [
        `slot ${args.slot} leased (advisory)`,
        `  token: ${token}`,
        `  mode: ${outcome.data.mode}  expires_in: ${outcome.data.expires_in}s`,
        '',
        `Keep the token: release with tb_slot_release token="${token}". An expired token answers 404 on ` +
        'release, which is harmless — a lapsed lease only makes you invisible.',
      ].join('\n')
    },
  })

  add({
    name: 'tb_slot_release',
    description: 'Return a leased slot to idle, so the next client does not see a stale claim. Pass the token from tb_slot_acquire.',
    parameters: {
      token: { type: 'string', required: true, description: 'The lease token from tb_slot_acquire.' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('slot_release', { token: args.token }, { signal: exec.signal })
      if (outcome.http_status === 404) {
        return `lease "${args.token}" is unknown or already expired — nothing to release (harmless).`
      }
      return renderOutcome(outcome, { includeMeta: false })
    },
  })

  // ── serial ────────────────────────────────────────────────────────────────

  add({
    name: 'tb_serial_exec',
    description:
      'Send one line to a DUT and return what came back. THE PRIMARY WAY TO TALK TO A BOARD: it writes, then ' +
      'reads the portal\'s continuous recording, so a reply that arrives in milliseconds cannot be missed. ' +
      '(A monitor opened after the write can miss it — that race is why this tool exists.) ' +
      'Returns the new lines and whether `expect` matched. A silent port is NOT evidence of a silent device ' +
      'until a known-good command has produced a known reply at least once.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      command: { type: 'string', required: true, description: 'The line to send. A newline is appended, because a console command without one is never executed.' },
      expect: { type: 'string', description: 'Substring to look for in the reply, case-insensitive. Name a token you can actually recognise — e.g. "OK pong". Omit if you only want the raw lines.' },
      timeout: { type: 'number', description: 'Seconds to wait for `expect` (default 8). Returns early on a match.' },
      lines: { type: 'integer', description: 'How many buffer lines to read per poll (default 60).' },
    },
    async execute (args, exec) {
      const tail = args.lines ?? 60
      const baseline = await client.execute('serial_output', { slot: args.slot, lines: tail }, { signal: exec.signal })
      if (!baseline.success) return renderOutcome(baseline)
      const before = baseline.data.lines ?? []

      const written = await client.execute('serial_write', { slot: args.slot, text: args.command }, { signal: exec.signal })
      if (!written.success) {
        const absent = await absenceNote(client, args.slot, exec.signal)
        if (absent !== null) return absent
        return renderOutcome(written, { heading: `"${args.command}" was NOT sent — the write to ${args.slot} failed` })
      }

      const deadline = Date.now() + (args.timeout ?? 8) * 1000
      const needle = args.expect?.toLowerCase()
      let fresh = []
      let matched = null
      for (;;) {
        const read = await client.execute('serial_output', { slot: args.slot, lines: tail }, { signal: exec.signal })
        if (!read.success) return renderOutcome(read)
        fresh = newLines(before, read.data.lines ?? [])
        if (needle !== undefined) matched = fresh.find((line) => line.text.toLowerCase().includes(needle)) ?? null
        if (matched !== null) break
        if (Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      const header = needle === undefined
        ? `sent "${args.command}" → ${fresh.length} new line(s)`
        : matched !== null
          ? `sent "${args.command}" → MATCHED "${matched.text}"`
          : `sent "${args.command}" → NO MATCH for "${args.expect}" in ${args.timeout ?? 8}s`
      const body = fresh.length === 0
        ? '  (nothing arrived on the serial buffer)'
        : fresh.map((line) => `  ${line.text}`).join('\n')
      // A DUT console rejects an unknown command by printing, not by failing — and a
      // tool that only counts new lines reports that as a success. Sessions have been
      // lost to "sent, 2 new lines arrived" where line 1 was `ERR unknown command`.
      const rejected = findDutRejection(fresh)
      const advice = [
        needle !== undefined && matched === null
          ? 'An unmatched expectation is inconclusive, not a pass: check the command, the baud, and whether ' +
            'this slot is the DUT console at all (a bridge slot may be the wrong port).'
          : '',
        rejected !== undefined
          ? `THE DUT REJECTED THIS COMMAND: "${rejected}"\n` +
            '  This tool does not model your firmware\'s command set — read the reply rather than assuming the ' +
            'command took effect.'
          : '',
      ].filter((line) => line !== '').map((line) => `\n${line}`).join('')
      return `${header}\n${body}${advice}`
    },
  })

  add({
    name: 'tb_serial_write',
    description:
      'Send bytes to a DUT without waiting for a reply. The only safe way to write — opening rfc2217:// ' +
      'directly asserts DTR/RTS and drops a native-USB board into download mode and reset. ' +
      'For request/response use tb_serial_exec instead; this is for fire-and-forget or a burst.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      text: { type: 'string', description: 'Text to send. Mutually exclusive with hex.' },
      hex: { type: 'string', description: 'Raw bytes as hex, e.g. "1b5b41". Mutually exclusive with text.' },
      newline: { type: 'boolean', description: 'Append a newline (default true).' },
    },
    async execute (args, exec) {
      if ((args.text === undefined) === (args.hex === undefined)) {
        return 'error: pass exactly one of `text` or `hex` — the portal rejects a request with neither.'
      }
      const outcome = await client.execute('serial_write', {
        slot: args.slot,
        ...args.text !== undefined ? { text: args.text } : { hex: args.hex },
        ...args.newline !== undefined ? { newline: args.newline } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      return `wrote ${outcome.data.written} byte(s) to ${args.slot}. Read the reply with tb_serial_output.`
    },
  })

  add({
    name: 'tb_serial_output',
    description:
      'Read a slot\'s serial ring buffer passively — does not disturb the board and coexists with a writer. ' +
      'The ring holds 1000 lines. `since` is EXCLUSIVE and compares floats, but timestamps are not unique ' +
      '(a burst shares one), so prefer a short `lines` tail and look for your token over `since=<last ts>`.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      lines: { type: 'integer', description: 'How many lines from the tail (default 50). No upper clamp.' },
      since: { type: 'number', description: 'Return only lines strictly newer than this epoch timestamp.' },
    },
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const outcome = await client.execute('serial_output', {
        slot: args.slot,
        ...args.lines !== undefined ? { lines: args.lines } : {},
        ...args.since !== undefined ? { since: args.since } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const entries = outcome.data.lines ?? []
      // Presence FIRST, buffer second. The ring outlives the board: after an unplug this
      // endpoint keeps returning the last lines printed, so a naive read shows a plausible,
      // frozen console (`LOOP: 283`) that is indistinguishable from a healthy board that has
      // simply gone quiet. Reporting that as current output is the worst failure available
      // here — an agent polling a removed board would watch the counter never move and
      // conclude all is well. Observed on this bench when the WROOM was unplugged mid-run.
      const absent = await absenceNote(client, args.slot, exec.signal)
      if (absent !== null) {
        const stale = entries.length === 0
          ? '  Its ring buffer is empty, so there is nothing even stale to show.'
          : `  Its ring buffer still holds ${entries.length} frozen line(s) from the board that was last
  attached, the newest being "${String(entries.at(-1).text).trim()}". They will never change: absence
  means no producer. Do not read them as the board's current output.`
        return `${absent}\n${stale}`
      }
      if (entries.length === 0) {
        return `${args.slot}: buffer empty (the slot is present, but nothing has been written to its ring yet).`
      }
      return `${args.slot}: ${entries.length} line(s)\n` +
        entries.map((line) => `  ${line.text}`).join('\n')
    },
  })

  add({
    name: 'tb_serial_monitor',
    description:
      'Block until a pattern appears in a slot\'s output, or the timeout expires. Reads the read-only fan-out, ' +
      'so it is safe alongside a writer. CRITICAL: a timeout still answers ok:true — treat matched:false as ' +
      '"no reply seen", NEVER as a pass. `pattern` is a case-SENSITIVE substring of a stripped line. ' +
      'Prefer tb_serial_exec unless you need to watch for something while other work happens.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      pattern: { type: 'string', description: 'Case-sensitive substring to wait for.' },
      timeout: { type: 'number', description: 'Seconds to wait (default 10).' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('serial_monitor', {
        slot: args.slot,
        ...args.pattern !== undefined ? { pattern: args.pattern } : {},
        ...args.timeout !== undefined ? { timeout: args.timeout } : {},
      }, { signal: exec.signal })
      const data = outcome.data ?? {}
      if (outcome.success) return `${args.slot}: MATCHED "${data.line}"`
      if (data.ok === true && data.matched === false) {
        const absent = await absenceNote(client, args.slot, exec.signal)
        if (absent !== null) return absent
        return `${args.slot}: no line matched "${args.pattern ?? '(no pattern given)'}" within ${args.timeout ?? 10}s.\n` +
          '  This is INCONCLUSIVE — a missing reply, not a passing test. The request itself was fine.\n' +
          (Array.isArray(data.output) && data.output.length > 0
            ? `  Lines seen while waiting:\n${data.output.map((l) => `    ${l}`).join('\n')}`
            : '  Nothing arrived at all.')
      }
      return renderOutcome(outcome)
    },
  })

  add({
    name: 'tb_serial_reset',
    description:
      'Reset the DUT and capture its boot output. Uses a JTAG reset when a debug session is live, else DTR/RTS. ' +
      'Not needed to make the board boot after tb_flash (the portal hard-resets), but DO use it to capture the ' +
      'boot log — a banner already in the buffer before you ask for it is worth more than a later poll.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('serial_reset', { slot: args.slot }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const output = outcome.data.output ?? []
      return `${args.slot} reset (~7 s). Boot capture:\n` +
        (output.length === 0 ? '  (no output captured — the board is silent, or this is not its console slot)' : output.map((l) => `  ${l}`).join('\n'))
    },
  })

  add({
    name: 'tb_serial_release',
    description:
      'Clear download mode: drive BOOT high-Z and pulse EN. Use after any flash that left the board in download ' +
      'mode (state `download_mode`) — otherwise the next reset boots the ROM loader, not your firmware.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
    },
    async execute (args, exec) {
      // Check first: serial_release answers ok:true for a socket with no board, and
      // claiming "download mode cleared" there is a small, confident lie.
      const absent = await absenceNote(client, args.slot, exec.signal)
      if (absent !== null) return absent
      const outcome = await client.execute('serial_release', { slot: args.slot }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      return `${args.slot}: download mode cleared (BOOT released, EN pulsed). Verify with tb_status — state should leave download_mode.`
    },
  })

  // ── flash ─────────────────────────────────────────────────────────────────

  add({
    name: 'tb_flash',
    description:
      'Flash images to a slot and hard-reset into them. Two forms, and the second is better when you have a ' +
      'real ESP-IDF build:\n' +
      '  · bins — {offset: local_path}. Offsets accept numbers (0x1000) or "0x" strings; this tool always ' +
      'writes the portal\'s `bin@0x…` part name, so the `bin@8000` = decimal-8000 trap cannot be reached. ' +
      'Offsets must come from the firmware\'s own flash_args/partition table, never guessed.\n' +
      '  · build_dir — an ESP-IDF build directory; this tool reads its flash_args and uploads every .bin it ' +
      'names, and the portal honours flash_mode/freq/size from that same file.\n' +
      'Does NOT need a debug session stopped: the portal stops it, flashes, and restores it with `reset run`. ' +
      '`erase` is off unless you ask — erasing wipes NVS and calibration data.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      bins: { type: 'json', description: 'Map of offset → local .bin path, e.g. {"0x0":"bootloader.bin","0x8000":"partition-table.bin","0x20000":"app.bin"}.' },
      build_dir: { type: 'string', description: 'Alternative to bins: an ESP-IDF build directory containing flash_args and the images it names.' },
      chip: { type: 'string', description: 'Chip type, or "auto" (default).' },
      baud: { type: 'string', description: 'Baud rate (default 921600).' },
      erase: { type: 'boolean', description: 'Erase the whole flash first. Default false — this wipes NVS and calibration data.' },
    },
    async execute (args, exec) {
      const files = {}
      const settings = {}
      let rendered = ''
      if (args.bins !== undefined && args.build_dir !== undefined) {
        return 'error: pass either `bins` or `build_dir`, not both.'
      }
      if (args.build_dir !== undefined) {
        const dir = args.build_dir.replace(/\/+$/, '')
        const argsPath = `${dir}/flash_args`
        let text
        try {
          text = await config.readText(argsPath, exec.signal)
        } catch (error) {
          return `error: cannot read ${argsPath} — is that an ESP-IDF build directory? (${error?.message ?? error})`
        }
        // Parse flash_args HERE rather than uploading it for the portal to interpret.
        // The portal would take its offsets on trust, and `int(offset, 0)` makes a bare
        // `8000` decimal 8000 — a write to 0x1F40 and a board that will not boot. Going
        // through offsetToPartName means every address is normalised to 0x… before it
        // leaves, and the operator can see exactly where each image lands.
        const parts = []
        try {
          for (const rawLine of text.split('\n')) {
            const line = rawLine.trim()
            if (line === '' || line.startsWith('#')) continue
            const tokens = line.split(/\s+/)
            if (tokens[0].startsWith('--')) {
              // ESP-IDF writes several options on ONE line
              // (`--flash-mode dio --flash-freq 80m --flash-size 4MB`), so scan the whole
              // line rather than reading tokens[1] and moving on.
              for (let i = 0; i < tokens.length; i++) {
                if (!tokens[i].startsWith('--')) continue
                const key = tokens[i].replace(/^--/, '').replace(/-/g, '_')
                if (key !== 'flash_mode' && key !== 'flash_freq' && key !== 'flash_size') continue
                const value = tokens[i + 1]
                if (value !== undefined && !value.startsWith('--')) settings[key] = value
              }
              continue
            }
            if (tokens.length < 2) continue
            parts.push({ offset: offsetToPartName(tokens[0]), file: tokens[1].replace(/^.*\//, '') })
          }
        } catch (error) {
          return `flash refused: ${argsPath} — ${error?.message ?? error}`
        }
        if (parts.length === 0) {
          return `error: ${argsPath} names no .bin files — is that an ESP-IDF build directory?`
        }
        for (const part of parts) files[`bin@${part.offset}`] = `${dir}/${part.file}`
        rendered = '\n' + parts
          .map((part) => `  bin@${part.offset.padEnd(9)} ${part.file}`)
          .join('\n')
        const tuning = Object.entries(settings).map(([key, value]) => `${key.replace('flash_', '')} ${value}`)
        if (tuning.length > 0) rendered += `\n  from flash_args: ${tuning.join(', ')}`
      } else if (args.bins !== undefined && typeof args.bins === 'object' && args.bins !== null) {
        try {
          for (const [offset, path] of Object.entries(args.bins)) {
            files[`bin@${offsetToPartName(offset)}`] = path
          }
        } catch (error) {
          return `flash refused: ${error?.message ?? error}`
        }
      } else {
        return 'error: pass `bins` (offset → path) or `build_dir`.'
      }

      // Choose the baud from what the slot actually is. Measured on this bench:
      // a 185 kB image over a CP2102 at 921600 dies mid-write with "No more data to
      // read from the serial port"; the same image at 115200 writes and verifies. The
      // same failure reproduced on a CH343 bridge with a 1.2 MB image. Native
      // USB-JTAG slots sustain 921600 fine, so they keep it. A caller who passes
      // `baud` always wins.
      let native = null
      try {
        const devices = await client.execute('get_devices', {}, { signal: exec.signal })
        const record = (devices.data?.slots ?? []).find((entry) => entry.label === args.slot)
        native = (record?.usb_devices ?? [])
          .some((device) => typeof device?.vid_pid === 'string' && device.vid_pid.startsWith('303a:'))
      } catch { /* unknown — stay conservative */ }

      let baud = args.baud ?? null
      let note = ''
      if (baud === null) {
        baud = native === true ? '921600' : '115200'
        if (native !== true) {
          note += '\n  baud 115200: bridge slot — 921600 loses data mid-write on the large image (pass baud to override).'
        }
      }
      // A bootloader at 0x0 is correct for S3/C3/C6/H2 and a guaranteed boot loop on a
      // classic ESP32, whose second-stage bootloader lives at 0x1000. Verified here: a
      // 0x0 write boot-looped with `invalid header: 0x2045000a` until the offset moved.
      if (Object.hasOwn(files, 'bin@0x0') && native !== true) {
        note += '\n  classic-ESP32 check: if this board is a classic ESP32 (not S3/C3/C6/H2) its bootloader ' +
          'belongs at 0x1000, not 0x0 — 0x0 boot-loops with "invalid header". 0x0 is correct for the others.'
      }

      const outcome = await client.execute('flash', {
        slot: args.slot,
        chip: args.chip ?? 'auto',
        baud,
        ...settings,
        // Only send `erase` when it is actually wanted: absence is what preserves NVS.
        ...args.erase === true ? { erase: '1' } : {},
      }, { files, signal: exec.signal })

      const parts = Object.keys(files).join(', ')
      if (!outcome.success) {
        return renderOutcome(outcome, {
          heading: `flash to ${args.slot} FAILED (parts: ${parts})${note}${rendered}`,
        })
      }
      return [
        `flashed ${args.slot} and hard-reset into it`,
        `  parts: ${parts}${note}`,
        rendered,
        '',
        clip(outcome.data.output ?? '', 2_500),
        '',
        'Next: capture the boot log with tb_serial_reset to confirm the board came up on the image you sent. ' +
        'A flash is not finished until the board boots something coherent.',
      ].join('\n')
    },
  })

  add({
    name: 'tb_chip_info',
    description:
      'Identify the board in a slot by running esptool flash-id. THE ONLY PER-BOARD IDENTIFIER on the bench — ' +
      'a slot label identifies a SOCKET, never a device, so use the MAC to confirm you are talking to the ' +
      'board you mean. Does not need the debug session stopped (it stops and restores it). ' +
      'SIDE EFFECT: esptool resets the chip, so the program on it stops and the bench\'s cached ' +
      '`detected_chip` clears for ~10 s — expect a `flash(...)` line in tb_log even though nothing was ' +
      'written. Not read-only, despite reading only. ' +
      'A device that does not answer is a 502 — usually the wrong slot or a charge-only cable.',
    parameters: {
      slot: { type: 'string', required: true, description: 'Slot label.' },
      chip: { type: 'string', description: 'Chip type, or "auto" (default).' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('chip_info', {
        slot: args.slot,
        ...args.chip !== undefined ? { chip: args.chip } : {},
      }, { signal: exec.signal })
      if (!outcome.success) {
        return renderOutcome(outcome, {
          heading: `${args.slot}: the device did not answer — check the slot actually holds a board ` +
            '(tb_status) and that the USB cable carries data',
        })
      }
      const d = outcome.data
      return [
        `${args.slot}: ${d.chip ?? '?'}${d.usb_mode ? ` (${d.usb_mode})` : ''}`,
        `  MAC: ${d.mac ?? '?'}   ← this, not the label, identifies the board`,
        `  revision: ${d.revision ?? '?'}  features: ${d.features ?? '?'}  crystal: ${d.crystal ?? '?'}`,
        d.flash_size ? `  flash: ${d.flash_size} @ ${d.flash_manufacturer ?? '?'}` : '',
      ].filter((line) => line !== '').join('\n')
    },
  })

  // ── Wi-Fi ─────────────────────────────────────────────────────────────────

  add({
    name: 'tb_wifi_ap',
    description:
      'Run the bench\'s Wi-Fi instrument: start/stop its SoftAP or read its status. The AP is the test network ' +
      '(192.168.4.1/24, DHCP .2–.20); a DUT that joins gets an address in that range and NOTHING else. ' +
      'AP and STA are mutually exclusive. Read DUT addresses from status — never assume one. ' +
      'This tool takes `password` and sends the portal\'s `pass`: the upstream MCP wrapper takes `password` and ' +
      'drops it, starting an OPEN access point that reports ok:true.',
    parameters: {
      action: { type: 'string', required: true, description: 'start | stop | status', enum: ['start', 'stop', 'status'] },
      ssid: { type: 'string', description: 'Network name (start).' },
      password: { type: 'string', description: 'WPA passphrase (start). Sent to the portal as `pass`.' },
      channel: { type: 'integer', description: 'Wi-Fi channel (default 6).' },
      internet: { type: 'boolean', description: 'Give the DUT internet through the Pi (default false).' },
    },
    isConcurrencySafe: (args) => args.action === 'status',
    async execute (args, exec) {
      if (args.action === 'status') {
        const outcome = await client.execute('ap_status', {}, { signal: exec.signal })
        if (!outcome.success) return renderOutcome(outcome)
        const d = outcome.data
        const stations = d.stations ?? []
        return [
          `AP ${d.active ? 'UP' : 'down'}${d.active ? `  "${d.ssid}" ch${d.channel}` : ''}`,
          stations.length === 0
            ? '  no stations joined'
            : stations.map((s) => `  station ${s.ip ?? '?'}  mac ${s.mac ?? '?'}`).join('\n'),
          stations.length > 0 ? '  Use these addresses as-is; do not guess a DUT IP.' : '',
        ].filter((line) => line !== '').join('\n')
      }
      if (args.action === 'stop') {
        const outcome = await client.execute('ap_stop', {}, { signal: exec.signal })
        return outcome.success ? 'AP stopped.' : renderOutcome(outcome)
      }
      if (args.ssid === undefined) return 'error: `ssid` is required to start the AP.'
      if (args.password === undefined || args.password === '') {
        return 'refusing to start an OPEN access point: pass `password`. An open AP is a real hazard on a ' +
          'shared LAN, and the portal reports ok:true either way so nothing downstream will warn you.'
      }
      const outcome = await client.execute('ap_start', {
        ssid: args.ssid,
        pass: args.password,
        ...args.channel !== undefined ? { channel: args.channel } : {},
        ...args.internet !== undefined ? { internet: args.internet } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      return `AP "${args.ssid}" up at ${outcome.data.ip}, WPA2 with the password you gave. ` +
        'DUTs joining get a lease in 192.168.4.2–.20; read the real address with tb_wifi_ap status.'
    },
  })

  add({
    name: 'tb_wifi_http',
    description:
      'Make an HTTP request from the Pi to a device on the test network — the way to reach a DUT\'s own web ' +
      'server. Takes and returns plain text; the wire protocol base64s the body in both directions and this ' +
      'tool does that for you. The URL must be a DUT address in 192.168.4.0/24: eth0 already routes to the ' +
      'house LAN, so a LAN request proves nothing about the DUT.',
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute URL on the test network, e.g. http://192.168.4.17/status' },
      method: { type: 'string', description: 'HTTP method (default GET).' },
      headers: { type: 'json', description: 'Request headers as an object.' },
      body: { type: 'string', description: 'Request body as plain text (base64-encoded for the wire).' },
      timeout: { type: 'number', description: 'Seconds (default 10).' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('wifi_http', {
        url: args.url,
        ...args.method !== undefined ? { method: args.method } : {},
        ...args.headers !== undefined ? { headers: args.headers } : {},
        ...args.body !== undefined ? { body: Buffer.from(args.body, 'utf8').toString('base64') } : {},
        ...args.timeout !== undefined ? { timeout: args.timeout } : {},
      }, { signal: exec.signal })
      if (!outcome.success) {
        // Separate the two failures an operator confuses: the DUT is up but not serving
        // HTTP there, versus no route at all. They have different fixes.
        const error = String(outcome.data?.error ?? '')
        const diagnosis = /connection refused/i.test(error)
          ? 'CONNECTION REFUSED — the address answered at the IP layer, so something is there, but nothing is ' +
            'listening on that port. The DUT is reachable and its web server is not running.'
          : /timed out|timeout|unreachable|no route/i.test(error)
            ? 'NO ROUTE OR NO ANSWER — nothing replied at all. Confirm the DUT is on this network (tb_provision ' +
              'or tb_udplog names its address) before blaming the URL.'
            : ''
        const rendered = renderOutcome(outcome)
        return diagnosis === '' ? rendered : `${rendered}\n${diagnosis}`
      }
      const d = outcome.data
      let decoded
      try {
        decoded = Buffer.from(d.body ?? '', 'base64').toString('utf8')
      } catch {
        decoded = '(body could not be decoded as UTF-8 — it is probably binary)'
      }
      return [
        `${args.method ?? 'GET'} ${args.url} → HTTP ${d.status}`,
        d.headers ? `headers: ${JSON.stringify(d.headers)}` : '',
        '',
        clip(decoded, 3_000),
      ].filter((line) => line !== '').join('\n')
    },
  })

  add({
    name: 'tb_wifi_scan',
    description:
      'Survey the air from the Pi\'s radio. AN EMPTY LIST MEANS THE AIR WAS EMPTY — it never means the scan ' +
      'failed. While the SoftAP is running the scan is REFUSED (HTTP 503, and the body has no `ok` key at all) ' +
      'because one radio cannot beacon and survey at once; stop the AP first. Neither condition is a fault.',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute (_args, exec) {
      const outcome = await client.execute('wifi_scan', {}, { signal: exec.signal })
      if (!outcome.success) {
        const message = String(outcome.shortfall ?? '')
        if (message.toLowerCase().includes('cannot scan while the ap is running')) {
          return [
            'the scan was REFUSED because the SoftAP is up, and this radio cannot beacon and survey at once.',
            'This is a mode condition, not a fault. Stop the AP first: tb_wifi_ap action=stop',
            'Then scan, then raise the AP again if the DUT needs it.',
          ].join('\n')
        }
        return renderOutcome(outcome)
      }
      const networks = outcome.data.networks ?? []
      if (networks.length === 0) {
        return 'scan complete: no networks in range. That is a result about the air, not a failure of the scan.'
      }
      return `scan complete: ${networks.length} network(s)\n` + clip(networks)
    },
  })

  add({
    name: 'tb_provision',
    description:
      'Provision a captive-portal DUT onto the bench AP, in the one order that works. enter-portal must join ' +
      'the DUT\'s own portal as a station, and AP/STA are mutually exclusive — so raising the bench AP first ' +
      'makes the flow fight itself. This tool does not do that: it starts the sequence, polls until the AP is ' +
      'up AND a new station appears, and returns that station\'s address. If two stations appear it refuses ' +
      'to guess and names both.',
    parameters: {
      portal_ssid: { type: 'string', description: 'The SSID the DUT broadcasts in portal mode.' },
      ssid: { type: 'string', description: 'The network the DUT should join afterwards (the bench AP).' },
      password: { type: 'string', description: 'Passphrase for that network.' },
      save_path: { type: 'string', description: 'Portal form action path (default /connect).' },
      timeout: { type: 'number', description: 'Seconds to wait for the station to appear (default 90).' },
    },
    async execute (args, exec) {
      // The portal serialises long-running work, so a request issued while it is still
      // finishing the previous one can exceed its own budget and abort. Through this
      // whole flow that must be a "not yet", not a fatal error: the flow has its own
      // deadline and the DUT joining is asynchronous by contract. Observed for real —
      // `ap_status` answers in 4 ms from a shell while a poll here timed out at 15 s,
      // because the bench was still completing the AP bring-up.
      let pollError = null
      const poll = async (endpointId) => {
        try {
          return await client.execute(endpointId, {}, { signal: exec.signal })
        } catch (error) {
          pollError = error?.message ?? String(error)
          return { success: false, data: {}, error: pollError, transient: true }
        }
      }

      const before = await poll('ap_status')
      const beforeMacs = new Set((before.data?.stations ?? []).map((s) => s.mac))

      await poll('ap_stop')
      let started
      try {
        started = await client.execute('enter_portal', {
          ...args.portal_ssid !== undefined ? { portal_ssid: args.portal_ssid } : {},
          ...args.ssid !== undefined ? { ssid: args.ssid } : {},
          ...args.password !== undefined ? { password: args.password } : {},
          ...args.save_path !== undefined ? { save_path: args.save_path } : {},
        }, { signal: exec.signal })
      } catch (error) {
        return [
          `enter-portal did not answer in time: ${error?.message ?? error}`,
          'That is not necessarily a failure — the portal starts the sequence and returns before the DUT has ' +
          'joined. No station was confirmed, so treat this as UNPROVISIONED: re-check the DUT is in portal mode, ' +
          'then try again.',
        ].join('\n')
      }
      if (!started.success) return renderOutcome(started)

      const deadline = Date.now() + (args.timeout ?? 90) * 1000
      let last = null
      for (;;) {
        const status = await poll('ap_status')
        last = status.data ?? {}
        const fresh = (last.stations ?? []).filter((station) => !beforeMacs.has(station.mac))
        if (last.active === true && fresh.length === 1) {
          return [
            `provisioned — "${args.ssid ?? '(bench AP)'}" is up and the DUT joined`,
            `  DUT address: ${fresh[0].ip}   mac: ${fresh[0].mac}`,
            '',
            'Use this address as-is with tb_wifi_http. Never assume .17, and never point a test at the house LAN.',
          ].join('\n')
        }
        if (fresh.length > 1) {
          return [
            'REFUSING TO GUESS: two new stations appeared, and nothing binds either to the board just provisioned.',
            ...fresh.map((station) => `  candidate ${station.ip}  mac ${station.mac}`),
            '',
            'Correlate them: a DUT logging to UDP arrives in tb_udplog with its IP as `source`, and ' +
            'tb_chip_info gives the MAC you expect. If neither separates them, fail loudly rather than pick.',
          ].join('\n')
        }
        if (Date.now() >= deadline) break
        await new Promise((resolve) => setTimeout(resolve, 1_500))
      }
      return [
        `enter-portal was started but no new station appeared within ${args.timeout ?? 90}s.`,
        `  AP: ${last?.active === true ? `up "${last.ssid}"` : 'not up'}`,
        pollError === null ? '' : `  a status poll failed and was retried: ${pollError}`,
        '  This is asynchronous by design, so a timeout here is inconclusive. Check tb_log for the portal\'s ' +
        'progress, and confirm the DUT really is in portal mode (a double reset on its slot is what triggers it).',
      ].filter((line) => line !== '').join('\n')
    },
  })

  // ── observability ─────────────────────────────────────────────────────────

  add({
    name: 'tb_udplog',
    description:
      'Read the DUT debug-log receiver (UDP 5555, 2000-line buffer). This is the loop\'s eyes INSIDE the DUT ' +
      'when USB is busy (e.g. a HID keyboard build). Poll incrementally with `since` — the timestamp is a ' +
      'float epoch. `source` filters to one DUT address.',
    parameters: {
      since: { type: 'number', description: 'Only lines newer than this float epoch timestamp.' },
      source: { type: 'string', description: 'Filter to one source IP, e.g. 192.168.4.17.' },
      limit: { type: 'integer', description: 'Max lines (default 200).' },
      clear: { type: 'boolean', description: 'Clear the buffer instead of reading it.' },
    },
    isConcurrencySafe: (args) => args.clear !== true,
    async execute (args, exec) {
      if (args.clear === true) {
        const cleared = await client.execute('udplog_clear', {}, { signal: exec.signal })
        return cleared.success ? 'UDP log buffer cleared.' : renderOutcome(cleared)
      }
      const outcome = await client.execute('udplog_get', {
        ...args.since !== undefined ? { since: args.since } : {},
        ...args.source !== undefined ? { source: args.source } : {},
        ...args.limit !== undefined ? { limit: args.limit } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const lines = outcome.data.lines ?? []
      if (lines.length === 0) {
        return 'no UDP log lines. Either the DUT is not logging yet, or it is not on the test network ' +
          '(the receiver is UDP 5555 and lines carry the sender as `source`).'
      }
      const last = lines[lines.length - 1]?.ts
      return `${lines.length} line(s) (poll again with since=${last}):\n` +
        lines.map((line) => `  [${line.source}] ${line.line}`).join('\n')
    },
  })

  add({
    name: 'tb_log',
    description:
      'The portal\'s own activity log (200-entry ring) — what the BENCH did, not what the DUT printed. ' +
      'This is where asynchronous operations report progress: enter-portal, flap recovery, proxy restarts.',
    parameters: {
      since: { type: 'string', description: 'ISO-8601 timestamp; compared lexically. Omit for the recent tail.' },
      limit: { type: 'integer', description: 'How many entries to show (default 40).' },
    },
    isConcurrencySafe: () => true,
    async execute (args, exec) {
      const outcome = await client.execute('get_log', {
        ...args.since !== undefined ? { since: args.since } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const entries = (outcome.data.entries ?? []).slice(-(args.limit ?? 40))
      if (entries.length === 0) return 'the activity log is empty.'
      return `${entries.length} entries (oldest first):\n` +
        entries.map((entry) => `  ${entry.ts} [${entry.cat}] ${entry.msg}`).join('\n')
    },
  })

  // ── operator ──────────────────────────────────────────────────────────────

  add({
    name: 'tb_operator',
    description:
      'Ask the human at the bench to do something physical — press a button, swap a cable, power-cycle — and ' +
      'block until they answer on the Pi\'s display. Only one prompt can be pending at a time. ' +
      'CRITICAL: a timeout or a Cancel still answers ok:true with confirmed:false; this tool reports a ' +
      'cancellation as a cancellation, never as agreement. ' +
      'For a question that only needs a decision in this chat, prefer the harness\'s own ask_user_question.',
    parameters: {
      action: { type: 'string', required: true, description: 'ask | status | done | cancel', enum: ['ask', 'status', 'done', 'cancel'] },
      message: { type: 'string', description: 'What the operator must do (ask).' },
      timeout: { type: 'number', description: 'Seconds to wait for an answer (default 120). No server cap — keep it realistic.' },
    },
    async execute (args, exec) {
      if (args.action === 'status') {
        const outcome = await client.execute('human_status', {}, { signal: exec.signal })
        return outcome.success ? clip(outcome.data) : renderOutcome(outcome)
      }
      if (args.action === 'done' || args.action === 'cancel') {
        const outcome = await client.execute(args.action === 'done' ? 'human_done' : 'human_cancel', {}, { signal: exec.signal })
        return outcome.success ? `operator prompt ${args.action === 'done' ? 'confirmed DONE' : 'CANCELLED'}.` : renderOutcome(outcome)
      }
      if (args.message === undefined) return 'error: `message` is required to ask.'
      const outcome = await client.execute('human_interaction', {
        message: args.message,
        ...args.timeout !== undefined ? { timeout: args.timeout } : {},
      }, { signal: exec.signal })
      const d = outcome.data ?? {}
      if (d.confirmed === true) return `operator CONFIRMED: "${args.message}"`
      if (d.timeout === true) {
        return `operator did NOT answer within ${args.timeout ?? 120}s — "${args.message}"\n` +
          '  A timeout is not a confirmation. Do not proceed as if the action happened.'
      }
      return `operator CANCELLED: "${args.message}"\n` +
        '  A cancel is an explicit no. Stop and ask what to do instead rather than retrying.'
    },
  })

  // ── debug / services ──────────────────────────────────────────────────────

  add({
    name: 'tb_debug',
    description:
      'GDB/JTAG debugging through the bench: start, stop or inspect an OpenOCD session. Only native-USB parts ' +
      '(Espressif VID 303a) have built-in JTAG; a bridge-only slot cannot be debugged, and this bench has no ' +
      'external probe. Do NOT stop a session just to flash — tb_flash stops and restores it with the CPU ' +
      'running, and calling stop instead loses that restoration.',
    parameters: {
      action: { type: 'string', required: true, description: 'start | stop | status', enum: ['start', 'stop', 'status'] },
      slot: { type: 'string', description: 'Slot label. Optional on start (the portal auto-finds the first present slot).' },
      chip: { type: 'string', description: 'Chip type override.' },
    },
    isConcurrencySafe: (args) => args.action === 'status',
    async execute (args, exec) {
      if (args.action === 'status') {
        const outcome = await client.execute('debug_status', {}, { signal: exec.signal })
        if (!outcome.success) return renderOutcome(outcome)
        const slots = outcome.data.slots ?? {}
        const active = Object.entries(slots).filter(([, value]) => value.debugging === true)
        if (active.length === 0) return 'no debug session is running.'
        return active.map(([label, value]) =>
          `${label}: ${value.chip ?? '?'}  gdb :${value.gdb_port}  telnet :${value.telnet_port}  ` +
          `probe ${value.probe ?? 'built-in'}\n  connect: target extended-remote ${benchUrl.replace(/^https?:\/\//, '').replace(/:8080$/, '')}:${value.gdb_port}`,
        ).join('\n')
      }
      if (args.action === 'stop') {
        const outcome = await client.execute('debug_stop', {
          ...args.slot !== undefined ? { slot: args.slot } : {},
        }, { signal: exec.signal })
        return outcome.success ? `debug session on ${args.slot ?? '(auto)'} stopped (CPU left running).` : renderOutcome(outcome)
      }
      const outcome = await client.execute('debug_start', {
        ...args.slot !== undefined ? { slot: args.slot } : {},
        ...args.chip !== undefined ? { chip: args.chip } : {},
      }, { signal: exec.signal })
      if (!outcome.success) return renderOutcome(outcome)
      const d = outcome.data
      return [
        `debug session started on ${d.slot} (${d.chip})`,
        `  GDB:    ${d.gdb_target}`,
        `  telnet: ${benchUrl.replace(/^https?:\/\//, '').replace(/:8080$/, '')}:${d.telnet_port}`,
        `  probe:  ${d.probe ?? 'built-in USB-JTAG'}`,
        '',
        'While this is live, a non-`debugging` lease is refused with 409 — but flashing still works, because ' +
        'the portal stops and restores the session itself.',
      ].join('\n')
    },
  })

  add({
    name: 'tb_mqtt',
    description:
      'The mosquitto test broker on the Pi (1883, anonymous, all interfaces). It is SHARED INFRASTRUCTURE: ' +
      'bench reset ensures it runs and never stops it, and a test should not restart it — that breaks whatever ' +
      'else is using the bench, and a test that needs a restart to pass is testing the restart.',
    parameters: {
      action: { type: 'string', required: true, description: 'status | start | stop', enum: ['status', 'start', 'stop'] },
    },
    isConcurrencySafe: (args) => args.action === 'status',
    async execute (args, exec) {
      if (args.action === 'status') {
        const outcome = await client.execute('mqtt_status', {}, { signal: exec.signal })
        return outcome.success ? clip(outcome.data) : renderOutcome(outcome)
      }
      const outcome = await client.execute(args.action === 'start' ? 'mqtt_start' : 'mqtt_stop', {}, { signal: exec.signal })
      return outcome.success ? `MQTT broker ${args.action}ed.` : renderOutcome(outcome)
    },
  })

  add({
    name: 'tb_firmware',
    description:
      'The Pi\'s firmware repository — where an OTA image is staged before a board pulls it. ' +
      '`list` shows what is deployed; `upload` stages a local file under a project name; `delete` removes one.',
    parameters: {
      action: { type: 'string', required: true, description: 'list | upload | delete', enum: ['list', 'upload', 'delete'] },
      project: { type: 'string', description: 'Project name (upload/delete).' },
      path: { type: 'string', description: 'Local file to upload.' },
      filename: { type: 'string', description: 'Stored filename to delete.' },
    },
    isConcurrencySafe: (args) => args.action === 'list',
    async execute (args, exec) {
      if (args.action === 'list') {
        const outcome = await client.execute('firmware_list', {}, { signal: exec.signal })
        if (!outcome.success) return renderOutcome(outcome)
        const files = outcome.data.files ?? []
        if (files.length === 0) return 'the firmware repository is empty.'
        return `${files.length} file(s):\n` +
          files.map((f) => `  ${f.project}/${f.filename}  ${f.size} B  ${f.modified}`).join('\n')
      }
      if (args.action === 'delete') {
        if (args.project === undefined || args.filename === undefined) {
          return 'error: `project` and `filename` are both required to delete.'
        }
        const outcome = await client.execute('firmware_delete', { project: args.project, filename: args.filename }, { signal: exec.signal })
        return outcome.success ? `deleted ${args.project}/${args.filename}.` : renderOutcome(outcome)
      }
      if (args.project === undefined || args.path === undefined) {
        return 'error: `project` and `path` are both required to upload.'
      }
      const outcome = await client.execute('firmware_upload', { project: args.project }, {
        files: { file: args.path },
        signal: exec.signal,
      })
      if (!outcome.success) return renderOutcome(outcome)
      const d = outcome.data
      return [
        `staged ${d.project}/${d.filename} (${d.size} B)`,
        `  A DUT pulls it over HTTP: ${benchUrl}/firmware/${d.project}/${d.filename}`,
        '  That URL is what the firmware\'s OTA handler should be pointed at.',
      ].join('\n')
    },
  })

  add({
    name: 'tb_ota',
    description:
      'Push a firmware image to a board ALREADY RUNNING and on the LAN, via ArduinoOTA relayed by the Pi. ' +
      'This is the update path for a deployed device — not a way to install firmware on a blank board ' +
      '(use tb_flash for that, over a slot). 504 means the board never answered.',
    parameters: {
      target: { type: 'string', required: true, description: 'The board\'s IP address.' },
      path: { type: 'string', required: true, description: 'Local firmware image to send.' },
      port: { type: 'string', description: 'ArduinoOTA port (default 3232).' },
      auth: { type: 'string', description: 'The DUT\'s ArduinoOTA password, if it has one.' },
    },
    async execute (args, exec) {
      const outcome = await client.execute('ota', {
        target: args.target,
        ...args.port !== undefined ? { port: args.port } : {},
        ...args.auth !== undefined ? { auth: args.auth } : {},
      }, { files: { firmware: args.path }, signal: exec.signal })
      if (!outcome.success) {
        return renderOutcome(outcome, {
          heading: `OTA to ${args.target} failed — a 504, or a nonzero returncode, means the board never ` +
            `answered on port ${args.port ?? 3232} (it is not running an ArduinoOTA handler, or it is not on this network)`,
        })
      }
      return `OTA delivered to ${args.target}.\n${clip(outcome.data.output ?? '', 1_500)}`
    },
  })
}
