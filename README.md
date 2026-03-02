<div align="center">

# 🦕 Deno Director 🎬

**Embed, Orchestrate, and Sandbox Deno V8 Isolates Directly Inside Node.js.**

</div>

---

Node.js is legendary. Deno is secure by default. **What if you didn't have to choose?**

**Deno Director** is a native Rust/Neon module that embeds the Deno runtime natively into your Node.js process. It allows you to spin up lightning-fast, heavily sandboxed, completely isolated V8 threads, and control them from Node.js.

Whether you are building a multi-tenant edge-compute platform, executing untrusted third-party code, or just want to use Deno's native TypeScript and URL-import capabilities inside your legacy Node.js monolith, Deno Director is the ultimate weapon.

## 🔥 Why Deno Director?

* **Zero-Serialization Friction:** Unlike standard IPC, Deno Director uses a highly optimized native bridge. Pass `Map`, `Set`, `ArrayBuffer`, `Date`, `RegExp`, native `Error` objects, and even **Functions** across the Node/Deno boundary without losing fidelity.
* **Wield Host Functions:** Pass a Node.js function *into* the Deno sandbox. Call it from Deno, and it executes in Node. Synchronously or asynchronously.
* **Ironclad Sandboxing:** Every worker is a Deno isolate. You have absolute control over `read`, `write`, `net`, `env`, and `ffi` permissions. Lock it down.
* **Native TypeScript & JSX:** Evaluate `.ts` and `.tsx` files directly. No build step required. Deno Director handles transpilation on the fly.
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

### The Basics: Evaluated TS and Host Callbacks

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker({
  // Lock it down. Deno cannot read the disk or access the network.
  permissions: { read: false, net: false, env: false },
  // Enable on-the-fly TS transpilation
  moduleLoader: { transpileTs: true }
});

// Pass a Node.js function into the Deno sandbox
await worker.setGlobal("nodeLogger", (msg: string) => {
  console.log(`[Node.js received from Deno]: ${msg}`);
});

// Evaluate TypeScript directly in the sandbox!
const result = await worker.eval(`
  const x: number = 42;
  nodeLogger("Calculating universe secrets...");
  x * 2;
`);

console.log(result); // 84
await worker.close();

```

### Fleet Orchestration: Managing 1,000 Tenants

Use the `DenoDirector` to orchestrate massive fleets of sandboxed runtimes.

```ts
import { DenoDirector } from "deno-director";

