/**
 * A local `defineTool`, so this plugin has no package dependencies at all.
 *
 * Why not import the harness's own `@deepseek-ai/dsh-tools`? Because of how a
 * locally authored preset is loaded. The preset loader resolves a row's specifier —
 * a bare package name from the harness install, a relative path from the preset's
 * own directory — but a *module's own* imports are resolved by Node from wherever
 * that file sits. A plugin under `${DSH_HOME}/.agent-presets/<id>/plugin/` is
 * therefore outside the harness's `node_modules` walk, and a bare
 * `import '@deepseek-ai/dsh-tools'` there fails with ERR_MODULE_NOT_FOUND.
 *
 * The alternatives were a `node_modules` symlink planted in the preset directory or
 * an install step that writes into the application tree — both of which break on an
 * upgrade or surprise whoever deploys this. `tools.register` only requires
 * `{ name, parameters, output: { schema, render } }` with a JSON Schema this
 * package already produces, so the dependency is avoidable, and avoiding it is the
 * difference between "copy this directory and select the preset" and "run this
 * installer first".
 *
 * @module esp-aiclp/tool
 */

/**
 * Build a registry-ready tool definition.
 *
 * Mirrors the harness's `defineTool` for the part this plugin uses: it takes the
 * same option names and returns the same shape, minus the parameter-spec
 * compilation (this plugin declares plain JSON Schema, which the registry accepts
 * directly) and minus the deep argument validation (the bench manifest is the real
 * contract, and `client.js` validates against it before a request is sent).
 *
 * The one validation kept here is required-field presence, because a missing
 * argument deserves the tool's own name in the error rather than a downstream
 * failure naming an endpoint the model never mentioned.
 * @param {object} options - the definition.
 * @param {string} options.name - tool name.
 * @param {string} options.description - model-facing description.
 * @param {object} [options.parameters] - JSON Schema properties map.
 * @param {{ schema: object, render: Function }} options.output - output contract.
 * @param {Function} options.execute - `(args, exec) => Promise<value> | value`.
 * @param {(args: object) => boolean} [options.isConcurrencySafe] - parallel-eligibility.
 * @returns {object} a definition accepted by `ctx.tools.register`.
 */
export function defineTool (options) {
  const parameters = options.parameters ?? {}
  const required = Object.entries(parameters)
    .filter(([, spec]) => spec !== null && typeof spec === 'object' && spec.required === true)
    .map(([name]) => name)
  const enumerated = Object.entries(parameters)
    .filter(([, spec]) => spec !== null && typeof spec === 'object' && Array.isArray(spec.enum))
    .map(([name, spec]) => [name, spec.enum])

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: options.output,
    ...options.isConcurrencySafe !== undefined
      ? {
          // Without this the registry treats every call as exclusive; declaring it
          // lets read-only tools share a turn.
          isConcurrencySafe: (args) => {
            try {
              return options.isConcurrencySafe(args ?? {}) === true
            } catch {
              return false
            }
          },
        }
      : {},
    async execute (args, exec) {
      const supplied = args ?? {}
      const missing = required.filter((name) => supplied[name] === undefined || supplied[name] === null)
      if (missing.length > 0) {
        throw new Error(`${options.name}: missing required argument${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`)
      }
      // Catch a value outside the declared set here rather than at the portal: the
      // round trip answers "unknown mode 'debug'" naming a field the caller did supply,
      // and the fix is to read the enum the tool already published.
      for (const [name, allowed] of enumerated) {
        const value = supplied[name]
        if (value === undefined || value === null) continue
        if (!allowed.includes(value)) {
          throw new Error(`${options.name}: ${name} must be one of ${allowed.join(' | ')} — got ${JSON.stringify(value)}`)
        }
      }
      return options.execute(supplied, exec)
    },
  }
}
