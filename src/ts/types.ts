/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DenoWorker } from "./worker";

/**
 * Event names supported by {@link DenoWorker.on}.
 *
 * - `message`: payloads posted from inside the runtime via `postMessage(...)`.
 * - `close`: emitted when the runtime closes.
 * - `lifecycle`: control-plane lifecycle transitions (`beforeStart`, `afterStart`, etc).
 */
export type DenoWorkerEvent = "message" | "close" | "lifecycle";
export type DenoWorkerMessageHandler = (msg: any) => void;
export type DenoWorkerCloseHandler = () => void;

/**
 * Result shape for import policy callbacks.
 *
 * Examples:
 * - `true`: allow default disk loading
 * - `false`: block import
 * - `{ js: "export default 1" }`: provide in-memory JS source
 * - `{ tsx: "export default <div />" }`: provide in-memory TS/JSX source
 * - `{ resolve: "file:///abs/path/mod.ts" }`: redirect to another module specifier
 */
export type ImportsCallbackTypedSource =
    | {
            /** JavaScript module source text. */
            js: string;
      }
    | {
            /** TypeScript module source text. */
            ts: string;
      }
    | {
            /** TSX module source text. */
            tsx: string;
      }
    | {
            /** JSX module source text. */
            jsx: string;
      };

export type ImportsCallbackResult =
    | boolean
    | ImportsCallbackTypedSource
    | {
            /** Replacement specifier to resolve instead of the original. */
            resolve: string;
      };

/**
 * Dynamic import policy callback.
 *
 * @example
 * ```ts
 * const imports = (specifier: string) => {
 *   if (specifier.startsWith("https://")) return false;
 *   return true;
 * };
 * ```
 */
export type ImportsCallback = (
    specifier: string,
    referrer?: string,
    isDynamicImport?: boolean,
) => ImportsCallbackResult | Promise<ImportsCallbackResult>;

/**
 * Permission field value shape.
 *
 * - `true`: allow all for that capability.
 * - `false`: deny all for that capability.
 * - `string[]`: allow-list for that capability.
 */
export type DenoPermissionValue = boolean | string[];
/**
 * Deno permission model passed to runtime creation.
 *
 * `true` means allow-all for that capability.
 * `string[]` means allow-list for that capability.
 *
 * @example
 * ```ts
 * permissions: {
 *   read: ["./data"],
 *   env: ["API_KEY"],
 *   net: ["example.com:443"]
 * }
 * ```
 */
export type DenoPermissions = {
    /** File system read access. `true` = allow all, `string[]` = allow list. */
    read?: DenoPermissionValue;
    /** File system write access. `true` = allow all, `string[]` = allow list. */
    write?: DenoPermissionValue;
    /** Network access. `true` = allow all, `string[]` = allow host[:port] allow list. */
    net?: DenoPermissionValue;
    /** Environment variable access. `true` = allow all, `string[]` = variable allow list. */
    env?: DenoPermissionValue;
    /** Subprocess execution access (treat as high-risk; spawned processes may inherit host env unless explicitly constrained). */
    run?: DenoPermissionValue;
    /** Native FFI access. */
    ffi?: DenoPermissionValue;
    /** System information access. */
    sys?: DenoPermissionValue;
    /** Import capability permission (Deno import permission model). */
    import?: DenoPermissionValue;
    /** High-resolution timing access. */
    hrtime?: boolean;
};

export type DenoConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
/**
 * Console callback type used by {@link DenoWorkerConsoleOption}.
 *
 * Async handlers are supported but are invoked in fire-and-forget mode.
 * Their returned Promise is not awaited by worker `console.*` calls.
 */
