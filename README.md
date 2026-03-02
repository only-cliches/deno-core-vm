# deno-director
Run Deno Core runtimes inside Node.js, with first-class bridging in both directions.

## Why this exists
`deno-director` lets you keep Node as your host process while spinning up managed Deno runtimes for:

- isolated code execution
- module evaluation with import control
- fast function calls across the Node <-> Deno boundary
- multi-runtime orchestration (`DenoDirector`)

## Quick Start
Super high-level flow: install, create a worker, run code, bridge functions both ways.

```bash
npm install deno-director
```

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  imports: true,
  permissions: { import: true },
});

// 1) plain eval
console.log(await dw.eval("1 + 1")); // 2

// 2) Node -> Deno: call exported module function
const math = await dw.evalModule(`
  export function add(a, b) { return a + b; }
`);
console.log(math.add(2, 3)); // 5

// 3) Deno -> Node: inject Node function, call it from Deno
await dw.setGlobal("triple", (n: number) => n * 3);
console.log(await dw.eval("triple(14)")); // 42

await dw.close();
```

## Major Features

### 1) Virtual Modules (`imports` callback)
<details>
<summary>How it works + usage</summary>

Use the `imports` callback to intercept specifiers and return in-memory module source.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker({
  permissions: { import: true },
  imports: (specifier) => {
    if (specifier === "virtual:config") {
      return {
        js: `export const env = "dev"; export const retries = 3;`,
      };
    }
    return false; // block anything else (or return true to allow default disk resolution)
  },
});

const result = await dw.evalModule(`
  import { env, retries } from "virtual:config";
  moduleReturn(\`\${env}:\${retries}\`);
`);

console.log(result); // "dev:3"
await dw.close();
```

What to know:

- Return `false` to block an import.
- Return `true` to allow default resolution.
- Return `{ js | ts | tsx | jsx }` to provide source in memory.
- Return `{ resolve: "..." }` to rewrite to another specifier.

</details>

### 2) Call Deno Module Functions from Node
<details>
<summary>How it works + usage</summary>

`evalModule(...)` returns a namespace object. Exported functions can be called directly from Node.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

const mod = await dw.evalModule(`
  export const version = "1.0.0";
  export function sum(a, b) { return a + b; }
  export async function slowDouble(n) {
    await Promise.resolve();
    return n * 2;
  }
`);

console.log(mod.version); // "1.0.0"
console.log(mod.sum(20, 22)); // 42
console.log(await mod.slowDouble(21)); // 42

await dw.close();
```

You can also use default exports:

```ts
const mod = await dw.evalModule(`
  export default function multiply(a, b) { return a * b; }
`);

console.log(mod.default(6, 7)); // 42
```

</details>

### 3) Create Node Functions Callable from Deno
<details>
<summary>How it works + usage</summary>

Inject host functions with `setGlobal`, then call/await them inside Deno.

```ts
import { DenoWorker } from "deno-director";

const dw = new DenoWorker();

await dw.setGlobal("double", (n: number) => n * 2);
await dw.setGlobal("fetchUser", async (id: string) => {
  return { id, name: "Ada" };
});

const out = await dw.eval(`
  (async () => {
    const n = double(21);
    const user = await fetchUser("u_123");
    return { n, user };
  })()
`);

console.log(out); // { n: 42, user: { id: "u_123", name: "Ada" } }
await dw.close();
```

If a Node function throws, the error is propagated back through `eval(...)`.

</details>

### 4) Runtime Templates and Orchestration
<details>
<summary>How it works + usage</summary>

Use `DenoWorkerTemplate` for reusable runtime defaults and `DenoDirector` to manage multiple runtimes with ids/labels/tags.

```ts
import { DenoDirector } from "deno-director";

const director = new DenoDirector({
  template: {
    workerOptions: {
      permissions: { env: true },
    },
    globals: { APP_NAME: "director-demo" },
  },
});

const a = await director.start({ label: "tenant-a", tags: ["billing"] });
const b = await director.start({ label: "tenant-b", tags: ["analytics"] });

console.log(await a.eval("APP_NAME")); // "director-demo"
console.log(director.list({ tag: "billing" }).length); // 1

await director.stopAll();
```

</details>

## API Snapshot

- `new DenoWorker(options?)`
- `dw.eval(src, options?)`
- `dw.evalSync(src, options?)`
- `dw.evalModule(src, options?)`
- `dw.setGlobal(key, value)`
- `dw.postMessage(msg)` / `dw.on("message", cb)`
- `dw.restart(options?)`
- `dw.close(options?)`
- `new DenoWorkerTemplate(options?)`
- `new DenoDirector(options?)`

## Local Development

```bash
npm install
npm test
```

Build scripts:

- `npm run build-debug`
- `npm run build-release`

## Notes

- This package builds a native addon during install (`cargo` + Rust toolchain required).
- For module imports, configure `imports` and related permissions/options based on your use case.
