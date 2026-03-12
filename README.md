<div align="center">

# 🦕 Deno Director 🎬

**Run isolated Deno runtimes inside a Node.js process with explicit boundaries and practical controls.**

[![GitHub Repo stars](https://img.shields.io/github/stars/only-cliches/deno-director)](https://github.com/only-cliches/deno-director)
[![NPM Version](https://img.shields.io/npm/v/deno-director)](https://www.npmjs.com/package/deno-director)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)


</div>

`deno-director` is a native Rust/Neon bridge for teams that want Deno's sandboxing and module model without giving up a Node host. It gives you one process, explicit runtime policy, and a bridge that supports real application code rather than toy examples.

The package is built around three main exports:

- `DenoWorker` for a single isolated runtime
- `DenoWorkerTemplate` for reusable worker startup configuration
- `DenoDirector` for managing pools of runtimes

It also exports the full public TypeScript surface from [`src/ts/types.ts`](/home/slott/Developer/deno-director/src/ts/types.ts).

## Quick Start

Install:

```bash
npm install deno-director
```

Start with `eval` when you want to run code directly inside an embedded runtime:

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker({
  permissions: {
    net: false,
    read: false,
    write: false,
    env: false,
  },
});

const value = await worker.eval<number>("40 + 2");
console.log(value); // 42

await worker.close();
```

Use `module.eval` when you want ES module semantics and callable exports:

```ts
import { DenoWorker } from "deno-director";

const worker = new DenoWorker({
  permissions: { net: false, read: false },
});

const math = await worker.module.eval(`
  export function add(a, b) {
    return a + b;
  }
`);

console.log(await math.add(2, 3)); // 5

await worker.close();
```

The rest of this README documents the complete package API in detail.

## Table of Contents

- [Installation](#installation)
- [Package Exports](#package-exports)
- [DenoWorkerTemplate](#denoworkertemplate)
- [DenoDirector](#denodirector)
- [Configuration and Type Reference](#configuration-and-type-reference)
- [DenoWorker](#denoworker)
- [DenoWorker Events](#denoworker-events)
- [DenoWorker Sub-APIs](#denoworker-sub-apis)
- [Examples](#examples)
- [Development](#development)

## Installation

```bash
npm install deno-director
```

Notes:

- This package contains a native addon built with Rust/Neon.
- The repo `install` script runs `cargo build`.
- If you are building from source, you need a working Rust toolchain.

## Package Exports

Top-level exports from the package:

```ts
export * from "./ts";
export { default } from "./ts";
```

And from [`src/ts/index.ts`](/home/slott/Developer/deno-director/src/ts/index.ts):

```ts
export * from "./types";
export { DenoWorker } from "./worker";
export { DenoWorkerTemplate } from "./template";
export { DenoDirector } from "./director";
export { DenoWorker as default } from "./worker";
```

In practice, most users work with:

- `DenoWorker`
- `DenoWorkerTemplate`
- `DenoDirector`
- `DenoWorkerOptions`
- `EvalOptions`
- `DenoWorkerModuleEvalOptions`
- `DenoWorkerHandle*` types
- `DenoWorkerStats*` types

## DenoWorkerTemplate

`DenoWorkerTemplate` is a reusable factory for workers that share common startup configuration.

Source: [`src/ts/template.ts`](/home/slott/Developer/deno-director/src/ts/template.ts)

### Constructor

```ts
new DenoWorkerTemplate(options?: DenoWorkerTemplateOptions)
```

### Methods

#### `create`

```ts
create(createOptions?: DenoWorkerTemplateCreateOptions): Promise<DenoWorker>
```

Merge behavior:

- `workerOptions`: create options override template options
- `globals`: shallow merge, create options override by key
- `bootstrapScripts`: concatenated template-first, then per-create
- `bootstrapModules`: concatenated template-first, then per-create
- `setup`: template hook runs before per-create hook

If setup fails, the worker is closed before the error is re-thrown.

### Template Types

```ts
type DenoWorkerTemplateOptions = {
  workerOptions?: DenoWorkerOptions;
  globals?: Record<string, any>;
  bootstrapScripts?: string | string[];
  bootstrapModules?: string | string[];
  setup?: (worker: DenoWorker) => void | Promise<void>;
};
```

```ts
type DenoWorkerTemplateCreateOptions = {
  workerOptions?: DenoWorkerOptions;
  globals?: Record<string, any>;
  bootstrapScripts?: string | string[];
  bootstrapModules?: string | string[];
  setup?: (worker: DenoWorker) => void | Promise<void>;
};
```

## DenoDirector

`DenoDirector` is the orchestration layer built on top of `DenoWorkerTemplate`.

Source: [`src/ts/director.ts`](/home/slott/Developer/deno-director/src/ts/director.ts)

Responsibilities:

- create managed runtimes
- assign unique ids
- maintain label indexes
- query runtimes by id, label, and tag
- stop individual runtimes or whole groups

### Constructor

```ts
new DenoDirector(options?: DenoDirectorOptions)
```

```ts
type DenoDirectorOptions = {
  template?: DenoWorkerTemplateOptions;
};
```

### Methods

#### `start`

```ts
start(options?: DenoDirectorStartOptions): Promise<DenoDirectedRuntime>
```

Starts a managed runtime and attaches immutable `runtime.meta`.

#### `get`

```ts
get(id: string): DenoDirectedRuntime | undefined
```

#### `getByLabel`

```ts
getByLabel(label: string): DenoDirectedRuntime[]
```

#### `list`

```ts
list(filter?: DenoDirectorListOptions): DenoDirectedRuntime[]
```

Filters are AND-combined when both `label` and `tag` are present.

#### `setLabel`

```ts
setLabel(runtimeOrId: DenoDirectedRuntime | string, label?: string): boolean
```

#### `setTags`

```ts
setTags(runtimeOrId: DenoDirectedRuntime | string, tags: string[]): boolean
```

#### `addTag`

```ts
addTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean
```

#### `removeTag`

```ts
removeTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean
```

#### `stop`

```ts
stop(runtimeOrId: DenoDirectedRuntime | string): Promise<boolean>
```

#### `stopByLabel`

```ts
stopByLabel(label: string): Promise<number>
```

#### `stopAll`

```ts
stopAll(): Promise<void>
```

### Director Metadata Types

```ts
type DenoRuntimeMeta = {
  id: string;
  label?: string;
  tags: string[];
  createdAt: number;
};
```

```ts
type DenoDirectedRuntime = DenoWorker & {
  readonly meta: DenoRuntimeMeta;
};
```

```ts
type DenoRuntimeRecord = {
  meta: DenoRuntimeMeta;
  runtime: DenoDirectedRuntime;
};
```

```ts
type DenoDirectorStartOptions = DenoWorkerTemplateCreateOptions & {
  id?: string;
  label?: string;
  tags?: string[];
};
```

```ts
type DenoDirectorListOptions = {
  label?: string;
  tag?: string;
};
```

## Configuration and Type Reference

### `DenoWorkerOptions`

The main worker configuration type.

```ts
type DenoWorkerOptions = {
  limits?: DenoWorkerLimits;
  bridge?: DenoWorkerBridgeOption;
  imports?: boolean | ImportsCallback;
  cwd?: string;
  startup?: string;
  permissions?: DenoPermissionsConfig;
  nodeJs?: DenoWorkerNodeJsOption;
  console?: DenoWorkerConsoleOption;
  env?: DenoWorkerEnvOption;
  envFile?: boolean | string;
  inspect?: DenoWorkerInspectOption;
  sourceLoaders?: DenoWorkerLoadersDisabled | DenoWorkerLoadersOption;
  tsCompiler?: DenoWorkerTsCompilerOption;
  moduleLoader?: DenoWorkerModuleLoaderOption;
  globals?: Record<string, any>;
  modules?: Record<string, DenoWorkerStartupModuleSource> | Map<string, DenoWorkerStartupModuleSource>;
  lifecycle?: DenoWorkerLifecycleHooks;
};
```

### Eval and Loader Types

```ts
type EvalOptions = {
  filename?: string;
  type?: "script" | "module";
  srcLoader?: string;
  args?: any[];
  maxEvalMs?: number;
  maxCpuMs?: number;
};
```

```ts
type DenoSourceLoader = "js" | "ts" | "tsx" | "jsx";
```

```ts
type ImportsCallbackSource = {
  src: string;
  srcLoader?: string;
};
```

```ts
type ImportsCallbackResult =
  | boolean
  | string
  | ImportsCallbackSource
  | { resolve: string };
```

```ts
type ImportsCallback = (
  specifier: string,
  referrer?: string,
  isDynamicImport?: boolean,
) => ImportsCallbackResult | Promise<ImportsCallbackResult>;
```

```ts
type DenoLoaderTransformContext = {
  src: string;
  srcLoader: string;
  kind: "eval" | "module-eval" | "import";
  specifier?: string;
  referrer?: string;
  isDynamicImport?: boolean;
};
```

```ts
type DenoLoaderTransformResult =
  | string
  | void
  | { src: string; srcLoader?: string };
```

```ts
type DenoLoaderTransform = (
  ctx: DenoLoaderTransformContext,
) => DenoLoaderTransformResult | Promise<DenoLoaderTransformResult>;
```

```ts
type DenoWorkerLoadersOption = DenoLoaderTransform[];
type DenoWorkerLoadersDisabled = false;
```

### Permissions

```ts
type DenoPermissionValue = boolean | string[];
```

```ts
type DenoPermissions = {
  read?: DenoPermissionValue;
  write?: DenoPermissionValue;
  net?: DenoPermissionValue;
  env?: DenoPermissionValue;
  run?: DenoPermissionValue;
  ffi?: DenoPermissionValue;
  sys?: DenoPermissionValue;
  import?: DenoPermissionValue;
  hrtime?: boolean;
  wasm?: boolean;
};
```

```ts
type DenoPermissionsConfig = DenoPermissions | boolean;
```

### Console, Inspect, Env

```ts
type DenoConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
```

```ts
type DenoConsoleHandler =
  | false
  | undefined
  | ((...args: any[]) => any)
  | Promise<((...args: any[]) => any)>;
```

```ts
type DenoWorkerConsoleOption =
  | undefined
  | false
  | Console
  | Partial<Record<DenoConsoleMethod, DenoConsoleHandler>>;
```

```ts
type DenoWorkerInspectOption =
  | undefined
  | boolean
  | {
      host?: string;
      port?: number;
      break?: boolean;
    };
```

```ts
type DenoWorkerEnvOption =
  | undefined
  | boolean
  | string
  | Record<string, string>;
```

### Module Loading and Node Compatibility

```ts
type DenoWorkerModuleLoaderOption =
  | undefined
  | {
      httpsResolve?: boolean;
      httpResolve?: boolean;
      jsrResolve?: boolean;
      cacheDir?: string;
      reload?: boolean;
      maxPayloadBytes?: number;
    };
```

```ts
type DenoWorkerNodeJsOption =
  | undefined
  | boolean
  | {
      modules?: boolean;
      runtime?: boolean;
      cjsInterop?: boolean;
      cjsForcePaths?: Array<string | RegExp>;
    };
```

```ts
type DenoWorkerTsCompilerOption =
  | undefined
  | {
      jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
      jsxFactory?: string;
      jsxFragmentFactory?: string;
      cacheDir?: string;
    };
```

```ts
type DenoWorkerStartupModuleSource =
  | string
  | {
      src: string;
      srcLoader?: string;
    };
```

### Bridge Tuning and Limits

```ts
type DenoWorkerBridgeOption =
  | undefined
  | {
      channelSize?: number;
      streamWindowBytes?: number;
      streamCreditFlushBytes?: number;
      streamBacklogLimit?: number;
      streamHighWaterMarkBytes?: number;
      enableUnsafeStreamMemory?: boolean;
    };
```

```ts
type DenoWorkerLimits = {
  maxHandle?: number;
  maxEvalMs?: number;
  maxCpuMs?: number;
  maxMemoryBytes?: number;
};
```

### Lifecycle Types

```ts
type DenoWorkerLifecyclePhase =
  | "beforeStart"
  | "afterStart"
  | "beforeStop"
  | "afterStop"
  | "onCrash";
```

```ts
type DenoWorkerLifecycleContext = {
  phase: DenoWorkerLifecyclePhase;
  worker?: DenoWorker;
  options?: DenoWorkerOptions;
  reason?: unknown;
  requested?: boolean;
};
```

```ts
type DenoWorkerLifecycleHooks = Partial<
  Record<DenoWorkerLifecyclePhase, (ctx: DenoWorkerLifecycleContext) => void>
>;
```

```ts
type DenoWorkerLifecycleHandler = (ctx: DenoWorkerLifecycleContext) => void;
```

### Advanced/Internal Export

The package also exports `NativeWorker` for typing convenience. It represents the internal addon surface used by the TypeScript wrapper.

Unless you are extending the wrapper internals, you should not depend on it directly.

## DenoWorker

`DenoWorker` is the primary runtime abstraction. Each instance owns one isolated embedded Deno runtime.

Source: [`src/ts/worker.ts`](/home/slott/Developer/deno-director/src/ts/worker.ts)

### Constructor

```ts
new DenoWorker(options?: DenoWorkerOptions)
```

The constructor:

- normalizes worker options
- creates the native runtime
- binds message/lifecycle/runtime event handlers
- applies startup globals and startup modules
- runs lifecycle hooks

### Core Methods

#### `eval`

```ts
eval<T = any>(src: string, options?: EvalOptions): Promise<T>
```

Evaluate script source asynchronously inside the runtime.

Behavior:

- supports `options.args`
- supports source loaders via `options.srcLoader`
- waits for promise results
- emits runtime events such as `eval.begin` and `eval.end`

Example:

```ts
const out = await worker.eval<number>("(a, b) => a + b", {
  args: [20, 22],
});
```

#### `evalSync`

```ts
evalSync<T = any>(src: string, options?: EvalOptions): T
```

Synchronously evaluate source in the runtime.

Notes:

- blocks the Node thread while waiting
- cannot run while constructor globals are still initializing
- cannot use async source-loader callbacks

#### `postMessage`

```ts
postMessage(msg: any): void
```

Send a message into the runtime event channel. Inside the runtime this is delivered to `globalThis.onmessage`.

Throws if the runtime is closed.

#### `close`

```ts
close(options?: DenoWorkerCloseOptions): Promise<void>
```

Gracefully close the runtime.

`DenoWorkerCloseOptions`:

```ts
type DenoWorkerCloseOptions = {
  force?: boolean;
};
```

Behavior:

- normal close waits for runtime shutdown
- `force: true` rejects in-flight wrapper operations and performs best-effort immediate teardown

#### `restart`

```ts
restart(options?: DenoWorkerRestartOptions): Promise<void>
```

Restart the runtime in place using the original creation options.

`DenoWorkerRestartOptions`:

```ts
type DenoWorkerRestartOptions = {
  force?: boolean;
};
```

Existing wrapper listeners stay attached across restart.

#### `isClosed`

```ts
isClosed(): boolean
```

Returns whether the current wrapper/runtime instance is closed.

### Properties

`DenoWorker` exposes these main namespaces:

- `worker.module`
- `worker.handle`
- `worker.global`
- `worker.stream`
- `worker.cwd`
- `worker.env`
- `worker.stats`

## DenoWorker Events

`DenoWorker` supports:

```ts
type DenoWorkerEvent = "message" | "close" | "lifecycle" | "runtime" | "error";
```

### `on`

```ts
on(event: "message", cb: DenoWorkerMessageHandler): void;
on(event: "close", cb: DenoWorkerCloseHandler): void;
on(event: "lifecycle", cb: DenoWorkerLifecycleHandler): void;
on(event: "runtime", cb: DenoWorkerRuntimeHandler): void;
on(event: "error", cb: DenoWorkerErrorHandler): void;
```

Event meanings:

- `message`: payloads posted from inside the runtime via `postMessage(...)`
- `close`: emitted when the runtime closes
- `lifecycle`: emits lifecycle transitions such as `beforeStart` and `afterStop`
- `runtime`: emits execution/import/handle/stream telemetry
- `error`: convenience channel for runtime `error.thrown` events

### `off`

```ts
off(event: "message", cb?: DenoWorkerMessageHandler): void;
off(event: "close", cb?: DenoWorkerCloseHandler): void;
off(event: "lifecycle", cb?: DenoWorkerLifecycleHandler): void;
off(event: "runtime", cb?: DenoWorkerRuntimeHandler): void;
off(event: "error", cb?: DenoWorkerErrorHandler): void;
```

If `cb` is omitted, all listeners for that event are removed.

### Runtime Event Types

```ts
type DenoWorkerRuntimeEventKind =
  | "import.requested"
  | "import.resolved"
  | "import.classified"
  | "stream.connect"
  | "eval.begin"
  | "eval.end"
  | "module.eval.begin"
  | "module.eval.end"
  | "evalSync.begin"
  | "evalSync.end"
  | "error.thrown"
  | "handle.create"
  | "handle.dispose"
  | "handle.call.begin"
  | "handle.call.end";
```

```ts
type DenoWorkerRuntimeEvent = {
  kind: DenoWorkerRuntimeEventKind;
  ts: number;
  opId?: string;
  [k: string]: any;
};
```

## DenoWorker Sub-APIs

### `worker.module`

Type: `DenoWorkerModuleApi`

```ts
type DenoWorkerModuleApi = {
  import<T extends Record<string, any> = Record<string, any>>(specifier: string): Promise<T>;
  eval<T extends Record<string, any> = Record<string, any>>(
    source: string,
    options?: DenoWorkerModuleEvalOptions,
  ): Promise<T>;
  register(moduleName: string, source: string, options?: Pick<EvalOptions, "srcLoader">): Promise<void>;
  clear(moduleName: string): Promise<boolean>;
};
```

#### `module.import`

Import a specifier through the runtime import pipeline.

#### `module.eval`

Evaluate ES module source and return a callable namespace object.

`DenoWorkerModuleEvalOptions`:

```ts
type DenoWorkerModuleEvalOptions = Omit<EvalOptions, "type"> & {
  moduleName?: string;
  cjs?: boolean;
};
```

Option behavior:

- `moduleName`: register under a stable name before import/evaluation
- `cjs: true`: treat source as CommonJS and expose an ESM facade

#### `module.register`

Register module source under a stable name for later import.

#### `module.clear`

Remove a registered module by name.

### `worker.handle`

Types: `DenoWorkerHandleApi`, `DenoWorkerHandle`

#### Handle Creation API

```ts
type DenoWorkerHandleApi = {
  get(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>;
  tryGet(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle | undefined>;
  eval(source: string, options?: Omit<EvalOptions, "args" | "type" | "srcLoader">): Promise<DenoWorkerHandle>;
};
```

Use handles when you want to keep a runtime object alive and operate on it repeatedly.

#### Handle Type

```ts
type DenoWorkerHandle = {
  readonly id: string;
  readonly rootType: DenoWorkerHandleTypeInfo;
  readonly disposed: boolean;
  get<T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T>;
  has(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  set(path: string, value: any, options?: DenoWorkerHandleExecOptions): Promise<void>;
  delete(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  keys(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
  entries(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
  getOwnPropertyDescriptor(path: string, options?: DenoWorkerHandleExecOptions): Promise<PropertyDescriptor | undefined>;
  define(path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  instanceOf(constructorPath: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  isCallable(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  isPromise(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  call<T = any>(args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  call<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  construct<T = any>(args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  await<T = any>(options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions): Promise<T>;
  clone(options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>;
  toJSON<T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T>;
  apply<T = any[]>(ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  getType(path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo>;
  dispose(options?: DenoWorkerHandleExecOptions): Promise<void>;
};
```

Supporting types:

```ts
type DenoWorkerHandleExecOptions = {
  maxEvalMs?: number;
  maxCpuMs?: number;
};
```

```ts
type DenoWorkerHandleAwaitOptions = {
  returnValue?: boolean;
  untilNonPromise?: boolean;
};
```

```ts
type DenoWorkerHandleApplyOp =
  | { op: "get"; path?: string }
  | { op: "set"; path: string; value: any }
  | { op: "call"; path?: string; args?: any[] }
  | { op: "has"; path: string }
  | { op: "delete"; path: string }
  | { op: "getType"; path?: string }
  | { op: "toJSON"; path?: string }
  | { op: "isCallable"; path?: string }
  | { op: "isPromise"; path?: string };
```

```ts
type DenoWorkerHandleType =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "bigint"
  | "symbol"
  | "function"
  | "array"
  | "object"
  | "date"
  | "regexp"
  | "map"
  | "set"
  | "arraybuffer"
  | "typedarray"
  | "error"
  | "promise";

type DenoWorkerHandleTypeInfo = {
  type: DenoWorkerHandleType;
  callable: boolean;
  constructorName?: string;
};
```

### `worker.global`

Type: `DenoWorkerGlobalApi`

This mirrors the handle API but is rooted at `globalThis`.

```ts
type DenoWorkerGlobalApi = {
  set(path: string, value: any, options?: DenoWorkerHandleExecOptions): Promise<void>;
  get<T = any>(path: string, options?: DenoWorkerHandleExecOptions): Promise<T>;
  has(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  delete(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  keys(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
  entries(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
  getOwnPropertyDescriptor(path: string, options?: DenoWorkerHandleExecOptions): Promise<PropertyDescriptor | undefined>;
  define(path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  isCallable(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  isPromise(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
  call<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  construct<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  await<T = any>(path: string, options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions): Promise<T>;
  clone(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>;
  toJSON<T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T>;
  apply<T = any[]>(path: string, ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions): Promise<T>;
  getType(path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo>;
  instanceOf(path: string, constructorPath: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
};
```

### `worker.stream`

Type: `DenoWorkerStreamApi`

```ts
type DenoWorkerStreamApi = {
  connect(key: string, options?: DenoWorkerStreamConnectOptions): Promise<Duplex>;
  create(key?: string): DenoWorkerStreamWriter;
  accept(key: string): Promise<DenoWorkerStreamReader>;
};
```

Supporting types:

```ts
type DenoWorkerStreamConnectOptions = {
  unsafeSharedMemory?: boolean;
};
```

```ts
type DenoWorkerStreamWriter = {
  getKey(): string;
  ready(minBytes?: number): Promise<void>;
  write(chunk: Uint8Array | ArrayBuffer): Promise<void>;
  writeMany(chunks: Array<Uint8Array | ArrayBuffer>): Promise<number>;
  close(): Promise<void>;
  error(message: string): Promise<void>;
  cancel(reason?: string): Promise<void>;
};
```

```ts
type DenoWorkerStreamReader = AsyncIterable<Uint8Array> & {
  read(): Promise<IteratorResult<Uint8Array>>;
  cancel(reason?: string): Promise<void>;
};
```

### `worker.cwd`

Type: `DenoWorkerCwdApi`

```ts
type DenoWorkerCwdApi = {
  get(): Promise<string>;
  set(path: string): Promise<string>;
};
```

Behavior:

- when running, `get()` reflects runtime `Deno.cwd()`
- when closed, `get()` reflects the configured cwd to use on next start
- `set(path)` updates options and restarts the runtime when needed

### `worker.env`

Type: `DenoWorkerEnvApi`

```ts
type DenoWorkerEnvApi = {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
};
```

Behavior:

- reads live runtime env when running
- persists env changes for restart
- throws if env permissions are explicitly disabled

### `worker.stats`

Type: `DenoWorkerStatsApi`

```ts
type DenoWorkerStatsApi = {
  readonly activeOps: number;
  readonly lastExecution: ExecStats;
  cpu(options?: DenoWorkerCpuOptions): Promise<DenoWorkerCpuStats>;
  rates(options?: DenoWorkerRatesOptions): Promise<DenoWorkerRatesStats>;
  latency(options?: DenoWorkerRatesOptions): Promise<DenoWorkerLatencyStats>;
  eventLoopLag(options?: DenoWorkerEventLoopLagOptions): Promise<DenoWorkerEventLoopLagStats>;
  readonly stream: DenoWorkerStreamStats;
  readonly totals: DenoWorkerTotalsStats;
  reset(options?: DenoWorkerStatsResetOptions): void;
  memory(): Promise<DenoWorkerMemory>;
};
```

Supporting stats types:

```ts
type ExecStats = {
  cpuTimeMs?: number;
  evalTimeMs?: number;
};
```

```ts
type DenoWorkerCpuOptions = { measureMs?: number };
type DenoWorkerCpuStats = {
  usagePercentage: number;
  measureMs: number;
  cpuTimeMs: number;
};
```

```ts
type DenoWorkerRatesOptions = { windowMs?: number };
type DenoWorkerRatesStats = {
  windowMs: number;
  evalPerSec: number;
  handlePerSec: number;
  globalPerSec: number;
  messagesPerSec: number;
};
```

```ts
type DenoWorkerLatencyStats = {
  windowMs: number;
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
};
```

```ts
type DenoWorkerEventLoopLagOptions = { measureMs?: number };
type DenoWorkerEventLoopLagStats = {
  measureMs: number;
  lagMs: number;
};
```

```ts
type DenoWorkerStreamStats = {
  activeStreams: number;
  queuedChunks: number;
  queuedBytes: number;
  creditDebtBytes: number;
  backlogSize: number;
};
```

```ts
type DenoWorkerTotalsStats = {
  ops: number;
  errors: number;
  restarts: number;
  messagesOut: number;
  messagesIn: number;
  bytesOut: number;
  bytesIn: number;
};
```

```ts
type DenoWorkerStatsResetOptions = {
  keepTotals?: boolean;
};
```

Memory types:

```ts
type DenoWorkerMemory = {
  heapStatistics: V8HeapStatistics;
  heapSpaceStatistics: V8HeapSpaceStatistics[];
};
```

```ts
type V8HeapStatistics = {
  totalHeapSize: number;
  totalHeapSizeExecutable: number;
  totalPhysicalSize: number;
  totalAvailableSize: number;
  usedHeapSize: number;
  heapSizeLimit: number;
  mallocedMemory: number;
  externalMemory: number;
  peakMallocedMemory: number;
  numberOfNativeContexts: number;
  numberOfDetachedContexts: number;
  doesZapGarbage: boolean;
};
```

```ts
type V8HeapSpaceStatistics = {
  spaceName: string;
  physicalSpaceSize: number;
  spaceSize: number;
  spaceUsedSize: number;
  spaceAvailableSize: number;
};
```

## Examples

See:

- [examples/README.md](/home/slott/Developer/deno-director/examples/README.md)
- [examples/01-basic-eval.ts](/home/slott/Developer/deno-director/examples/01-basic-eval.ts)
- [examples/02-eval-module.ts](/home/slott/Developer/deno-director/examples/02-eval-module.ts)
- [examples/03-globals.ts](/home/slott/Developer/deno-director/examples/03-globals.ts)
- [examples/04-messages.ts](/home/slott/Developer/deno-director/examples/04-messages.ts)
- [examples/05-imports-callback.ts](/home/slott/Developer/deno-director/examples/05-imports-callback.ts)
- [examples/08-limits.ts](/home/slott/Developer/deno-director/examples/08-limits.ts)
- [examples/10-director.ts](/home/slott/Developer/deno-director/examples/10-director.ts)
- [examples/11-streams.ts](/home/slott/Developer/deno-director/examples/11-streams.ts)
- [examples/12-handles.ts](/home/slott/Developer/deno-director/examples/12-handles.ts)
- [examples/13-serverless-style.ts](/home/slott/Developer/deno-director/examples/13-serverless-style.ts)

Run one from the repo root with:

```bash
node --import tsx examples/01-basic-eval.ts
```

## Development

Build:

```bash
npm run build
```

Test:

```bash
npm test
```
