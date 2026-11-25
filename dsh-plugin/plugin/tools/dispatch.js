/**
 * Progressive disclosure for the long tail.
 *
 * Sixty-eight endpoints are reachable, and putting sixty-eight schemas in the tool
 * catalog costs every request. So the long tail is reached through two tools
 * instead: `tb_endpoints` is the directory (compact signatures, then one full
 * contract on demand), and `tb_call` is the dispatcher whose arguments are validated
 * against the manifest entry before the request is sent.
 *
 * This mirrors the harness's own Inspect pattern on purpose — a compact directory to
 * navigate, then one exact contract — because a model that has already learned to
 * read one such provider reads the other for free.
 *
 * The dispatcher is also where the manifest's `availability` vocabulary is enforced.
 * `unavailable` names hardware this bench does not have, and `never_call` names the
 * two udev/dnsmasq callbacks that must never be sent by a client; both are refused
 * here by name rather than by a check the caller could forget.
 *
 * @module esp-aiclp/tools/dispatch
 */
import { defineTool } from '../tool.js'
import { emittable, jsonType, payloadParams, signature } from '../manifest.js'
import { TEXT_OUTPUT, clip, json, renderOutcome } from './shared.js'

/**
 * Register the dispatcher and the endpoint directory.
 * @param {object} deps - resolved dependencies.
 * @param {object} deps.ctx - Cordis context carrying the tool registry.
 * @param {object} deps.client - the bench client from `client.js`.
 * @param {object} deps.manifest - the loaded manifest.
 * @param {object} deps.config - resolved plugin config.
 * @returns {void}
 */
export function registerDispatchTools ({ ctx, client, manifest, config }) {
  const { manifest: doc, endpoints, byId } = manifest
  const callable = endpoints.filter(emittable)
  const groups = new Map()
  for (const endpoint of callable) {
    const list = groups.get(endpoint.group) ?? []
    list.push(endpoint)
    groups.set(endpoint.group, list)
  }

  const add = (definition) => ctx.tools.register(defineTool({ output: TEXT_OUTPUT, ...definition }))

  add({
    name: 'tb_endpoints',
    description:
      'The endpoint directory for the bench — every endpoint this plugin can reach, with its one-line ' +
      'signature and availability. Call with no arguments for the compact directory, then call again with an ' +
      '`id` for that endpoint\'s full contract: parameters, defaults, return fields, timeout, status codes and ' +
      'the traps that break naive clients. Read this before using tb_call on anything you have not called ' +
      'before — the traps are not repeated in tb_call\'s error messages.',
    parameters: {
      id: { type: 'string', description: 'Exact endpoint id for its full contract.' },
      group: { type: 'string', description: 'Only endpoints in this group (e.g. wifi, serial, debug, gpio, ble).' },
      query: { type: 'string', description: 'Filter the directory by substring over id, purpose and path.' },
    },
    isConcurrencySafe: () => true,
    async execute (args) {
      if (args.id !== undefined) {
        const endpoint = byId.get(args.id)
        if (endpoint === undefined) {
          return `unknown endpoint id "${args.id}". Call tb_endpoints with no id for the directory.`
        }
        if (!emittable(endpoint)) return refuseUnavailable(endpoint)
        return describeEndpoint(endpoint, doc)
      }

      let listed = callable
      if (args.group !== undefined) {
        listed = listed.filter((endpoint) => endpoint.group === args.group)
        if (listed.length === 0) {
          return `no callable endpoints in group "${args.group}". Groups: ${[...groups.keys()].sort().join(', ')}`
        }
      }
      if (args.query !== undefined) {
        const needle = args.query.toLowerCase()
        listed = listed.filter((endpoint) =>
          endpoint.id.toLowerCase().includes(needle) ||
          endpoint.path.toLowerCase().includes(needle) ||
          String(endpoint.purpose ?? '').toLowerCase().includes(needle))
        if (listed.length === 0) return `nothing matches "${args.query}".`
      }

      const byGroup = new Map()
      for (const endpoint of listed) {
        const list = byGroup.get(endpoint.group) ?? []
        list.push(endpoint)
        byGroup.set(endpoint.group, list)
      }
      const lines = [
        `${listed.length} callable endpoint(s). Call tb_endpoints id=<id> for the full contract before using tb_call.`,
        '',
      ]
      for (const [group, list] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`${group}:`)
        for (const endpoint of list) {
          const flag = endpoint.availability === 'partial' ? '  [PARTIAL — gate required]' : ''
          lines.push(`  ${signature(endpoint).padEnd(58)} ${endpoint.method.padEnd(6)} ${endpoint.path}${flag}`)
        }
        lines.push('')
      }
      lines.push(
        'Not reachable here (refused by design):',
        ...endpoints.filter((endpoint) => !emittable(endpoint))
          .map((endpoint) => `  ${endpoint.id.padEnd(20)} ${endpoint.availability}`),
      )
      return lines.join('\n')
    },
  })

  add({
    name: 'tb_call',
    description:
      'Call any bench endpoint by its manifest id, with arguments validated against the manifest first. ' +
      'This is the escape hatch for capability the curated tools do not cover: signal generator, BLE, ' +
      'port scan, TLS mirror, debug probing, test-panel updates, firmware download.\n' +
      'Arguments are checked, not forwarded blindly — an unknown parameter is an error here, because the ' +
      'portal ignores fields it does not read (that is how a `password` becomes an OPEN access point that ' +
      'reports ok:true). The result is classified with the endpoint\'s own success field, so ok:true alone ' +
      'is never reported as success.\n' +
      'Call tb_endpoints id=<endpoint> first for the parameter names and the traps.',
    parameters: {
      endpoint: { type: 'string', required: true, description: 'Manifest endpoint id, from tb_endpoints.' },
      params: { type: 'json', description: 'Endpoint arguments as an object, named exactly as the manifest declares.' },
      files: { type: 'json', description: 'For multipart endpoints only (flash, firmware_upload, ota): part name → local file path.' },
    },
    async execute (args, exec) {
      const endpoint = byId.get(args.endpoint)
      if (endpoint === undefined) {
        return `unknown endpoint id "${args.endpoint}". Call tb_endpoints for the directory.`
      }
      if (!emittable(endpoint)) return refuseUnavailable(endpoint)

      const params = args.params !== undefined && args.params !== null ? args.params : {}
      if (typeof params !== 'object' || Array.isArray(params)) {
        return 'error: `params` must be an object of endpoint arguments.'
      }

      const gate = await prerequisiteGate(endpoint, params, client, exec.signal)
      if (gate !== null) return gate

      let outcome
      try {
        outcome = await client.execute(endpoint.id, params, {
          files: args.files ?? {},
          signal: exec.signal,
        })
      } catch (error) {
        return `tb_call ${endpoint.id} could not be sent: ${error.message}`
      }
      return renderOutcome(outcome, { heading: `${endpoint.purpose ?? endpoint.id}` })
    },
  })
}

