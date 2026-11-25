/**
 * The bench's endpoint registry, built from the vendored API manifest.
 *
 * The manifest (`manifest.json`, captured from the running bench and reconciled
 * against `pi/portal.py`) is the single source of truth for what this plugin can
 * call. Nothing here hardcodes a path, a port or a parameter name: every tool in
 * `tools/` resolves through this module, so regenerating the manifest is the only
 * step needed when the bench changes.
 *
 * `availability` has FOUR values, not three. A generator that handles only the
 * first three silently emits the two udev callbacks that must never be sent — so
 * {@link emittable} is the only sanctioned filter and it refuses `never_call`
 * explicitly rather than by omission.
 *
 * @module esp-aiclp/manifest
 */
import { readFileSync } from 'node:fs'

/** Absolute path of the vendored manifest, beside this module. */
const MANIFEST_URL = new URL('./manifest.json', import.meta.url)

/** Endpoint availabilities a tool may be built from. `never_call` is excluded on purpose. */
const EMITTABLE = new Set(['available', 'partial'])

/**
 * Load and index the vendored manifest.
 * @returns {{ manifest: object, endpoints: object[], byId: Map<string, object>,
 *   byGroup: Map<string, object[]>, neverCall: string[] }}
 */
export function loadManifest () {
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'))
  const endpoints = manifest.endpoints ?? []
  const byId = new Map()
  const byGroup = new Map()
  for (const endpoint of endpoints) {
    if (byId.has(endpoint.id)) throw new Error(`manifest: duplicate endpoint id "${endpoint.id}"`)
    byId.set(endpoint.id, endpoint)
    const group = byGroup.get(endpoint.group) ?? []
    group.push(endpoint)
    byGroup.set(endpoint.group, group)
  }
  const neverCall = endpoints.filter((e) => e.availability === 'never_call').map((e) => e.id)
  return { manifest, endpoints, byId, byGroup, neverCall }
}

/**
 * Whether a tool may be built from this endpoint.
 *
 * `partial` entries are emittable but carry their runtime gate in `prerequisite`;
 * `unavailable` names hardware this bench does not have, and `never_call` names the
 * two udev/dnsmasq callbacks fired on the Pi itself — sending one is a defect.
 * @param {object} endpoint - one manifest entry.
 * @returns {boolean}
 */
export function emittable (endpoint) {
  if (endpoint === undefined) return false
  if (endpoint.availability === 'never_call') return false
  return EMITTABLE.has(endpoint.availability)
}

/**
 * The parameters a caller supplies for this endpoint that are not already part of
 * its path template.
 * @param {object} endpoint - one manifest entry.
 * @returns {object[]} parameters with `in: 'query' | 'body'`.
 */
export function payloadParams (endpoint) {
  return (endpoint.params ?? []).filter((param) => param.in !== 'path')
}

/** Path placeholders (`<project>`, `<filename>`) in manifest order. */
export function pathParams (endpoint) {
  return (endpoint.params ?? []).filter((param) => param.in === 'path')
}

/**
 * Build the request path, substituting every `<placeholder>`.
 *
 * A missing placeholder is an error rather than an empty segment: substituting
 * nothing would produce a path the portal answers with a confusing 404.
 * @param {object} endpoint - one manifest entry.
 * @param {Record<string, unknown>} args - caller arguments.
 * @returns {string} the concrete path, still without query string.
 */
export function requestPath (endpoint, args) {
  let path = endpoint.path
  for (const param of pathParams(endpoint)) {
    const value = args[param.name]
    if (value === undefined || value === null || value === '') {
      throw new Error(`${endpoint.id}: missing path parameter "${param.name}" (path ${endpoint.path})`)
    }
    path = path.replace(`<${param.name}>`, encodeURIComponent(String(value)))
  }
  if (path.includes('<')) throw new Error(`${endpoint.id}: unresolved path placeholder in "${path}"`)
  return path
}

/**
 * Convert a manifest type name into a JSON-schema-ish spec for the tool layer.
 * @param {string|undefined} type - manifest type, e.g. `int`, `float`, `bool`.
 * @returns {'string'|'integer'|'number'|'boolean'|'object'|'array'}
 */
export function jsonType (type) {
  switch (type) {
    case 'int': return 'integer'
    case 'float':
    case 'number': return 'number'
    case 'bool':
    case 'boolean': return 'boolean'
    case 'object': return 'object'
    case 'array': return 'array'
    default: return 'string'
  }
}