export type DenoConsoleHandler = false | undefined | ((...args: any[]) => any) | Promise<((...args: any[]) => any)>;
/**
 * Console routing configuration for the runtime.
 *
 * Supported forms:
 *
 * - `undefined`: keep runtime defaults (pass console to stdout/stderr)
 * - `false`: disable all `console.log/info/warn/error/debug/trace` calls.
 * - `Console`: pass host console object (`console: console`).
 * - partial object: selectively override/disable methods.
 *   - function: route method to host callback
 *   - `false`: disable that specific method
 *   - `undefined`/missing: keep runtime default for that method
 *
 * Behavior note:
 * - async callback Promises are not awaited by runtime `console.*` calls.
 * - prefer sync callbacks for low-latency streaming logs.
 *
 * @example
 * ```ts
 * console: {
 *   log: (...args) => hostLogger.info(args),
 *   error: (...args) => hostLogger.error(args),
 *   debug: false
 * }
 * ```
 */
export type DenoWorkerConsoleOption = undefined | false | Console | Partial<Record<DenoConsoleMethod, DenoConsoleHandler>>;

/**
 * Inspector configuration.
 *
 * @example
 * ```ts
 * inspect: { host: "127.0.0.1", port: 9229, break: false }
 * ```
 */
export type DenoWorkerInspectOption =
    | undefined
    | boolean
    | {
            /** Inspector bind host (default `127.0.0.1`). */
            host?: string;
            /** Inspector TCP port (default `9229`). */
            port?: number;
            /** Pause on first statement until debugger attaches. */
            break?: boolean;
      };

/**
 * Runtime environment config.
 *
 * - `undefined`: default runtime env behavior.
 * - `string`: dotenv file path to load (throws if missing/unreadable).
 * - `Record<string,string>`: explicit env map.
 *
 * Notes:
 * - `env` overrides `envFile` when both are provided.
 * - when `env` is a map and `permissions.env` is missing (or `[]`), the runtime
 *   auto-populates `permissions.env` with those env-map keys.
 * - if `permissions.env` is already configured, it is not changed.
 */
export type DenoWorkerEnvOption = undefined | string | Record<string, string>;

/**
 * Optional module loading extensions.
 *
 * `httpsResolve`: allow `https://` module specifiers.
 * `httpResolve`: allow `http://` module specifiers (warned at startup).
 * `nodeResolve`: enable Node-style disk/module resolution.
 * `jsrResolve`: resolve `jsr:` and `@std/*` via `https://jsr.io/...`.
 * `transpileTs`: allow `.ts/.tsx/.jsx` module loads.
 * `tsCompiler`: optional TS/JSX transpile settings.
 */
export type DenoWorkerModuleLoaderOption =
    | undefined
    | {
            /** Enable `https://` module specifiers. */
            httpsResolve?: boolean;
            /** Enable `http://` module specifiers (insecure; startup warning emitted). */
            httpResolve?: boolean;
            /** Enable Node-style disk/module resolution behavior. */
            nodeResolve?: boolean;
            /** Enable `jsr:` / `@std/*` resolution through jsr.io HTTPS URLs. */
            jsrResolve?: boolean;
            /** Directory used to cache remotely loaded modules. */
            cacheDir?: string;
            /** Bypass remote cache and always re-fetch. */
            reload?: boolean;
            /** Maximum remote module payload bytes. `-1` disables limit. */
            maxPayloadBytes?: number;
      };

export type DenoWorkerTsCompilerOption =
    | undefined
    | {
            /** JSX transform mode for transpilation. */
            jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
            /** JSX factory function for classic React transform mode. */
            jsxFactory?: string;
            /** JSX fragment factory for classic React transform mode. */
            jsxFragmentFactory?: string;
            /** Optional on-disk directory for transpiled compiler output cache. */
            cacheDir?: string;
      };

