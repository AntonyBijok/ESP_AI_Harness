/**
 * The bench transport: one function that turns an endpoint id plus arguments into
 * a classified outcome.
 *
 * Everything this module knows about failure it learned from the operating
 * contract, and the ordering of the tests matters more than any single one of
 * them (`TESTBENCH-PLUGIN-API.md` §9):
 *
 *   transport → `ok` field → the endpoint's own success field → status code
 *
 * Checking only `ok` is how a generated client reports a timeout as a pass:
 * `serial/monitor` answers `ok:true, matched:false` on timeout, `human-interaction`
 * answers `ok:true, confirmed:false`, and `bench/reset` answers `ok:true` with a
 * populated `errors[]`. So `ok` is necessary and never sufficient, and the extra
 * field each endpoint needs is read from the manifest rather than remembered here.
 *
 * @module esp-aiclp/client
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  coerce,
  jsonType,
  payloadParams,
  requestPath,
  timeoutFor,
  validateArgs,
} from './manifest.js'

/**
 * Per-endpoint success rules, keyed by manifest id.
 *
 * Each entry answers one question the `ok` field cannot: did the OPERATION happen?
 * The manifest carries the same rule as prose in `success_predicate`; these are the
 * executable form, and `successRule` asserts the two do not drift.
 */
const SUCCESS_RULES = {
  serial_monitor: {
    field: 'matched',
    detail: 'a monitor that timed out still returns ok:true — matched must be true for the reply to count',
  },
  human_interaction: {
    field: 'confirmed',
    detail: 'ok:true with confirmed:false means the operator timed out or cancelled, not that the request worked',
  },
  net_portscan: {
    field: 'complete',
    detail: 'ok:true with complete:false is a truncated scan',
  },
}

/** Multipart endpoints, whose payload is a form rather than JSON. */
const MULTIPART = new Set(['flash', 'firmware_upload', 'ota'])

/** Endpoints that answer with bytes and carry no `ok` field at all. */
const BINARY = new Set(['firmware_download'])

/**
 * The success rule for one endpoint.
 * @param {object} endpoint - one manifest entry.
 * @returns {{ field?: string, detail?: string } | undefined}
 */
function successRule (endpoint) {
  if (BINARY.has(endpoint.id)) return { detail: endpoint.success_predicate ?? 'binary response' }
  if (endpoint.id === 'bench_reset') return { detail: 'ok:true with a non-empty errors[] is a partial reset' }
  return SUCCESS_RULES[endpoint.id]
}

/**
 * Classify a decoded JSON body against the contract.
 *
 * Reads `ok` through `.get()`: route-level 404s return `{"error":"not found"}` with
 * no `ok` key at all, and indexing would raise on exactly the failures a caller most
 * needs to see.
 * @param {object} endpoint - the endpoint called.
 * @param {number} status - HTTP status.
 * @param {object} body - decoded JSON body.
 * @returns {{ success: boolean, shortfall: string|null }}
 */
function classifyJson (endpoint, status, body) {
  const ok = body?.ok
  const rule = successRule(endpoint)
  const error = typeof body?.error === 'string' ? body.error : null

  if (ok === undefined) {
    return {
      success: false,
      shortfall: error === null
        ? `HTTP ${status} with no \`ok\` field — the portal answered outside its JSON contract`
        : `HTTP ${status}: ${error}`,
    }
  }
  if (ok !== true) {
    return { success: false, shortfall: error ?? body?.message ?? `the bench reported ok:false (HTTP ${status})` }
  }
  if (endpoint.id === 'bench_reset') {
    const errors = Array.isArray(body?.errors) ? body.errors : []
    if (errors.length > 0) {
      return { success: false, shortfall: `the reset ran but reported ${errors.length} error(s): ${errors.join('; ')}` }
    }
  }
  if (rule?.field !== undefined && body?.[rule.field] !== true) {
    return { success: false, shortfall: `${rule.field} was not true — ${rule.detail}` }
  }
  return { success: true, shortfall: null }
}

/**
 * Build the request URL for one call.
 * @param {string} baseUrl - bench origin.
 * @param {object} endpoint - the endpoint called.
 * @param {Record<string, unknown>} args - validated arguments.
 * @returns {string}
 */
