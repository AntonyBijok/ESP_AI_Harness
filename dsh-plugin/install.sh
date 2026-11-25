#!/usr/bin/env bash
# Install the ESP32 AICLP preset into the user's preset root.
#
# The preset root is `${DSH_HOME:-$HOME/.dsh}/.agent-presets/`. A preset is one
# directory holding an `agent.cordis.yml` and a `preset.yml`; everything it needs —
# the plugin, the skills, the vendored manifest — travels inside that directory,
# which is why there is no package manager step here.
#
# Re-running replaces the installed copy. Nothing in this directory is generated, so
# the workspace copy is the source of truth: edit here, then install.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PRESET_ID="${PRESET_ID:-esp-aiclp}"
TARGET="$DSH_HOME_DIR/.agent-presets/$PRESET_ID"

if [[ ! -f "$HERE/agent.cordis.yml" ]]; then
  echo "install: $HERE does not look like the plugin root (no agent.cordis.yml)" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"

if [[ -e "$TARGET" ]]; then
  echo "install: replacing existing preset at $TARGET"
  rm -rf "$TARGET"
fi

mkdir -p "$TARGET"
cp -R "$HERE/agent.cordis.yml" "$HERE/preset.yml" "$HERE/plugin" "$HERE/skills" "$TARGET/"

# Documentation and the self-test travel with the preset, so the installed copy can be
# read and verified in place — `node <target>/tools/selftest.mjs` needs nothing else.
for extra in docs tools README.md NOTICE.md; do
  if [[ -e "$HERE/$extra" ]]; then cp -R "$HERE/$extra" "$TARGET/"; fi
done

chmod -R u+rwX,go-rwx "$TARGET"

echo "install: $PRESET_ID → $TARGET"
echo
echo "  composition : $TARGET/agent.cordis.yml"
echo "  plugin      : $(find "$TARGET/plugin" -name '*.js' | wc -l) modules, $(find "$TARGET/plugin" -name 'manifest.json' | wc -l) manifest"
echo "  skills      : $(find "$TARGET/skills" -name SKILL.md | wc -l) skills"
echo "  bench       : $(grep -oE 'baseUrl: .*' "$TARGET/agent.cordis.yml" | head -1)"
echo
echo "Next: select \"ESP32 AICLP\" for a session. Verify the installed copy with:"
echo "  node $TARGET/tools/selftest.mjs"
