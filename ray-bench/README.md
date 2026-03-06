# ray-bench

Deterministic raytracer benchmark that mirrors the IPC scenario matrix used by `ipc-bench`.

Each scenario defines:
- orchestration runtime (`node`, `bun`, or `deno`)
- worker runtime (`node`, `bun`, or `deno`)
- transport (`direct.fn`, `postMessage`, `HTTP`, `worker.eval`, `worker.handle`, `worker.stream.connect`)

## Scenario list

`ray-bench` supports these `ScenarioKey` values:

- `node-node-fn`
- `node+node-postmessage`
- `node+node-http`
- `node+deno-postmessage`
- `node+deno-eval`
- `node+deno-handle`
- `node+deno-stream`
- `bun+bun-postmessage`
- `bun+bun-http`
- `deno+deno-postmessage`
- `deno+deno-http`

When running with `--workers-list`, all selected scenarios run for each worker-count value.

## Usage

```bash
cd ray-bench
npm run bench
```

## Flags

- `--width <n>` image width (default `640`)
- `--height <n>` image height (default `360`)
- `--samples <n>` samples per pixel (default `8`)
- `--max-depth <n>` ray bounce depth (default `6`)
- `--workers <n>` run one worker-count value
- `--workers-list <a,b,c>` compare multiple worker counts (default `1,2,4`)
- `--warmup <n>` warmup passes before timing (default `1`)
- `--iterations <n>` measured passes per worker count (default `3`)
- `--scenarios <csv>` subset of scenario keys to run (default: all)

## Examples

```bash
# full matrix on two worker counts
npm run bench -- --workers-list 1,2 --width 320 --height 180 --samples 2 --max-depth 3 --warmup 1 --iterations 2

# one scenario only
npm run bench -- --workers 4 --scenarios node+deno-stream --width 640 --height 360 --samples 4 --max-depth 5
```