function buildUrl (baseUrl, endpoint, args) {
  const url = new URL(requestPath(endpoint, args), baseUrl)
  for (const param of endpoint.params ?? []) {
    if (param.in !== 'query') continue
    const value = args[param.name]
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(param.name, String(value))
  }
  return url.href
}

/**
 * Read one local file for a multipart upload.
 * @param {string} path - path as the caller supplied it.
 * @param {(path: string, signal?: AbortSignal) => Promise<Uint8Array>} readFileImpl - injected reader.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<{ name: string, bytes: Uint8Array }>}
 */
async function readPart (path, readFileImpl, signal) {
  const bytes = await readFileImpl(path, signal)
  // A path-traversal guard on the *filename* is the portal's rule, and it rejects
  // anything containing "/" or ".." with a 400 — so send the bare basename.
  return { name: basename(path), bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }
}

/**
 * Assemble a multipart form for the three upload endpoints.
 *
 * Image parts are named by the caller (`bin@0x0`, `flash_args`, `file`) because the
 * PART NAME is the protocol: for `bin@<offset>` the offset lives in the name, and
 * `int(offset, 0)` makes `bin@8000` decimal 8000, not 0x8000. That trap is enforced
 * in `tools/core.js` where the human-facing interface lives; here the name is passed
 * through exactly as given.
 * @param {object} endpoint - the endpoint called.
 * @param {Record<string, unknown>} args - validated arguments.
 * @param {Record<string, string>} files - part name → local path.
 * @param {(path: string, signal?: AbortSignal) => Promise<Uint8Array>} readFileImpl - injected reader.
 * @param {AbortSignal|undefined} signal - cancellation.
 * @returns {Promise<FormData>}
 */
async function buildForm (endpoint, args, files, readFileImpl, signal) {
  const form = new FormData()
  for (const param of endpoint.params ?? []) {
    if (param.in !== 'form') continue
    const value = args[param.name]
    if (value === undefined || value === null) continue
    form.append(param.name, String(value))
  }
  const entries = Object.entries(files ?? {})
  if (entries.length === 0) {
    throw new Error(`${endpoint.id}: needs at least one file part (nothing to send)`)
  }
  for (const [partName, localPath] of entries) {
    const part = await readPart(localPath, readFileImpl, signal)
    form.append(partName, new Blob([part.bytes]), part.name)
  }
  return form
}

/**
 * Create the bench client.
 * @param {object} options - transport configuration.
 * @param {string} options.baseUrl - bench origin, e.g. `http://192.168.0.29:8080`.
 * @param {object} options.manifest - the loaded manifest.
 * @param {number} [options.floorTimeoutMs] - minimum request timeout.
 * @param {(path: string, signal?: AbortSignal) => Promise<Uint8Array>} [options.readFile] - local file reader.
 * @returns {{ execute: Function, get: Function, manifest: object }}
 */