export type DenoWorkerBridgeOption =
    | undefined
    | {
            /**
             * Per-queue capacity for internal host/runtime bridge channels.
             *
             * The runtime currently maintains separate bounded queues for:
             * - control-plane work (`eval`, `setGlobal`, `memory`, `close`)
             * - data-plane work (`postMessage` and stream envelopes)
             * - node callback dispatch (`message`/`close`/host-callback settlements)
             *
             * So `channelSize` applies to each queue independently (not one
             * global shared queue). Effective total buffered message slots can
             * approach roughly `3 * channelSize` under load.
             *
             * Default: `512`.
             *
             * Sane range:
             * - typical: `128` to `4096`
             * - stress/high parallelism: up to `8192`
             *
             * If too low:
             * - producers hit backpressure sooner
             * - lower burst throughput
             * - more time spent awaiting queue space
             *
             * If too high:
             * - more queued work can accumulate before pressure is visible
             * - higher peak memory usage during bursts
             * - higher tail latency under overload (larger queue to drain)
             *
             */
            channelSize?: number;
            /**
             * Per-stream flow-control window in bytes (writer credit budget).
             *
             * Default: `16777216` (`16 MiB`).
             *
             * Sane range:
             * - typical: `4 MiB` to `64 MiB`
             * - memory-constrained: `1 MiB` to `4 MiB`
             *
             * If too low:
             * - frequent credit stalls on large writes
             * - reduced stream throughput
             * - more scheduler/IPC overhead from tighter pacing
             *
             * If too high:
             * - more in-flight bytes per stream before backpressure
             * - higher memory footprint with many concurrent streams
             * - slower detection of imbalanced producers/consumers
             *
             * Cost of increasing:
             * - memory reservation pressure scales with `active_streams * streamWindowBytes`
             * - larger bursts can increase GC pressure and pause variance
             * - higher per-stream worst-case buffered bytes before throttling engages
             */
            streamWindowBytes?: number;
            /**
             * Bytes consumed before sending accumulated stream credit updates.
             *
             * Default: `262144` (`256 KiB`).
             *
             * Sane range:
             * - typical: `64 KiB` to `1 MiB`
             * - low-latency tuning: `32 KiB` to `128 KiB`
             *
             * If too low:
             * - excessive `credit` control frames
             * - more protocol overhead / CPU spent on bookkeeping
             *
             * If too high:
             * - writers wait longer before receiving replenished credit
             * - burstier pacing and lower steady-state throughput
             * - more visible jitter for medium-size chunk streams
             *
             * Cost of increasing:
             * - fewer credit frames (lower control overhead) but coarser flow-control
             * - larger “credit lump” behavior, which can increase burstiness
             * - potential underutilization on latency-sensitive or mid-size workloads
             */
            streamCreditFlushBytes?: number;
            /**
             * Maximum number of worker->Node streams that may remain opened but not yet accepted on Node side.
             *
             * This caps the host-side backlog map used when stream `open` frames arrive before `stream.accept(key)`.
             * When the limit is reached, additional incoming `open` frames are rejected until backlog entries are consumed.
             *
             * Default: `256`.
             *
             * Sane range:
             * - typical: `64` to `2048`
             * - high fanout/burst: up to `8192`
             *
             * If too low:
             * - worker->Node producers can see earlier stream-open rejections
             * - requires faster/earlier Node `stream.accept(...)` consumption
             *
             * If too high:
             * - more idle stream reader state can accumulate
             * - higher peak memory under key-fanout bursts
             */
            streamBacklogLimit?: number;
      };

/**
 * Lifecycle phases emitted by runtime orchestration.
 */
export type DenoWorkerLifecyclePhase = "beforeStart" | "afterStart" | "beforeStop" | "afterStop" | "onCrash";
/**
 * Context object provided to lifecycle callbacks and `on("lifecycle")` listeners.
 */