const director = new DenoDirector({
  template: {
    // Base configuration for ALL workers
    workerOptions: { maxMemoryBytes: 128 * 1024 * 1024 }, // 128MB limit
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

### The Transdimensional Bridge

When you pass data between Node and Deno using `eval`, `evalSync`, or `setGlobal`, Deno Director doesn't just `JSON.stringify`. It uses a complex custom codec backed by V8 serialization.

* `NaN`, `Infinity`, `-0`? Preserved.
* `Uint8Array`, `DataView`, `SharedArrayBuffer`? Passed instantly via underlying memory views.
* Promises? Automatically chained across the boundary.

### ES Module Proxying

Don't just evaluate strings—import entire ES modules and use them as if they were native Node.js objects.

```ts
// Deno dynamically imports the code, and Node gets a fully typed proxy namespace!
const mod = await worker.evalModule(`
  export const version = "1.0.0";
  export function encrypt(data) { return btoa(data); }
`);

console.log(mod.version); // "1.0.0"
console.log(await mod.encrypt("secret")); // "c2VjcmV0"

```

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
  moduleLoader: { transpileTs: true }, // We want Deno to handle our TS/JSX
  
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
const result = await worker.evalModule(`
  import { database } from "app:database";
  export function getData() {
    return database;
  }
`);

console.log(await result.getData()); // "Super Secret Data for database"

```

**The resulting superpower:** You can seamlessly integrate tools like Webpack, SWC, or esbuild on the Node.js side, transpile custom DSLs, and feed the resulting raw code directly into the isolated Deno runtime without ever touching the disk.

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
await worker.setGlobal("nodeFs", fs);
await worker.setGlobal("nodeCrypto", crypto);

const result = await worker.eval(`
  // Calling Node.js fs.readFileSync synchronously from inside Deno!
  const fileBuffer = nodeFs.readFileSync("./secrets.txt");
  
  // Calling Node's crypto module from Deno
  // this function runs in the NODE context!
  const hash = nodeCrypto.createHash("sha256");
  hash.update(fileBuffer);
  hash.digest("hex");
`);

console.log(`File hash: ${result}`);

```

---

### 🤫 Hijack the Console

Untrusted code loves to spam `console.log`. Deno Director gives you absolute authority over standard output. You can silence the sandbox completely, pipe it natively to Node.js, or route specific log levels to your own telemetry tools.

```ts
// 0. Default behavior: the sandbox console is routed to stdout/stderr/etc
const silentWorker = new DenoWorker();

// 1. Total Silence: no console output
const silentWorker = new DenoWorker({ console: false });

// 2. Native Passthrough: Pipe Deno's console directly to Node's console
const noisyWorker = new DenoWorker({ console: console });

// 3. Surgical Routing: Hook specific methods to custom host functions
const customWorker = new DenoWorker({
  console: {
    log: (...args) => myDatadogLogger.info("Deno says:", ...args),
    // async funcitons are supported!
    error: async (...args) => await PagerDuty.alert("Deno crashed:", ...args),
    warn: false, // Drop warnings into the void
    debug: undefined // Fallback to default Deno behavior
  }
});

```
---

### 🌍 Environment Variables: The Secure Way

By default, Deno Director locks down environment variables.  You can inject explicit key value pairs, or have the worker dynamically load a `.env` file from disk.

```ts
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

```

---

## 📖 API Documentation

### `class DenoDirector`

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

### `class DenoWorker`

The core runtime isolate. Maps 1:1 with a V8 Thread.

#### **Execution Methods**

* `eval(src: string, options?: EvalOptions): Promise<any>`
Evaluates JavaScript or TypeScript asynchronously.
* `evalSync(src: string, options?: EvalOptions): any`
Evaluates JavaScript or TypeScript synchronously (blocks Node event loop while waiting).
* `evalModule<T>(src: string, options?: EvalOptions): Promise<T>`
Evaluates the source as an ES Module and returns a callable Proxy namespace to the exports.

#### **Environment & Memory**

* `setGlobal(key: string, value: any): Promise<void>`
Injects a value or function into the `globalThis` of the Deno isolate.
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

### Configuration Types

#### `DenoWorkerOptions`

Passed into `new DenoWorker(opts)` or used as `workerOptions` in templates.

```ts
type DenoWorkerOptions = {
  cwd?: string;                 // Virtual root for the filesystem sandbox
  maxEvalMs?: number;           // Hard timeout for eval operations
  maxMemoryBytes?: number;      // V8 Heap limit
  startup?: string;             // Script evaluated before user code runs
  permissions?: {               // Deno secure sandbox permissions
    read?: boolean | string[];  // Allow read everywhere, or specific paths
    write?: boolean | string[]; // Allow write everywhere, or specific paths
    net?: boolean | string[];   // Allow network, or specific domains/ports
    env?: boolean | string[];   // Allow env access, or specific variables
    ffi?: boolean;              // Allow Foreign Function Interface
    sys?: boolean;              // OS Info access
  };
  env?: Record<string, string>; // Custom environment variables
  envFile?: string | boolean;   // Load from a .env file
  imports?: boolean | ImportsCallback; // Custom module resolution interceptor
  moduleLoader?: {
    denoRemote?: boolean;       // Enable https:// imports
    transpileTs?: boolean;      // Enable TypeScript / JSX
    cacheDir?: string;          // Where to cache remote imports
    reload?: boolean;           // Bypass cache
    tsCompiler?: {              // JSX Factory configurations
      jsx?: "react" | "react-jsx" | "preserve";
      jsxFactory?: string;
      jsxFragmentFactory?: string;
    }
  };
  console?: false | Console | Record<string, Function | false>; // Route console logs
  inspect?: boolean | { host?: string; port?: number; break?: boolean; }; // V8 Debugging
};

```

## Notes

- This package builds a native addon during install (`cargo` + Rust toolchain required).
- For module imports, configure `imports` and related permissions/options based on your use case.