/**
 * Render the refusal for an endpoint this bench cannot serve.
 * @param {object} endpoint - a non-emittable manifest entry.
 * @returns {string}
 */
function refuseUnavailable (endpoint) {
  if (endpoint.availability === 'never_call') {
    return [
      `${endpoint.id} is NOT client-callable, by design.`,
      '',
      'It is a udev/dnsmasq callback fired ON THE PI ITSELF so the operating system can inform the portal. ' +
      'Sending it from a client fabricates an OS event — the kind of defect that makes a bench lie about its ' +
      'own state. If you think you need it, you are describing a bug elsewhere.',
    ].join('\n')
  }
  return [
    `${endpoint.id} is UNAVAILABLE on this bench — the hardware is not attached.`,
    '',
    endpoint.purpose ? `It would: ${endpoint.purpose}` : '',
    endpoint.notes ? `Manifest note: ${endpoint.notes}` : '',
    'Do not build a plan that depends on it. Check tb_status for the capability matrix.',
  ].filter((line) => line !== '').join('\n')
}

/**
 * The full contract for one endpoint, from the manifest.
 * @param {object} endpoint - one manifest entry.
 * @param {object} doc - the whole manifest.
 * @returns {string}
 */
function describeEndpoint (endpoint, doc) {
  const lines = [
    `${endpoint.id}  —  ${endpoint.method} ${endpoint.path}`,
    `group: ${endpoint.group}   availability: ${endpoint.availability}`,
    '',
    endpoint.purpose ?? '',
  ]
  if (endpoint.availability === 'partial') {
    lines.push('', `PARTIAL — gate before use: ${endpoint.prerequisite ?? endpoint.notes ?? 'see notes'}`)
  }
  const params = payloadParams(endpoint)
  if (params.length === 0) {
    lines.push('', 'parameters: none')
  } else {
    lines.push('', 'parameters:')
    for (const param of params) {
      const required = param.required === true ? 'required' : 'optional'
      const def = param.default !== undefined && param.default !== null ? `  default ${JSON.stringify(param.default)}` : ''
      const where = param.in === 'query' ? ' (query)' : param.in === 'file' ? ' (file part)' : param.in === 'form' ? ' (form field)' : ''
      const note = param.note !== undefined ? `\n      ${param.note}` : ''
      lines.push(`  ${param.name}  ${jsonType(param.type)}  ${required}${where}${def}${note}`)
    }
  }
  if (endpoint.returns !== undefined) {
    lines.push('', 'returns:')
    for (const [key, value] of Object.entries(endpoint.returns)) lines.push(`  ${key}: ${value}`)
  }
  lines.push('', `blocking: ${endpoint.blocking === true ? `yes (${endpoint.timeout_s ?? '?'} s)` : 'no'}   ` +
    `client timeout used: ${Math.round((endpoint.timeout_s ?? 0)) > 0 ? `${endpoint.timeout_s} s + 15 s margin` : '15 s floor'}`)
  if (endpoint.success_predicate !== null && endpoint.success_predicate !== undefined) {
    lines.push('', `SUCCESS RULE: ${endpoint.success_predicate}`)
  } else {
    lines.push('', 'SUCCESS RULE: ok == true (the default; this endpoint has no extra success field).')
  }
  if (endpoint.status_codes !== undefined) {
    lines.push('', 'status codes:')
    for (const [code, meaning] of Object.entries(endpoint.status_codes)) lines.push(`  ${code}: ${meaning}`)
  }
  if (endpoint.notes !== null && endpoint.notes !== undefined) {
    lines.push('', `NOTES / TRAPS:\n${endpoint.notes}`)
  }
  const caps = doc?.capabilities ?? {}
  if (endpoint.group === 'gpio' && caps.gpio_note !== undefined) lines.push('', `GPIO on this bench: ${caps.gpio_note}`)
  if (endpoint.group === 'signal_generator' && caps.signal_generator_note !== undefined) {
    lines.push('', `SIGNAL GENERATOR on this bench: ${caps.signal_generator_note}`)
  }
  return clip(lines.join('\n'), 6_000)
}