export type DenoWorkerLifecycleContext = {
    /** Lifecycle phase being emitted. */
    phase: DenoWorkerLifecyclePhase;
    /** Runtime instance associated with the lifecycle event, when available. */
    worker?: DenoWorker;
    /** Creation options used for this runtime, when available. */
    options?: DenoWorkerOptions;
    /** Error or reason associated with the lifecycle transition. */
    reason?: unknown;
    /** Indicates whether shutdown/restart was requested intentionally. */
    requested?: boolean;
};
export type DenoWorkerLifecycleHooks = Partial<
    Record<DenoWorkerLifecyclePhase, (ctx: DenoWorkerLifecycleContext) => void>
>;
export type DenoWorkerLifecycleHandler = (ctx: DenoWorkerLifecycleContext) => void;

/** Worker limit controls for execution, memory, wasm loading, and handle capacity. */
export type DenoWorkerLimits = {
    /**
     * Description: maximum number of allowed simultaneously active handle references on this worker.
     * Default: `128`.
     * Min recommended: `16`.
     * Max recommended: `4096`.
     */
    maxHandle?: number;
    /**
     * Description: default per-evaluation timeout in milliseconds.
     * Applies to runtime execution surfaces including `eval`, `evalSync`, `evalModule`, `importModule`, and handle operations that execute code in runtime (for example `handle.call`, `handle.apply`, `handle.await`).
     * Can be overridden per call via:
     * - `EvalOptions.maxEvalMs` on `eval`/`evalSync`/`evalModule`
     * - `DenoWorkerHandleExecOptions.maxEvalMs` on handle methods
     * Default: unset (no default timeout).
     * Min recommended: `10`.
     * Max recommended: `120000`.
     */
    maxEvalMs?: number;
    /**
     * Description: maximum V8 heap size in bytes.
     * Default: unset (runtime default).
     * Min recommended: `33554432` (32 MiB).
     * Max recommended: `2147483648` (2 GiB).
     */
    maxMemoryBytes?: number;
    /**
     * Description: toggles WebAssembly module loading by `.wasm` specifier.
     * When `false`, importing `.wasm` modules is rejected by the loader.
     * Default: `true`.
     * Min recommended: n/a.
     * Max recommended: n/a.
     */
    wasm?: boolean;
};

/**
 * Runtime creation options for {@link DenoWorker}.
 *
 * @example
 * ```ts
 * const dw = new DenoWorker({
 *   cwd: "/srv/app",
 *   permissions: { read: true, env: ["API_KEY"] },
 *   env: { API_KEY: "dev-key" },
 *   lifecycle: {
 *     beforeStart: () => console.log("starting"),
 *     afterStop: () => console.log("stopped"),
 *   },
 * });
 * ```
 */
export type DenoWorkerOptions = {
    /** Runtime limits bundle (timeouts, memory caps, handle cap). */
    limits?: DenoWorkerLimits;
    /** Bridge transport tuning (queue capacity and stream flow-control). */
    bridge?: DenoWorkerBridgeOption;

    /**
     * Import policy.
     *
     * - `false`: block imports
     * - `true`: allow default disk/module resolution
     * - callback: decide per import (allow/block/virtual source/rewrite)
     */
    imports?: boolean | ImportsCallback;

    /** Runtime working directory used for relative path resolution. */
    cwd?: string;
    /** Startup script evaluated before user code runs. */
    startup?: string;

    /**
     * Runtime permissions configuration.
     *
     * Use `true` for allow-all, `false` for deny-all, or `string[]` allow-lists.
     */
    permissions?: DenoPermissions;

    /** Enable broader Node compatibility helpers. */
    nodeCompat?: boolean;

    /**
     * Console routing behavior for runtime `console.*`.
     *
     * See {@link DenoWorkerConsoleOption}.
     */
    console?: DenoWorkerConsoleOption;

    /**
     * Runtime environment variable configuration.
     *
     * See {@link DenoWorkerEnvOption}.
     */
    env?: DenoWorkerEnvOption;

    /**
     * Convenience dotenv loader:
     * - `true`: search `.env` upwards from `cwd`
     * - `string`: load explicit dotenv path
     *
     * Ignored when `env` is explicitly provided.
     * Env permissions follow the same rules as {@link DenoWorkerEnvOption}:
     * missing/empty `permissions.env` is key-populated from configured env map;
     * existing `permissions.env` is left unchanged.
     */
    envFile?: boolean | string;

    /**
     * Inspector enable/configuration.
     *
     * - `true`: enable with defaults (`127.0.0.1:9229`, no break)
     * - `false`/`undefined`: disabled
     * - object: custom host/port/break settings
     */
    inspect?: DenoWorkerInspectOption;
    /** Enable transpilation for eval/imported `.ts/.tsx/.jsx` sources. */
    transpileTs?: boolean;
    /** TypeScript/JSX transpiler settings (and optional compiler cache directory). */
    tsCompiler?: DenoWorkerTsCompilerOption;
    /**
     * Extended module loading behavior.
     *
     * Use for remote imports and remote source cache tuning.
     */
    moduleLoader?: DenoWorkerModuleLoaderOption;
    /**
     * Globals injected during worker startup (`globalThis[key] = value`).
     *
     * Supports values, objects, and functions (including nested object functions).
     */
    globals?: Record<string, any>;
    /** Lifecycle hooks invoked around start/stop/crash transitions. */
    lifecycle?: DenoWorkerLifecycleHooks;
};

