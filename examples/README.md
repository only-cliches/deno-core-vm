# Examples

Run these first to see the core behavior quickly.

## What Each Example Proves

- `01-basic-eval.ts`: run code in Deno from Node with `eval` and `evalSync`.
- `02-eval-module.ts`: evaluate module source and call exported functions.
- `03-globals.ts`: expose Node values/functions through `worker.global`.
- `04-messages.ts`: event-style messaging (`postMessage` + `on("message")`).
- `05-imports-callback.ts`: intercept and rewrite module imports dynamically.
- `05-imports-callback.ts`: intercept and rewrite module imports dynamically (including `{ src, srcLoader }` virtual modules).
- `06-https-imports.ts`: allow and use remote HTTPS module imports.
- `07-node-resolve.ts`: enable Node-style module resolution where needed.
- `08-limits.ts`: enforce runtime limits and timeout boundaries.
- `09-console-routing.ts`: route/silence sandbox console output.
- `10-director.ts`: orchestrate multiple workers with labels/tags (great base for serverless-style warm pools).
- `11-streams.ts`: move raw bytes over the stream bridge (`Duplex` on Node side).
- `12-handles.ts`: operate on long-lived runtime object graphs with handles.
- `13-serverless-style.ts`: Node HTTP server that routes by `Host` header to warm runtime pools.
- `14-custom-loaders.ts`: chain custom loader callbacks to alias, override, or block loader modes.

## Run One

From repo root:

```bash
npx tsx examples/01-basic-eval.ts
```

Swap the filename to run any other example.

## Import Path Note

Inside this repo, examples import from source:

```ts
import { DenoWorker } from "../src/index";
```

In a normal app that installed the package, use:

```ts
import { DenoWorker } from "deno-director";
```
