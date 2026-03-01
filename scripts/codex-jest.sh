#!/usr/bin/env bash
set -euo pipefail

mkdir -p codex

SPEC="${CODEX_JEST_SPEC:-test-ts/promises.spec.ts}"

# Keep both console output and a stable file Codex can read.
# Use PIPESTATUS to preserve Jest's exit code.
set +e
npx jest "$SPEC" 2>&1 | tee codex/jest-output.txt
JEST_EXIT=${PIPESTATUS[0]}
set -e

exit "$JEST_EXIT"