/**
 * Base template options used by {@link DenoWorkerTemplate}.
 *
 * @example
 * ```ts
 * const template = new DenoWorkerTemplate({
 *   workerOptions: { permissions: { env: true } },
 *   globals: { APP_NAME: "director" },
 *   bootstrapScripts: "globalThis.VERSION = 1;",
 * });
 * ```
 */
export type DenoWorkerTemplateOptions = {
    /** Base worker options merged into each runtime created from this template. */
    workerOptions?: DenoWorkerOptions;
    /** Globals injected before bootstrap/evaluation. */
    globals?: Record<string, any>;
    /** Bootstrap script(s) evaluated at runtime startup. */
    bootstrapScripts?: string | string[];
    /** Bootstrap module specifier(s) imported at runtime startup. */
    bootstrapModules?: string | string[];
    /** Optional host-side setup hook after runtime creation. */
    setup?: (worker: DenoWorker) => void | Promise<void>;
};

/**
 * Per-runtime overrides applied on `template.create(...)`.
 */
export type DenoWorkerTemplateCreateOptions = {
    /** Per-runtime worker option overrides. */
    workerOptions?: DenoWorkerOptions;
    /** Per-runtime globals merged over template globals. */
    globals?: Record<string, any>;
    /** Additional bootstrap script(s) for this runtime instance. */
    bootstrapScripts?: string | string[];
    /** Additional bootstrap module(s) for this runtime instance. */
    bootstrapModules?: string | string[];
    /** Per-runtime setup hook invoked after create/start. */
    setup?: (worker: DenoWorker) => void | Promise<void>;
};

/**
 * Metadata attached to director-managed runtimes as `runtime.meta`.
 */
export type DenoRuntimeMeta = {
    /** Unique runtime identifier. */
    id: string;
    /** Optional human-readable label. */
    label?: string;
    /** Free-form tags used for grouping/filtering. */
    tags: string[];
    /** Creation timestamp (epoch milliseconds). */
    createdAt: number;
};

export type DenoDirectedRuntime = DenoWorker & {
    /** Immutable metadata for this director-managed runtime. */
    readonly meta: DenoRuntimeMeta;
};

export type DenoRuntimeRecord = {
    /** Runtime metadata. */
    meta: DenoRuntimeMeta;
    /** Runtime instance. */
    runtime: DenoDirectedRuntime;
};

/**
 * Options for creating a {@link DenoDirector}.
 */
export type DenoDirectorOptions = {
    /** Default template used when starting runtimes through the director. */
    template?: DenoWorkerTemplateOptions;
};