export function createClient ({ baseUrl, manifest, floorTimeoutMs = 15_000, readFile: readFileImpl = readFile }) {
  const { byId, endpoints } = manifest
  const conventions = manifest.conventions ?? {}

  /**
   * Call one endpoint and classify the outcome.
   *
   * Transport failures throw: a refused connection or an aborted request is not a
   * bench state the caller can reason about, it is a broken tool. Application
   * failures return `success: false` instead, because a held slot or a matched-nothing
   * monitor is information the caller must act on rather than an exception to escape.
   * @param {string} endpointId - manifest endpoint id.
   * @param {Record<string, unknown>} [args] - caller arguments.
   * @param {object} [options] - per-call options.
   * @param {Record<string, string>} [options.files] - multipart parts.
   * @param {AbortSignal} [options.signal] - cancellation from the tool execution.
   * @param {number} [options.timeoutMs] - override the derived timeout.
   * @returns {Promise<object>} the classified outcome.
   */
  async function execute (endpointId, args = {}, options = {}) {
    const endpoint = byId.get(endpointId)
    if (endpoint === undefined) throw new Error(`unknown testbench endpoint "${endpointId}"`)

    const { value, missing, unknown } = validateArgs(endpoint, args, {
      allowUnknown: false,
      providedFiles: new Set(Object.keys(options.files ?? {})),
    })
    if (missing.length > 0) throw new Error(`${endpointId}: missing required ${missing.join(', ')}`)
    if (unknown.length > 0) {
      throw new Error(
        `${endpointId}: unknown parameter(s) ${unknown.join(', ')} — the portal ignores fields it does not read, ` +
        'so this would be silently dropped. Declared: ' +
        (payloadParams(endpoint).map((p) => p.name).join(', ') || '(none)'),
      )
    }

    const isMultipart = MULTIPART.has(endpoint.id)
    const url = buildUrl(baseUrl, endpoint, value)
    const timeoutMs = options.timeoutMs ?? timeoutFor(endpoint, conventions, floorTimeoutMs)
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (options.signal !== undefined) signals.push(options.signal)

    const init = {
      method: endpoint.method === 'ANY' ? 'GET' : endpoint.method,
      signal: AbortSignal.any(signals),
      headers: {},
    }
    if (isMultipart) {
      init.body = await buildForm(endpoint, value, options.files ?? {}, readFileImpl, options.signal)
    } else if (endpoint.method !== 'GET' && endpoint.method !== 'DELETE') {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(value)
    } else if (endpoint.method === 'DELETE') {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(value)
    }

    const startedAt = Date.now()
    let response
    try {
      response = await fetch(url, init)
    } catch (cause) {
      const hint = cause?.name === 'TimeoutError'
        ? `the bench did not answer within ${timeoutMs} ms (endpoint budget ${endpoint.timeout_s ?? 'default'}) — ` +
          'a long operation that drops mid-flight is most often cured by POST /api/bench/reset, not by retrying'
        : 'the bench is unreachable — check the URL and that the Pi is up (GET /api/wifi/ping)'
      throw new Error(`${endpointId}: ${hint}`, { cause })
    }
    const durationMs = Date.now() - startedAt

    if (BINARY.has(endpoint.id)) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') ?? ''
      const looksJson = contentType.includes('application/json')
      let shortfall = null
      if (response.status !== 200) shortfall = `HTTP ${response.status}`
      else if (looksJson) shortfall = 'the portal answered with JSON, which for this endpoint is an error body'
      else if (bytes.byteLength === 0) shortfall = 'HTTP 200 but the body was empty'
      return {
        endpoint: endpoint.id,
        method: endpoint.method,
        path: requestPath(endpoint, value),
        http_status: response.status,
        ok_field: null,
        success: shortfall === null,
        shortfall,
        data: shortfall === null
          ? `binary, ${bytes.byteLength} bytes (content-type ${contentType || 'unknown'})`
          : new TextDecoder().decode(bytes.slice(0, 2_000)),
        bytes: bytes.byteLength,
        duration_ms: durationMs,
      }
    }

    const text = await response.text()
    let body
    try {
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      return {
        endpoint: endpoint.id,
        method: endpoint.method,
        path: requestPath(endpoint, value),
        http_status: response.status,
        ok_field: null,
        success: false,
        shortfall: 'the bench returned a body that is not JSON — see data',
        data: text.slice(0, 4_000),
        duration_ms: durationMs,
      }
    }

    const { success, shortfall } = classifyJson(endpoint, response.status, body)
    return {
      endpoint: endpoint.id,
      method: endpoint.method,
      path: requestPath(endpoint, value),
      http_status: response.status,
      ok_field: body?.ok ?? null,
      success,
      shortfall,
      prerequisite: endpoint.availability === 'partial' ? (endpoint.prerequisite ?? 'partial capability') : null,
      data: body,
      duration_ms: durationMs,
    }
  }

  /**
   * Convenience wrapper that asserts success, for callers whose failure branch is an
   * exception rather than a value.
   * @param {string} endpointId - manifest endpoint id.
   * @param {Record<string, unknown>} [args] - caller arguments.
   * @param {object} [options] - per-call options.
   * @returns {Promise<object>} the outcome's `data`.
   */
  async function get (endpointId, args = {}, options = {}) {
    const outcome = await execute(endpointId, args, options)
    if (!outcome.success) throw new Error(`${endpointId}: ${outcome.shortfall}`)
    return outcome.data
  }

  return { execute, get, endpoints, byId, baseUrl }
}

export { SUCCESS_RULES, MULTIPART, BINARY, jsonType, coerce }
