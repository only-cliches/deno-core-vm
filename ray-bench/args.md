| Argument | Type / Example | Default | What It Changes In The Test | Practical Effect On Results |
  |---|---|---:|---|---|
  | --width | int, e.g. 1024 | 1024 | Image width in pixels for every render task | Higher width increases per-task compute cost (more pixel work), so transport overhead matters less. |
  | --height | int, e.g. 1024 | 1024 | Image height and number of vertical tiles | Higher height increases total work and task count (via tiling), usually raising total runtime. |
  | --tile | int, e.g. 16 | 16 | Tile height in pixels for each task | Smaller tile => more tasks => more scheduling/IPC overhead. Larger tile => fewer, heavier tasks => more “pure compute” benchmark. |
  | --workers | CSV, e.g. 4,8,12,16 | 4,8,12,16,32 | Worker-count sweep per scenario | Changes parallelism and contention. Past core count, overhead/context switching can dominate. |
  | --iterations | int, e.g. 3 | 1 | Timed repetitions per scenario/worker combo | Higher values reduce noise; benchmark reports median of these runs. |
  | --warmup | int, e.g. 1 | 0 | Untimed runs before measurement | Helps stabilize JIT/caches; reduces first-run bias. |
  | --scenarios | CSV keys, e.g. node-postmessage,deno-streams-reused | all scenarios | Which IPC/runtime paths are tested | Lets you isolate one path and avoid cross-scenario runtime effects. |
  | --format | plain or markdown | plain | Output rendering only | No performance impact; just table style. |