#!/usr/bin/env bash
# Fetch the prebuilt test-partner firmware bundles from the upstream release.
#
# The bench's acceptance suite expects a partner board flashed with upstream's
# `test-firmware/`. CI builds and publishes it, so there is no need for a local
# ESP-IDF toolchain: download the bundle and point the suite at it.
#
#   ./fetch-test-partner.sh                 # both targets
#   ./fetch-test-partner.sh esp32s3         # just the S3
#
# Then run the suite with:
#   WT_TEST_PARTNER_IMAGE=$PWD/.fw/test-partner-esp32s3 \
#     python -m pytest pytest/testbench_test.py --wt-url http://<bench>:8080 --run-dut
#
# Without WT_TEST_PARTNER_IMAGE the suite still runs, but WT-1800 flashes a
# throwaway image over the partner and nothing restores the real one — the next
# run then starts against a board that answers nothing.
set -euo pipefail

TAG="${WT_TEST_PARTNER_TAG:-v1.0.1}"
BASE="https://github.com/SensorsIot/Embedded-AI-Harness/releases/download/${TAG}"

if [ "$#" -gt 0 ]; then
    TARGETS=("$@")
else
    TARGETS=(esp32s3 esp32c3)
fi

cd "$(dirname "$0")"
mkdir -p .fw

for t in "${TARGETS[@]}"; do
    [ -n "$t" ] || continue
    out=".fw/test-partner-${t}"
    if [ -d "$out" ]; then
        echo "== ${t}: already present at ${out}"
        continue
    fi
    echo "== ${t}: downloading ${TAG}"
    curl -fsSL -o ".fw/${t}.tar.gz" "${BASE}/test-partner-${t}.tar.gz" \
        || { echo "   no bundle for ${t} at ${TAG}"; rm -f ".fw/${t}.tar.gz"; continue; }
    tar xzf ".fw/${t}.tar.gz" -C .fw
    rm -f ".fw/${t}.tar.gz"
    echo "   extracted to ${out}"
    ls -l "$out"
done

echo
echo "Point the suite at one of these, e.g.:"
echo "  WT_TEST_PARTNER_IMAGE=\$PWD/.fw/test-partner-esp32s3 python -m pytest pytest/testbench_test.py \\"
echo "      --wt-url http://<bench>:8080 --run-dut"
