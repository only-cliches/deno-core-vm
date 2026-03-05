#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IPC_BENCH_DIR="$ROOT_DIR/ipc-bench"

RUN_BUILD="${RUN_BUILD:-1}"
RUNS="${RUNS:-3}"
WARMUP="${WARMUP:-2}"
ITERATIONS="${ITERATIONS:-5}"
SCENARIOS="${SCENARIOS:-node+deno-stream,node+deno-postmessage,node+deno-handle,node+deno-eval}"
MATRIX="${MATRIX:-2048:512 65536:256 1048576:128}"

# Enable native stream plane by default for stream transport measurements.
export DENO_DIRECTOR_NATIVE_STREAM_PLANE="${DENO_DIRECTOR_NATIVE_STREAM_PLANE:-1}"

if [[ "$RUN_BUILD" == "1" ]]; then
  echo "== build =="
  (cd "$ROOT_DIR" && npm run -s build)
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for case in $MATRIX; do
  bytes="${case%%:*}"
  messages="${case##*:}"
  out_file="$tmp_dir/bench-${bytes}-${messages}.log"

  echo "== sweep bytes=$bytes messages=$messages scenarios=$SCENARIOS =="
  for ((run=1; run<=RUNS; run++)); do
    echo "-- run $run/$RUNS --"
    (
      cd "$IPC_BENCH_DIR"
      npm run -s bench -- \
        --bytes "$bytes" \
        --messages "$messages" \
        --warmup "$WARMUP" \
        --iterations "$ITERATIONS" \
        --scenarios "$SCENARIOS"
    ) | rg "^done:" | tee -a "$out_file"
  done

  echo "-- median MB/s (bytes=$bytes messages=$messages) --"
  awk '
    /^done:/ {
      n = split($0, parts, " -> ");
      if (n != 2) next;
      label = parts[1];
      sub(/^done: /, "", label);
      split(parts[2], right, " ");
      mb = right[1] + 0;
      key_count[label]++;
      vals[label, key_count[label]] = mb;
    }
    END {
      for (label in key_count) {
        c = key_count[label];
        delete arr;
        for (i = 1; i <= c; i++) arr[i] = vals[label, i];
        asort(arr);
        if (c % 2 == 1) med = arr[(c + 1) / 2];
        else med = (arr[c / 2] + arr[c / 2 + 1]) / 2;
        printf("%s -> %.1f MB/s (n=%d)\n", label, med, c);
      }
    }
  ' "$out_file" | sort
  echo

done