/**
 * Runtime start options for {@link DenoDirector.start}.
 *
 * @example
 * ```ts
 * const rt = await dd.start({
 *   id: "runtime-1",
 *   label: "tenant-a",
 *   tags: ["canary", "billing"],
 *   globals: { TENANT: "a" },
 * });
 * ```
 */
export type DenoDirectorStartOptions = DenoWorkerTemplateCreateOptions & {
    /** Optional explicit runtime id. Auto-generated when omitted. */
    id?: string;
    /** Optional runtime label for list/filter operations. */
    label?: string;
    /** Optional runtime tags for list/filter operations. */
    tags?: string[];
};

/**
 * Runtime query filter for {@link DenoDirector.list}.
 */
export type DenoDirectorListOptions = {
    /** Filter by exact runtime label. */
    label?: string;
    /** Filter to runtimes containing this tag. */
    tag?: string;
};

/**
 * Evaluation call options for `eval`, `evalSync`, and `evalModule`.
 */
export type EvalOptions = {
    /** Virtual filename used in stack traces and diagnostics. */
    filename?: string;
    /** Source interpretation mode. */
    type?: "script" | "module";
    /** Positional args exposed to eval entrypoint (bridge-dehydrated). */
    args?: any[];
    /** Per-call timeout override in milliseconds. */
    maxEvalMs?: number;
};

export type ExecStats = {
    /** CPU time consumed by the last execution (milliseconds). */
    cpuTimeMs?: number;
    /** Wall-clock execution time for the last call (milliseconds). */
    evalTimeMs?: number;
};

export type V8HeapStatistics = {
    /** Total heap size in bytes. */
    totalHeapSize: number;
    /** Executable heap size in bytes. */
    totalHeapSizeExecutable: number;
    /** Total physical memory used by heap in bytes. */
    totalPhysicalSize: number;
    /** Remaining available heap size in bytes. */
    totalAvailableSize: number;
    /** Used heap size in bytes. */
    usedHeapSize: number;
    /** Heap size limit in bytes. */
    heapSizeLimit: number;
    /** Memory allocated via malloc in bytes. */
    mallocedMemory: number;
    /** External memory tracked by V8 in bytes. */
    externalMemory: number;
    /** Peak malloced memory in bytes. */
    peakMallocedMemory: number;
    /** Count of active native contexts. */
    numberOfNativeContexts: number;
    /** Count of detached native contexts. */
    numberOfDetachedContexts: number;
    /** Whether V8 zaps garbage memory for debug safety. */
    doesZapGarbage: boolean;
};

export type V8HeapSpaceStatistics = {
    /** Heap space name. */
    spaceName: string;
    /** Physical size of this heap space in bytes. */
    physicalSpaceSize: number;
    /** Reserved size of this heap space in bytes. */
    spaceSize: number;
    /** Used size of this heap space in bytes. */
    spaceUsedSize: number;
    /** Available size of this heap space in bytes. */
    spaceAvailableSize: number;
};

export type DenoWorkerMemory = {
    /** Aggregate V8 heap statistics snapshot. */
    heapStatistics: V8HeapStatistics;
    /** Per-heap-space statistics snapshot. */
    heapSpaceStatistics: V8HeapSpaceStatistics[];
};

/**
 * Runtime shutdown options for {@link DenoWorker.close}.
 *
 * - `force: true` rejects in-flight wrapper promises immediately and issues
 *   a best-effort background close to native runtime.
 */
export type DenoWorkerCloseOptions = {
    /** Force-close runtime immediately and reject in-flight promises. */
    force?: boolean;
};

/**
 * Runtime restart options for {@link DenoWorker.restart}.
 *
 * - `force: true` performs a forced close first.
 */
export type DenoWorkerRestartOptions = {
    /** Force-close before restart. */
    force?: boolean;
};

/**
 * Writable side of a cross-runtime byte stream.
 */
