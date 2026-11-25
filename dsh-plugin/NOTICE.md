# Provenance and licence

## Upstream work

The 16 skills in `skills/` are **derived from**
[SensorsIoT/Embedded-AI-Harness](https://github.com/SensorsIot/Embedded-AI-Harness),
specifically its `.claude/skills/` directory, and remain under its MIT licence:

> MIT License
>
> Copyright (c) 2026 Sensors IoT
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

The full upstream text is retained at
`claude_git_repo/Embedded-AI-Harness-main/LICENSE` in the parent repository.

### What was changed in the skills

Byte-for-byte copies, then four mechanical adaptations. All of them are visible in
the files themselves:

| Change | Scope | Reason |
|---|---|---|
| `## Step 0: Point at a bench` replaced with tool guidance | the 5 `testbench-*` skills | The bench address is the preset's `baseUrl`; there is no environment variable to export and no mDNS to fail on |
| `.claude/skills/` → `skills/` | 9 files | Path layout inside this preset |
| `CLAUDE.md` → `AGENTS.md` | 5 files | This harness reads `AGENTS.md` first and falls back to `CLAUDE.md`; either works |
| A "In this harness" note added after the frontmatter | `define`, `harness`, `commission`, `build` | Maps `/name` to the skill, and the fresh-checker rule to `subagent` / `workflow` / `ralph` |

The `curl` command blocks were **kept deliberately**. They are the wire protocol
underneath the plugin's tools, and the exact field names and `ok` semantics are what
the instrument skills are about. Each affected skill now says so.

## Original work

- `agent.cordis.yml`, `preset.yml` — the composition
- `plugin/` — the tools, transport, endpoint registry, prompt section
- `docs/User-Manual.md`, `README.md`, this file
- `tools/selftest.mjs`, `install.sh`

## Data derived from the bench

`plugin/manifest.json` and the `TESTBENCH-PLUGIN-API.md` it accompanies were produced
by commissioning a specific Raspberry Pi testbench and reconciling its `pi/portal.py`
against live responses. Where upstream documentation and the portal code disagree, the
code wins and the manifest records it. That reconciliation is the most valuable
artefact in the parent repository, and this plugin treats it as the source of truth.

## Not affiliated

This preset is not affiliated with or endorsed by Sensors IoT / Andreas Spiess.
