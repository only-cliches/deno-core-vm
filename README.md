<div align="center">

# 🦕 Deno Director 🎬

**Embed, Orchestrate, and Sandbox Deno V8 Isolates Directly Inside Node.js.**

</div>

[![GitHub Repo stars](https://img.shields.io/github/stars/only-cliches/deno-director)](https://github.com/only-cliches/deno-director)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Node.js is legendary. Deno is secure by default. **What if you didn't have to choose?**

**Deno Director** is a native Rust/Neon module that embeds the Deno runtime natively into your Node.js process. It allows you to spin up lightning-fast, heavily sandboxed, completely isolated V8 threads, and control them from Node.js.

Whether you are building a multi-tenant edge-compute platform, executing untrusted third-party code, or just want to use Deno's native TypeScript and URL-import capabilities inside your legacy Node.js monolith, Deno Director is the ultimate weapon.

## 🔥 Why Deno Director?

* **Zero-Serialization Friction:** Unlike standard IPC, Deno Director uses a highly optimized native bridge. Pass `Map`, `Set`, `ArrayBuffer`, `Date`, `RegExp`, native `Error` objects, **recursive values**, and even **Functions** across the Node/Deno boundary without losing fidelity.
* **Wield Host Functions:** Pass a Node.js function *into* the Deno sandbox. Call it from Deno, and it executes in Node. Synchronously or asynchronously.
* **Ironclad Sandboxing:** Every worker is a Deno isolate. You have absolute control over `read`, `write`, `net`, `env`, and `ffi` permissions. Lock it down.
* **Native TypeScript & JSX:** Evaluate TS/JSX directly in `eval`, `evalSync`, `worker.module.eval`, and import pipelines. No build step required. Deno Director handles transpilation on the fly.
* **Fleet Orchestration:** Spin up thousands of runtimes. Tag them, label them, and manage their lifecycles seamlessly with the built-in `DenoDirector` orchestration class.
* **Telemetry:** Extract granular V8 heap space statistics and exact CPU/Wall-clock execution times for every script evaluation.

## 💡 How it works

- **One Node.js process** hosts **many Deno runtimes**.
- Each `DenoWorker` is a **separate V8 isolate** (and is treated as an isolated runtime boundary within the same process).
- Calls and values cross the Node and Deno boundary using a **native bridge** backed by V8 serialization plus function bridging for host callbacks.
- You control **Deno permissions** per worker (`read`, `write`, `net`, `env`, `ffi`, `sys`) plus optional host side policies like import interception and console routing.
- You can enforce **timeouts and memory limits** per worker, and capture execution stats per evaluation.

---

## 🚀 Quick Start

```bash
npm install deno-director

```

### 🚀 The Basics: Evaluated TS and Host Callbacks

```ts
import { DenoWorker } from "deno-director";

// 1. Boot a locked-down V8 isolate
const worker = new DenoWorker({
    // Deno cannot touch the network or the disk. It only knows what we feed it.
    permissions: { net: false, read: false, env: false },
    // automatically compile any TS provided to the runtime.
    transpileTs: true
});

// 2. Drop an ASYNC Node.js function into Deno's global scope
await worker.global.set("hostFetchData", async (userId: string) => {
    console.log(`[Node.js] Deno asked for data for ${userId}. Fetching securely...`);

    // Simulate an async database or API call on the Node side
    await new Promise(resolve => setTimeout(resolve, 500));
    return { id: userId, secret: "super_classified_payload" };
});

// 3. Inject an ES Module into Deno
// Notice how Deno seamlessly awaits the Node.js function we just injected!
const sandbox = await worker.module.eval(`
    export async function processUser(userId) {

        console.log(\`[Deno] Initiating secure processing for \${userId}...\`);

        // Call the async Node.js function from inside the isolated Deno sandbox
        const rawData: {  // TS is OK!
          id: string,
          secret: string 
        } = await globalThis.hostFetchData(userId);
        
        // Return the processed data back to Node
        return { 
            status: "SECURED", 
            originalId: rawData.id,
            fingerprint: btoa(rawData.secret).substring(0, 12) 
        };
    }
`);

// 4. Node.js calls the Deno exported module function
console.log("[Node.js] Triggering Deno sandbox...");
const result = await sandbox.processUser("user_999");

console.log("[Node.js] Final Result from Deno:", result);
// Result: { status: 'SECURED', originalId: 'user_999', fingerprint: 'c3VwZXJfY2xh' }

await worker.close();

```

### 🧭 Fleet Orchestration: Managing 1,000 Tenants

Use the `DenoDirector` to orchestrate massive fleets of sandboxed runtimes.

```ts
import { DenoDirector } from "deno-director";

const director = new DenoDirector({
  template: {
    // Base configuration for ALL workers
    workerOptions: { limits: { maxMemoryBytes: 128 * 1024 * 1024 } }, // 128MB limit
    bootstrapScripts: ["globalThis.APP_RUNTIME = 'DenoDirector';"]
  }
});

// Start a runtime for a specific tenant
const tenantA = await director.start({
  label: "tenant-a",
  tags: ["premium-tier", "us-east"],
  globals: { TENANT_ID: "A" }
});

await tenantA.eval(`console.log("Hello from", TENANT_ID)`);

// Query and manage your fleet
const premiumRuntimes = director.list({ tag: "premium-tier" });
console.log(`Active premium runtimes: ${premiumRuntimes.length}`);

// Nuke a specific tenant
await director.stopByLabel("tenant-a");

```

---

## 🧠 Major Capabilities

### 🌉 The Transdimensional Bridge

When you pass data between Node and Deno using `eval`, `evalSync`, or `global.set`, Deno Director doesn't just `JSON.stringify`. It uses a complex custom codec backed by V8 serialization.

* `NaN`, `Infinity`, `-0`? Preserved.
* `Uint8Array`, `DataView`, `SharedArrayBuffer`? Passed instantly via underlying memory views.
* Promises? Automatically chained across the boundary.

### 📦 ES Module Proxying

Don't just evaluate strings—import entire ES modules and use them as if they were native Node.js objects.

```ts
// Deno dynamically imports the code, and Node gets a fully typed proxy namespace!
const mod = await worker.module.eval(`
  export const version = "1.0.0";
  export function encrypt(data) { return btoa(data); }
`);

console.log(mod.version); // "1.0.0"
console.log(await mod.encrypt("secret")); // "c2VjcmV0"

```

If you already have a module specifier, use `worker.module.import(...)`:

```ts
const worker = new DenoWorker({
  modules: { // declare available modules
    "app:math": "export const add = (a: number, b: number) => a + b;",
  },
  imports: false, // block all non-registered imports; only `modules` entries are resolvable
});

const math = await worker.module.import("app:math");
console.log(await math.add(2, 3)); // 5

// throws:
const another_module = await worker.module.import("another_module");

await worker.close();
```

When you need dynamic resolution (instead of a fixed allowlist in `modules`), use the `imports` interceptor.

### 🪄 Magic Module Resolution: The `imports` Interceptor

By default, Deno resolves modules from the disk or network. But with Deno Director, you can completely hijack the ES Module graph. Every time the Deno sandbox encounters an `import` statement, it pauses and asks your Node.js host exactly what to do.

You can use the `imports` callback to rewrite specifiers, block malicious network requests, or even serve **virtual modules directly from memory**. Because the callback can be `async`, you have the full power of Node.js at your fingertips to fetch, compile, and cache code on the fly.

**What it looks like inside the Deno Sandbox:**
From Deno's perspective, everything is just standard ECMAScript. It has no idea you are pulling the strings behind the scenes.

```ts
// Inside Deno:
import { sum } from "./math.ts";                   // Normal relative import
import { db } from "app:database";                 // Custom URL scheme!
const Secret = await import("untrusted-dynamic");  // Dynamic import

```

**What it looks like on the Node.js Host:**
Let's build an interceptor that blocks dynamic imports for security, uses a custom in-memory cache, and compiles a proprietary module scheme (`app:`) on the fly.

```ts
import { DenoWorker } from "deno-director";

// A simple in-memory cache on the Node side
const moduleCache = new Map<string, string>();

const worker = new DenoWorker({
  transpileTs: true, // We want Deno Director to transpile TS/JSX
  
  // The ultimate import interceptor
  imports: async (specifier, referrer, isDynamicImport) => {
    console.log(`[Deno] requesting: ${specifier} (from ${referrer})`);

    // 1. Security: Block ALL dynamic imports (const y = await import("..")) to prevent code-injection attacks
    if (isDynamicImport) {
      console.warn(`Blocked dynamic import of ${specifier}`);
      return false; // false = block module with error
    }

    // 2. Custom Scheme: Intercept "app:*" imports and compile them on the fly
    if (specifier.startsWith("app:")) {
      const moduleName = specifier.replace("app:", "");
      
      // Check our Node-side cache first!
      if (moduleCache.has(moduleName)) {
        return { ts: moduleCache.get(moduleName)! }; // Serve from memory
      }

      // Simulate fetching or compiling custom code (e.g., from a DB or remote API)
      const compiledTsCode = `export const ${moduleName} = "Super Secret Data for ${moduleName}";`;
      
      // Save to cache
      moduleCache.set(moduleName, compiledTsCode);

      // Feed it source code directly into Deno's memory as a TypeScript module!
      return { ts: compiledTsCode }; 
    }

    // 3. Fallback: Allow normal resolution for everything else
    return true; 
  }
});

// Run it! Deno will hit our interceptor for "app:database"
const result = await worker.module.eval(`
  import { database } from "app:database";
  export function getData() {
    return database;
  }
`);

console.log(await result.getData()); // "Super Secret Data for database"

```

**The resulting superpower:** You can seamlessly integrate tools like Webpack, SWC, or esbuild on the Node.js side, transpile custom DSLs, and feed the resulting raw code directly into the isolated Deno runtime without ever touching the disk.

### 🎛️ Runtime Handles

Handles let you keep a live reference to a runtime value and operate on it without re-evaluating lookup code each time. This is useful for complex object graphs, long-lived instances, and high-frequency operations.

Entry points:
- `worker.handle.get(path, options?)` -> bind to an existing runtime value (throws if path does not exist)
- `worker.handle.tryGet(path, options?)` -> same as `get` but returns `undefined` when missing
- `worker.handle.eval(source, options?)` -> evaluate source and bind the result as a handle root

Once you have a handle, you can call methods like: `get`, `set`, `has`, `delete`, `keys`, `entries`, `call`, `construct`, `await`, and many more!

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker();

await worker.eval(`
  globalThis.counter = {
    value: 0,
    inc(n = 1) { this.value += n; return this.value; }
  };
`);

const h = await worker.handle.get("counter");
await h.call("inc", [2]);                 // 2
await h.set("value", 10);
console.log(await h.get("value"));        // 10
console.log(await h.getType());           // { type: "object", ... }
console.log(h.rootType);                  // cached root type snapshot

await h.dispose();
await worker.close();
```

### 🥷 Smuggling Node.js Modules into Deno

Because Deno Director utilizes a recursive V8 serializer and native function bridging, you can literally inject entire Node.js core modules (or any complex object with methods) directly into the Deno sandbox.

Deno Director will automatically walk the object's enumerable properties, wrapping all functions into blazing-fast native bridges.

```ts
import fs from "node:fs";
import crypto from "node:crypto";
import { DenoWorker } from "deno-director";

const worker = new DenoWorker({
  // Deno's native file reading is blocked...
  permissions: { read: false }
});

// ...but we can smuggle Node's `fs` module in anyway!
await worker.global.set("nodeFs", fs);
await worker.global.set("nodeCrypto", crypto);

const result = await worker.eval(`
  // Calling Node.js fs functions from inside Deno!
  const cwdEntries = nodeFs.readdirSync(".");
  const payload = new TextEncoder().encode(String(cwdEntries.length));
  
  // Calling Node's crypto module from Deno
  // this function runs in the NODE context!
  const hash = nodeCrypto.createHash("sha256");
  hash.update(payload);
  hash.digest("hex");
`);

console.log(`File hash: ${result}`);

await worker.close();

```

---

### 🤫 Hijack the Console

Untrusted code loves to spam `console.log`. Deno Director gives you absolute authority over standard output. You can silence the sandbox completely, pipe it natively to Node.js, or route specific log levels to your own telemetry tools.

```ts
// 0. Default behavior: the sandbox console is routed to stdout/stderr/etc
const defaultWorker = new DenoWorker();

// 1. Total Silence: no console output
const silentWorker = new DenoWorker({ console: false });

// 2. Native Passthrough: Pipe Deno's console directly to Node's console
const noisyWorker = new DenoWorker({ console: console });

// 3. Surgical Routing: Hook specific methods to custom host functions
const customWorker = new DenoWorker({
  console: {
    log: (...args) => myDatadogLogger.info("Deno says:", ...args),
    // async functions are supported!
    error: async (...args) => await PagerDuty.alert("Deno crashed:", ...args),
    warn: false, // Drop warnings into the void
    debug: undefined // Fallback to default Deno behavior
  }
});

```

### 🧮 Function Calls with `args`

Use `options.args` to call a function value produced by `eval`/`evalSync`.

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker();

// Call a global function in the deno runtime ....
// passing in args fromm Node
const json_val = await worker.eval("JSON.parse", { args: ['{"key": "value"}'] });
console.log(json_val); // {key: "value"}

// Same pattern with inline functions and expressions.
// promises automatically resolve across the call boundary
const product = await worker.eval("async (a, b) => a * b", { args: [3, 4] });
console.log(product); // 12

// evalSync also supports args
// even without await, promises resolve across the call boundary
const out = worker.evalSync("async (name) => `hi ${name}`", { args: ["director"] });
console.log(out); // "hi director"

await worker.close();
```

Notes:
- If `args` are provided (even empty `[]`) and the evaluated value is callable, the function is invoked with those args.
- If `args` are omitted, function values are not auto-called.
- If `args` are provided but the evaluated value is not callable, the value is returned as-is.
---

### 🧩 nodeCompat and nodeResolve Examples

Use `nodeCompat` when you want broader Node compatibility behavior, and `moduleLoader.nodeResolve` when you specifically want Node-style package resolution.

```ts
import { DenoWorker } from "deno-director";

// Example 1: broader Node compatibility mode
const compatWorker = new DenoWorker({
  nodeCompat: true,
  imports: true,
  moduleLoader: { nodeResolve: true },
});

const compatOut = await compatWorker.module.eval(`
  import path from "path";
  export const out = path.join("a", "b");
`);
console.log(compatOut.out); // "a/b" (platform-dependent separators may vary)

await compatWorker.close();

// Example 2: targeted Node-style resolver only
const resolveWorker = new DenoWorker({
  imports: true,
  moduleLoader: { nodeResolve: true },
});

const resolveOut = await resolveWorker.module.eval(`
  import path from "path";
  export const base = path.basename("/tmp/some-installed-package");
`);
console.log(resolveOut.base); // "some-installed-package"

await resolveWorker.close();
```

### 🌊 Streaming Across the Bridge

You can stream byte chunks between Node and the worker runtime in both directions.

```ts
import { DenoWorker } from "deno-director";
import { randomUUID } from "node:crypto";

const worker = new DenoWorker();
const key = randomUUID();
const duplex = await worker.stream.connect(key);

await worker.eval(`
  // Consume Node -> worker bytes on "<key>::h2w", then write response on "<key>::w2h".
  globalThis.__streamTask = (async (key) => {
    const inStream = await hostStreams.accept(String(key) + "::h2w");
    for await (const _chunk of inStream) {}

    const outStream = hostStreams.create(String(key) + "::w2h");
    await outStream.write(new TextEncoder().encode("ok"));
    await outStream.close();
  })(key);
`, { args: [key] });

// Node -> worker
await new Promise<void>((resolve, reject) => {
  duplex.end(Buffer.from("hello world"), (err?: Error | null) => (err ? reject(err) : resolve()));
});

// worker -> Node
for await (const chunk of duplex) {
  console.log("download chunk bytes:", chunk.byteLength);
}

// Ensure worker-side stream task has finished.
await worker.eval("__streamTask");

await worker.close();
```

Inside worker code:

```ts
// Keys can be injected via eval args.
// Example eval src:
// async (key) => { ... }
const inStream = await hostStreams.accept(String(key) + "::h2w");
for await (const chunk of inStream) {
  // chunk is Uint8Array
}

const outStream = hostStreams.create(String(key) + "::w2h");
await outStream.write(new TextEncoder().encode("ok"));
await outStream.close();
```

### 🌍 Environment Variables: The Secure Way

By default, Deno Director locks down environment variables.  You can inject explicit key value pairs, or have the worker dynamically load a `.env` file from disk.

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker({
  // 1. Explicitly pass a map of variables
  env: {
    DB_PASS: "super_secret",
    NODE_ENV: "production"
  },
  
  // OR 2. Auto-load from a .env file (searches upwards from cwd by default)
  // envFile: true, 

  // OR 3. provide exact file to load, errors out if the file doesn't exist
  // envFile: ".my.env"
});

// Inside Deno, access them normally:
await worker.eval(`
  const pass = Deno.env.get("DB_PASS"); // "super_secret"
`);

await worker.close();
```

Permission note:
- If you provide `env` as a map and `permissions.env` is missing (or `[]`), the runtime auto-populates `permissions.env` with those env-map keys.
- If `permissions.env` is already set, it is not changed.
- If configured env keys are not readable under `permissions.env`, startup emits a warning.
- If `permissions.run` is enabled, spawned subprocesses may observe host environment values unless command env is explicitly constrained.



---

## 📖 API Documentation

### 🎬 `class DenoDirector`

The primary class for orchestrating multiple `DenoWorker` instances.

| Method | Returns | Description |
| --- | --- | --- |
| `start(options?: DenoDirectorStartOptions)` | `Promise<DenoDirectedRuntime>` | Spawns a new managed Deno runtime. |
| `get(id: string)` | `DenoDirectedRuntime | undefined` | Retrieves a runtime by its unique ID. |
| `getByLabel(label: string)` | `DenoDirectedRuntime[]` | Retrieves all runtimes matching a specific label. |
| `list(filter?: DenoDirectorListOptions)` | `DenoDirectedRuntime[]` | Lists runtimes, optionally filtering by label and/or tag. |
| `setLabel(runtime, label: string)` | `boolean` | Updates a runtime's label. |
| `setTags(runtime, tags: string[])` | `boolean` | Replaces a runtime's tags. |
| `addTag/removeTag(runtime, tag)` | `boolean` | Modifies tags on an existing runtime. |
| `stop(runtimeOrId)` | `Promise<boolean>` | Gracefully closes a runtime and removes it from the pool. |
| `stopByLabel(label: string)` | `Promise<number>` | Stops all runtimes matching a given label. |
| `stopAll()` | `Promise<number>` | Destroys the entire fleet. |

---

### 🛡️ `class DenoWorker`

The core runtime isolate. Maps 1:1 with a V8 Thread.

#### **Execution Methods**

* `eval<T = any>(src: string, options?: EvalOptions): Promise<T>`
Evaluates JavaScript or TypeScript asynchronously.
* `evalSync<T = any>(src: string, options?: EvalOptions): T`
Evaluates JavaScript or TypeScript synchronously (blocks Node event loop while waiting).
* `module.eval<T>(src: string, options?: DenoWorkerModuleEvalOptions): Promise<T>`
Evaluates the source as an ES Module and returns a callable Proxy namespace to the exports.
* `module.register(moduleName: string, source: string): Promise<void>`
Registers source under a module name for future imports.
* `module.clear(moduleName: string): Promise<boolean>`
Clears a previously registered module by name.
* `module.import<T>(specifier: string): Promise<T>`
Imports a module specifier through the runtime import pipeline and returns a callable Proxy namespace to the exports.
* `stream.connect(key: string): Promise<Duplex>`
Opens a bidirectional stream session and returns a Node.js `Duplex` stream.

When `transpileTs: true` is enabled, all three evaluation entrypoints (`eval`, `evalSync`, `module.eval`) run source through the TS/JSX transpiler before execution.
- async iteration: `for await (const chunk of reader) { ... }`

#### **Environment & Memory**

`worker.global` mirrors the handle operation surface, rooted at `globalThis`.

* `global.set(path: string, value: any, options?: DenoWorkerHandleExecOptions): Promise<void>`
Set a global value by dot-path.
* `global.get<T = any>(path: string, options?: DenoWorkerHandleExecOptions): Promise<T>`
Read a global value by dot-path.
* `global.has(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Check if a global path exists.
* `global.delete(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Delete a global path.
* `global.keys(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>`
Return keys from `globalThis` root or nested path.
* `global.entries(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>`
Return entries from `globalThis` root or nested path.
* `global.getOwnPropertyDescriptor(path: string, options?: DenoWorkerHandleExecOptions): Promise<PropertyDescriptor | undefined>`
Read a property descriptor from a global path.
* `global.define(path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Define a property descriptor at a global path.
* `global.isCallable(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Check whether a global value is callable.
* `global.isPromise(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Check whether a global value is promise-like.
* `global.call<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>`
Call a global function by path.
* `global.construct<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>`
Construct a global constructor by path.
* `global.await<T = any>(path: string, options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions): Promise<T>`
Await a global promise-like value by path.
* `global.clone(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>`
Create a durable handle from a global path.
* `global.toJSON<T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T>`
Return a JSON snapshot from global root or nested path.
* `global.apply<T = any[]>(path: string, ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions): Promise<T>`
Run batched handle operations against a global path root in one roundtrip.
* `global.getType(path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo>`
Read runtime type metadata for global root or nested path.
* `global.instanceOf(path: string, constructorPath: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>`
Check `instanceof` against a constructor path.
* `memory(): Promise<DenoWorkerMemory>`
Returns granular V8 heap statistics (`totalHeapSize`, `mallocedMemory`, etc.).
* `lastExecutionStats: { cpuTimeMs?: number, evalTimeMs?: number }`
Returns telemetry for the most recent `eval` operation.

#### **Messaging & Lifecycle**

* `postMessage(msg: any): void`
Fires an event into Deno's `globalThis.onmessage`.
* `on(event: "message" | "close" | "lifecycle", cb: Function)`
Listen for messages from Deno (`hostPostMessage`), close events, or lifecycle transitions (`beforeStart`, `onCrash`, etc.).
* `close(options?: { force?: boolean }): Promise<void>`
Gracefully shuts down the V8 isolate. Use `force: true` to instantly terminate execution.
* `restart(options?: { force?: boolean }): Promise<void>`
Reboots the isolate in place, re-applying all template configurations and global variables.

---

### ⚙️ Configuration Types

#### `DenoWorkerOptions`

Passed into `new DenoWorker(opts)` or used as `workerOptions` in templates.

```ts
type DenoWorkerOptions = {
  limits?: {
    maxHandle?: number;         // Active handle cap (default 128)
    maxEvalMs?: number;         // Default timeout for eval + handle runtime operations
    maxCpuMs?: number;          // Default CPU-budget timeout for eval + handle runtime operations
    maxMemoryBytes?: number;    // V8 Heap limit
    wasm?: boolean;             // Enable/disable .wasm module loading (default true)
  };
  bridge?: {                    // Transport tuning
    channelSize?: number;       // Per-queue capacity (control/data/node callback queues)
    streamWindowBytes?: number; // Per-stream flow-control window
    streamCreditFlushBytes?: number; // Credit flush threshold
    streamBacklogLimit?: number; // Max unaccepted worker->Node stream opens to backlog (default 256)
  };
  cwd?: string;                 // Virtual root for the filesystem sandbox
  startup?: string;             // Script evaluated before user code runs
  permissions?: boolean | {     // true=allow all, false=deny all, or per-capability config
    read?: boolean | string[];  // Allow read everywhere, or specific paths
    write?: boolean | string[]; // Allow write everywhere, or specific paths
    net?: boolean | string[];   // Allow network, or specific domains/ports
    env?: boolean | string[];   // Allow env access, or specific variables
    run?: boolean | string[];   // Allow subprocess execution (high risk)
    ffi?: boolean;              // Allow Foreign Function Interface
    sys?: boolean;              // OS Info access
  };
  env?: Record<string, string>; // Custom environment variables
  envFile?: string | boolean;   // Load from a .env file
  nodeCompat?: boolean;         // Enable Node compatibility mode
  imports?: boolean | ImportsCallback; // Custom module resolution interceptor
  transpileTs?: boolean;         // Enable TS/TSX/JSX transpilation for eval + imports
  tsCompiler?: {                 // TS/JSX transpiler options
    jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
    jsxFactory?: string;
    jsxFragmentFactory?: string;
    cacheDir?: string;           // Optional on-disk transpile output cache directory
  };
  moduleLoader?: {
    httpsResolve?: boolean;     // Enable https:// imports
    httpResolve?: boolean;      // Enable http:// imports (insecure; startup warning emitted)
    nodeResolve?: boolean;      // Enable Node-style disk/module resolution
    jsrResolve?: boolean;       // Resolve jsr: and @std/* via jsr.io
    cacheDir?: string;          // Where to cache remote imports
    reload?: boolean;           // Bypass cache
    maxPayloadBytes?: number;   // Remote module payload size cap in bytes (-1 disables limit, default 10 MiB)
  };
  console?: false | Console | Record<string, Function | false>; // Route console logs
  inspect?: boolean | { host?: string; port?: number; break?: boolean; }; // V8 Debugging
};

```

`bridge.channelSize` applies independently to multiple internal queues (control-plane, data-plane, and node callback dispatch), not a single shared queue. Under heavy load, total buffered slots can approach roughly `3 * channelSize`.
`bridge.streamBacklogLimit` caps worker->Node stream opens that arrive before the host side accepts the lane; excess opens are rejected to bound host memory growth.

## Notes

- This package builds a native addon during install (`cargo` + Rust toolchain required).
- For module imports, configure `imports` and related permissions/options based on your use case.
- Prefer async host callbacks for heavy work; synchronous host callbacks execute on Node's main thread and can starve the event loop.
- `limits.maxMemoryBytes` applies to V8 heap accounting; WebAssembly memory may not be fully constrained by this limit.
