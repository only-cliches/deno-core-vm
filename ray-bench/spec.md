# Ray Bench

Benchmark IPC and parallelism, developed In Typescript.

Help me fill out these question marks:

| Main | IPC             | Worker      | 1024x1024, 4 workers | 1024x1024, 8 workers | 1024x1024, 12 workers | 1024x1024, 16 workers | 1024x1024, 32 workers |
|------|-----------------|-------------|----------------------|----------------------|-----------------------|-----------------------|-----------------------|
| Node | Fn Call         | Node        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | Async Fn Call   | Node        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | postMessage     | Node Worker | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | HTTP            | Node        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | postMessage     | Deno        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | worker.eval     | Deno        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | worker.evalSync | Deno        | ?                    | ?                    | ?                     | ?                     | ?                     |
| Node | worker.handle   | Deno        | ?                    | ?                    | ?                     | ?                     | ?                     |
