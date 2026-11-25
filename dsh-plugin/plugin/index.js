/**
 * The ESP AI Closed-Loop Programming plugin for the DeepSeek Harness.
 *
 * One row in an agent preset, and a session gains: 25 bench tools generated from the
 * bench's own API manifest, a prompt section carrying the loop discipline, and the
 * skills that procedure lives in. Nothing here is a separate server or a second
 * process — the tools are registered into this harness's own tool registry, so they
 * appear in the catalog, in the GUI, and to subagents with no bridging.
 *
 * ## What it does not depend on
 *
 * This plugin imports **only Node builtins and its own files**. A locally authored
 * preset lives under the user's home, where Node's `node_modules` walk never reaches
 * the harness install, so a bare `@deepseek-ai/…` import would fail with
 * ERR_MODULE_NOT_FOUND. See `tool.js` for why that constraint turned out to be an
 * advantage rather than a workaround: the registry's real contract is small, and
 * meeting it directly means this directory can be copied into any deployment and
 * selected, with no install step.
 *
 * ## Configuration
 *
 * Every value has a default taken from the vendored manifest, so an empty row works:
 *
 * ```yaml
 * - id: esp-aiclp
 *   name: ./plugin/index.js
 *   config:
 *     baseUrl: http://192.168.0.29:8080
 * ```
 *
 * @module esp-aiclp
 */
import { readFile } from 'node:fs/promises'
import { loadManifest } from './manifest.js'
import { createClient } from './client.js'
import { registerCoreTools } from './tools/core.js'
import { registerDispatchTools } from './tools/dispatch.js'
import { AICLP_SECTION, AICLP_SECTION_NAME, AICLP_SECTION_ORDER } from './prompt.js'

/** Cordis plugin name. */
export const name = 'esp-aiclp'

/** Services this row contributes to. */
export const inject = ['tools', 'systemPrompt']

/** Largest file this plugin will read for an upload (flash images are single-digit MB). */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/**
 * Register the bench tools and the loop's prompt section.
 * @param {object} ctx - the preset's mounting context.
 * @param {object} [config] - this row's configuration.
 * @returns {void}
 */
export function apply (ctx, config = {}) {
  const manifest = loadManifest()
  const benchUrl = String(config.baseUrl ?? manifest.manifest.bench?.base_url ?? 'http://localhost:8080').replace(/\/+$/, '')

  // Read through the harness `fs` service when one is mounted, so an upload honours
  // the same observation policy as the file tools. `ctx.get` because a preset may
  // legitimately mount on a host without it.
  const fs = ctx.get('fs')

  /**
   * Read bytes for an upload part.
   * @param {string} path - caller-supplied path.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Uint8Array>}
   */
  async function readBytes (path, signal) {
    if (fs === undefined) return new Uint8Array(await readFile(path, { signal }))
    const target = await fs.resolve(path, { cwd: process.cwd(), signal })
    return fs.readBytes(target, signal, MAX_UPLOAD_BYTES)
  }

  /**
   * Read text (a build's `flash_args`).
   * @param {string} path - caller-supplied path.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>}
   */
  async function readText (path, signal) {
    if (fs === undefined) return readFile(path, { encoding: 'utf8', signal })
    const target = await fs.resolve(path, { cwd: process.cwd(), signal })
    return fs.readText(target, signal)
  }

  const client = createClient({
    baseUrl: benchUrl,
    manifest,
    floorTimeoutMs: config.floorTimeoutMs ?? 15_000,
    readFile: readBytes,
  })

  const resolved = {
    ...config,
    // The lease `owner` is how an operator sees this session in `GET /api/slot/mode`,
    // so it is named after the agent preset rather than a generic string.
    owner: config.owner ?? 'dsh-esp-aiclp',
    readText,
    readBytes,
  }

  registerCoreTools({ ctx, client, manifest, config: resolved })
  registerDispatchTools({ ctx, client, manifest, config: resolved })

  if (config.section !== false) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: AICLP_SECTION_NAME,
      order: AICLP_SECTION_ORDER,
      text: config.sectionText ?? AICLP_SECTION,
    }), 'esp-aiclp.prompt-section')
  }

  ctx.logger?.info(
    `esp-aiclp: bench at ${benchUrl}, ${manifest.endpoints.length} endpoints in the manifest, ` +
    `${manifest.endpoints.filter((endpoint) => endpoint.availability === 'available' || endpoint.availability === 'partial').length} callable`,
  )
}