/**
 * Evaluate a `partial` endpoint's runtime gate before calling it.
 *
 * The gate is not a hard refusal for most of these — a GPIO pin can still be driven —
 * but two of them are worth stopping for, because the failure is silent:
 * `gpio_set` on unwired pins produces no measurable effect, and the signal generator
 * on this bench is a GPIO square-wave source rather than the Si5351 the caller may
 * be imagining.
 * @param {object} endpoint - the endpoint called.
 * @param {Record<string, unknown>} params - caller arguments.
 * @param {object} client - the bench client.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<string|null>} a refusal text, or null to proceed.
 */
async function prerequisiteGate (endpoint, params, client, signal) {
  if (endpoint.availability !== 'partial') return null

  // `gpio_set` names a PIN, not a slot — the gate is therefore about whether ANY slot
  // on this bench has proven BOOT/EN wiring, not about the slot the caller did not
  // name. Releasing a pin ("z") is always safe and always allowed.
  if (endpoint.id === 'gpio_set' && String(params.value).toLowerCase() !== 'z') {
    const devices = await client.execute('get_devices', {}, { signal })
    // `has_gpio` is true for every CONFIGURED slot, including empty ones, so present
    // first — an absent socket cannot have a wire in it and listing it is noise.
    const present = (devices.data?.slots ?? []).filter((slot) => slot.present === true)
    const withPins = present.filter((slot) => slot.has_gpio === true)
    const proven = withPins.filter((slot) => slot.gpio_wired === true)
    if (proven.length === 0) {
      const example = withPins[0]?.label
      return [
        'gpio_set is gated: no slot on this bench has proven BOOT/EN wiring.',
        withPins.length === 0
          ? `  ${present.length} slot(s) present, none reporting has_gpio — the pins are not configured either.`
          : withPins
              .map((slot) => `  ${slot.label}: has_gpio=true ` +
                `gpio_wired=${JSON.stringify(slot.gpio_wired)} (null = never measured, not "not wired")`)
              .join('\n'),
        '',
        '`has_gpio` means pins are CONFIGURED; no software can see a wire. Driving a pin nobody',
        'wired silently does nothing, which then reads as a firmware bug.',
        '',
        'Measure first (~15 s):',
        `  tb_call endpoint=serial_gpio_test params={"slot":"${example ?? 'SLOT4'}"}`,
        'Then retry once gpio_wired is true.',
        '',
        'Releasing a pin is always allowed and should be done before you finish:',
        '  tb_call endpoint=gpio_set params={"pin":18,"value":"z"}',
      ].join('\n')
    }
  }

  if (endpoint.group === 'signal_generator') {
    const status = await client.execute('siggen_status', {}, { signal })
    const hardware = status.data?.hardware ?? {}
    return [
      'signal generator on this bench is PARTIAL — check before relying on it.',
      `  backends present: si5351=${JSON.stringify(hardware.si5351)} gpclk=${JSON.stringify(hardware.gpclk)} ` +
      `pe4302=${JSON.stringify(hardware.pe4302)} (the pe4302 flag is optimistic — do not rely on attenuation)`,
      '',
      'With gpclk only, this is a GPIO square-wave source, not an RF generator: frequencies are discrete. ' +
      'Enumerate them with tb_call endpoint=siggen_frequencies before choosing, never sweep blindly.',
      '',
      `...then call again with params=${json(params)} if that is still what you want.`,
    ].join('\n')
  }

  return null
}