export type DenoWorkerStreamWriter = {
    /** Return the stream key for this writer. */
    getKey(): string;
    /** Wait until at least `minBytes` can be sent without exceeding flow-control window. */
    ready(minBytes?: number): Promise<void>;
    /** Write one byte chunk to the remote stream. */
    write(chunk: Uint8Array | ArrayBuffer): Promise<void>;
    /** Write many chunks in one call. Returns number of accepted chunks. */
    writeMany(chunks: Array<Uint8Array | ArrayBuffer>): Promise<number>;
    /** Gracefully close the stream. */
    close(): Promise<void>;
    /** Close with an error on the remote side. */
    error(message: string): Promise<void>;
    /** Cancel stream delivery. */
    cancel(reason?: string): Promise<void>;
};

/**
 * Readable side of a cross-runtime byte stream.
 *
 * Supports both explicit `read()` and `for await ... of`.
 */
export type DenoWorkerStreamReader = AsyncIterable<Uint8Array> & {
    read(): Promise<IteratorResult<Uint8Array>>;
    cancel(reason?: string): Promise<void>;
};

export type DenoWorkerStreamApi = {
    create(key?: string): DenoWorkerStreamWriter;
    accept(key: string): Promise<DenoWorkerStreamReader>;
};

export type DenoWorkerHandleType =
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

export type DenoWorkerHandleTypeInfo = {
    type: DenoWorkerHandleType;
    callable: boolean;
    constructorName?: string;
};

export type DenoWorkerHandleApplyOp =
    | { op: "get"; path?: string }
    | { op: "set"; path: string; value: any }
    | { op: "call"; path?: string; args?: any[] }
    | { op: "has"; path: string }
    | { op: "delete"; path: string }
    | { op: "getType"; path?: string }
    | { op: "toJSON"; path?: string }
    | { op: "isCallable"; path?: string }
    | { op: "isPromise"; path?: string };

export type DenoWorkerHandleAwaitOptions = {
    /** When true (default), resolve with the awaited value. When false, resolve with `undefined`. */
    returnValue?: boolean;
    /**
     * Continue awaiting while the resolved value is still promise-like.
     *
     * Useful for aggressively unwrapping custom thenable/promise chains.
     */
    untilNonPromise?: boolean;
};

/**
 * Per-handle-operation execution limits.
 *
 * This currently supports the same per-call eval timeout override used by
 * top-level `eval`/`evalSync`.
 */
export type DenoWorkerHandleExecOptions = {
    /** Per-call timeout override in milliseconds for this handle operation. */
    maxEvalMs?: number;
};

/**
 * Handle to a runtime-side value with explicit lifetime management.
 *
 * Handle operations are resolved relative to the handle root value.
 */
