#!/usr/bin/env bash
set -euo pipefail

mkdir -p codex

START_FILE="codex/start-ts.txt"
LIMIT_SECONDS="${LIMIT_SECONDS:-1200}"

# Create the start timestamp once per run (or reuse if it exists).
if [[ ! -f "$START_FILE" ]]; then
  date +%s > "$START_FILE"
fi

read -r START_TS < "$START_FILE"

check_time() {
  local now elapsed
  now="$(date +%s)"
  elapsed=$((now - START_TS))
  if (( elapsed > LIMIT_SECONDS )); then
    echo "Time limit exceeded: ${elapsed}s > ${LIMIT_SECONDS}s. Stopping."
    exit 0
  fi
}

while true; do
  check_time

  echo "== Step A: Jest (log-driven) =="
  set +e
  scripts/codex-jest.sh
  JEST_EXIT=$?
  set -e

  check_time

  if [[ $JEST_EXIT -eq 0 ]]; then
    echo "No failing tests. Stopping."
    exit 0
  fi

  echo "Failing tests detected. Fix in /src guided by codex/jest-output.txt."
  echo "== Step D: build-debug =="
  npm run build-debug

  check_time
done