/**
 * Coerce one argument to its manifest type.
 *
 * Models emit `"30"` where the portal parses an integer and `"true"` where it
 * wants a boolean; both read as defects on the Pi side, so the conversion happens
 * here instead of being pushed onto the caller.
 * @param {string|undefined} type - manifest type.
 * @param {unknown} value - caller value.
 * @returns {unknown} the coerced value, or the input when it cannot be coerced.
 */
export function coerce (type, value) {
  if (value === null || value === undefined) return value
  switch (jsonType(type)) {
    case 'integer': {
      if (typeof value === 'number') return Math.trunc(value)
      if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10)
      return value
    }
    case 'number': {
      if (typeof value === 'number') return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
      return value
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        const lowered = value.trim().toLowerCase()
        if (['true', '1', 'yes', 'on'].includes(lowered)) return true
        if (['false', '0', 'no', 'off'].includes(lowered)) return false
      }
      return value
    }
    default: return value
  }
}

/**
 * Validate caller arguments against an endpoint's declared parameters.
 *
 * Unknown names are rejected rather than forwarded: the portal ignores fields it
 * does not read, so a misspelled `password` for `ap_start` starts an OPEN access
 * point and reports `ok: true`. That failure is silent on the wire and only
 * catchable here.
 * @param {object} endpoint - one manifest entry.
 * @param {Record<string, unknown>} args - caller arguments.
 * @param {{ allowUnknown?: boolean }} [options] - `allowUnknown` for pass-through endpoints.
 * @returns {{ value: Record<string, unknown>, missing: string[], unknown: string[] }}
 */
export function validateArgs (endpoint, args, options = {}) {
  const declared = payloadParams(endpoint)
  const known = new Set(declared.map((param) => param.name))
  const providedFiles = options.providedFiles ?? new Set()
  const value = {}
  const missing = []
  const unknown = []

  for (const [name, raw] of Object.entries(args ?? {})) {
    if (!known.has(name) && pathParams(endpoint).every((param) => param.name !== name)) {
      unknown.push(name)
      if (options.allowUnknown) value[name] = raw
      continue
    }
    const param = declared.find((candidate) => candidate.name === name)
    value[name] = param === undefined ? raw : coerce(param.type, raw)
  }

  for (const param of declared) {
    if (!param.required) continue
    // A `binary` parameter is never an argument — it is a multipart part, so it arrives
    // through `options.files` under the parameter's own name. Checking only `value` made
    // every endpoint with a required file part impossible to call, and said the file was
    // missing while the caller was holding it.
    if (param.type === 'binary') {
      if (!providedFiles.has(param.name)) {
        missing.push(`${param.name} (send it as a file part: files { ${param.name}: <local path> })`)
      }
      continue
    }
    if (value[param.name] === undefined || value[param.name] === null) missing.push(param.name)
  }
  return { value, missing, unknown }
}

/**
 * The request timeout for one call, in milliseconds.
 *
 * Derived from the endpoint's own blocking budget rather than a single global
 * default: `bench/reset` needs ~90 s and `flash` 300 s, while `wifi/ping` answers
 * in milliseconds. A margin is added so the *bench* times out first and the caller
 * receives the portal's diagnosis instead of a bare client abort.
 * @param {object} endpoint - one manifest entry.
 * @param {object} conventions - the manifest's `conventions` block.
 * @param {number} floorMs - configured minimum.
 * @returns {number} timeout in milliseconds.
 */
export function timeoutFor (endpoint, conventions, floorMs) {
  const budgets = conventions?.blocking_budgets_seconds ?? {}
  const budget = endpoint.timeout_s ?? budgets[endpoint.id]
  const seconds = typeof budget === 'number' ? budget : Number.parseFloat(String(budget ?? ''))
  if (!Number.isFinite(seconds) || seconds <= 0) return floorMs
  return Math.max(floorMs, Math.round((seconds + 15) * 1000))
}

/**
 * A one-line signature for progressive disclosure, e.g.
 * `serial_write(slot*, text?, hex?, newline?)`.
 * @param {object} endpoint - one manifest entry.
 * @returns {string}
 */
export function signature (endpoint) {
  const parts = payloadParams(endpoint).map((param) => `${param.name}${param.required ? '*' : '?'}`)
  const placeholders = pathParams(endpoint).map((param) => `${param.name}*`)
  const all = [...placeholders, ...parts]
  return `${endpoint.id}(${all.join(', ')})`
}