export type DenoWorkerHandle = {
    /** Opaque handle id unique within a worker epoch. */
    readonly id: string;
    /** Root value type snapshot captured when the handle was created. */
    readonly rootType: DenoWorkerHandleTypeInfo;
    /** True after `dispose()` is called or worker lifecycle invalidates the handle. */
    readonly disposed: boolean;
    /** Get the handle root or a nested property under the handle root (`a.b.c` dot notation). */
    get(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any>;
    /** Returns true when a nested path exists under the handle root (`a.b.c` dot notation). */
    has(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Set a nested property under the handle root (`a.b.c` dot notation). */
    set(path: string, value: any, options?: DenoWorkerHandleExecOptions): Promise<void>;
    /** Delete a nested property under the handle root (`a.b.c` dot notation). */
    delete(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Return enumerable keys for objects/maps/sets at root or nested path. */
    keys(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
    /** Return entries for objects/maps/sets at root or nested path. */
    entries(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]>;
    /** Return own-property descriptor for a nested property path (`a.b.c` dot notation). */
    getOwnPropertyDescriptor(path: string, options?: DenoWorkerHandleExecOptions): Promise<PropertyDescriptor | undefined>;
    /** Define a nested property via descriptor semantics (`a.b.c` dot notation). */
    define(path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Check root value `instanceof` a constructor resolved from globalThis path. */
    instanceOf(constructorPath: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Return true when root value (or nested path value) is callable. */
    isCallable(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Return true when root value (or nested path value) is promise-like (`then` function). */
    isPromise(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean>;
    /** Call the handle root function with args. */
    call(args?: any[], options?: DenoWorkerHandleExecOptions): Promise<any>;
    /** Call a nested function path under the handle root with args (`a.b.c` dot notation). */
    call(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<any>;
    /** Construct a new value with root function/class as constructor. */
    construct(args?: any[], options?: DenoWorkerHandleExecOptions): Promise<any>;
    /** Await root value and update handle root to the resolved value. */
    await(options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions): Promise<any>;
    /** Clone this handle to a new handle id that references the same runtime value. */
    clone(options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>;
    /** JSON snapshot for root or nested path value. */
    toJSON(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any>;
    /**
     * Apply a sequence of operations in one runtime roundtrip.
     * Supported op kinds: `get`, `set`, `call`, `has`, `delete`, `getType`, `toJSON`, `isCallable`, `isPromise`.
     */
    apply(ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions): Promise<any[]>;
    /** Return type metadata for the root value or nested property. */
    getType(path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo>;
    /** Release runtime-side handle reference. Idempotent. */
    dispose(options?: DenoWorkerHandleExecOptions): Promise<void>;
};

/** Handle namespace exposed on `DenoWorker.handle`. */
export type DenoWorkerHandleApi = {
    /**
     * Create a handle to an existing runtime value path rooted at `globalThis` (`a.b.c` dot notation).
     *
     * `options.maxEvalMs` becomes the handle-level default timeout for subsequent handle calls.
     */
    get(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle>;
    /**
     * Best-effort variant of `get(path)`.
     *
     * Returns `undefined` when path is missing in runtime.
     * `options.maxEvalMs` becomes the handle-level default timeout for subsequent handle calls.
     */
    tryGet(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle | undefined>;
    /**
     * Evaluate source and return a handle to the resulting runtime value.
     *
     * `options.maxEvalMs` is used both for creation and as the handle-level default timeout for subsequent handle calls.
     */
    eval(source: string, options?: Omit<EvalOptions, "args" | "type">): Promise<DenoWorkerHandle>;
};

/**
 * Internal addon shape used by the TypeScript wrapper.
 * Exported for typing convenience.
 */
export type NativeWorker = {
    /** Post a message into runtime `onmessage` handlers. */
    postMessage(msg: any): boolean;
    /** Batch post messages; returns accepted count. */
    postMessages?: (msgs: any[]) => number;
    /** Register a low-level event listener on native worker bridge. */
    on(event: string, cb: (...args: any[]) => void): void;
    /** Return whether runtime is already closed. */
    isClosed(): boolean;

    /** Close runtime gracefully. */
    close(): Promise<void>;
    /** Immediate best-effort native handle disposal used by force close. */
    forceDispose?: () => void;
    /** Internal helper to check native registry membership. */
    __isRegistered?: () => boolean;
    /** Fetch runtime memory statistics. */
    memory(): Promise<any>;
    /** Set a global value inside runtime context. */
    setGlobal(key: string, value: any): Promise<void>;

    /** Evaluate script/module source asynchronously. */
    eval(src: string, options?: EvalOptions): Promise<any>;
    /** Evaluate source synchronously. */
    evalSync(src: string, options?: EvalOptions): any;

    /** Evaluate source as module and resolve module result/namespace. */
    evalModule?: (src: string, options?: EvalOptions) => Promise<any>;

    /** Last recorded execution stats snapshot. */
    lastExecutionStats: ExecStats;
    /** Actual inspector port bound by runtime (undefined if inspect is disabled/unbound). */
    inspectPort?: number;
};
