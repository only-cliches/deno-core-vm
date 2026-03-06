# Examples

Simple usage examples for `deno-director`.

## Files

- `01-basic-eval.ts`: basic `eval` and `evalSync`.
- `02-eval-module.ts`: `worker.module.eval` and export access.
- `03-globals.ts`: inject globals/functions with `global.set`.
- `04-messages.ts`: worker `postMessage` + host `message` listener.
- `05-imports-callback.ts`: custom import callback and virtual modules.
- `06-https-imports.ts`: remote HTTPS imports.
- `07-node-resolve.ts`: `moduleLoader.nodeResolve` and `nodeCompat`.
- `08-limits.ts`: `limits.maxEvalMs` and memory limits.
- `09-console-routing.ts`: custom console handlers.
- `10-director.ts`: manage multiple workers with `DenoDirector`.
- `11-streams.ts`: byte-stream bridge with `stream.connect(...)` (Node `Duplex` + worker stream lanes).
- `12-handles.ts`: runtime value handles (`handle.get` / `handle.eval` / `handle.tryGet`).

## Running

These examples are intentionally minimal and may require adapting options for your environment.

These files are set up for running inside this repository and import from:

```ts
import { DenoWorker } from "../src/index";
```

If you copy them into an app that installed the package, replace with:

```ts
import { DenoWorker } from "deno-director";
```
