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
	/** Subprocess execution access. */
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
 * - using `env` or `envFile` automatically enables runtime env permission.
 */
export type DenoWorkerEnvOption = undefined | string | Record<string, string>;

/**
 * Optional module loading extensions.
 *
 * `denoRemote`: allow `http(s)` module specifiers.
 * `transpileTs`: allow `.ts/.tsx/.jsx` module loads.
 * `tsCompiler`: optional TS/JSX transpile settings.
 */
export type DenoWorkerModuleLoaderOption =
	| undefined
	| {
			/** Enable `http(s)` module specifiers. */
			denoRemote?: boolean;
			/** Enable transpilation for `.ts`, `.tsx`, and `.jsx` module sources. */
			transpileTs?: boolean;
			tsCompiler?: {
				/** JSX transform mode for transpilation. */
				jsx?: "react" | "react-jsx" | "react-jsxdev" | "preserve";
				/** JSX factory function for classic React transform mode. */
				jsxFactory?: string;
				/** JSX fragment factory for classic React transform mode. */
				jsxFragmentFactory?: string;
			};
			/** Directory used to cache remotely loaded modules. */
			cacheDir?: string;
			/** Bypass remote cache and always re-fetch. */
			reload?: boolean;
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
	/**
	 * Default per-evaluation timeout (milliseconds).
	 *
	 * Can be overridden per call with `eval(..., { maxEvalMs })`.
	 */
	maxEvalMs?: number;
	/** Maximum V8 heap size in bytes. */
	maxMemoryBytes?: number;
	/** Maximum stack size in bytes. */
	maxStackSizeBytes?: number;
	/**
	 * Internal command queue capacity.
	 *
	 * Smaller values trigger backpressure sooner; larger values buffer more in-flight work.
	 */
	channelSize?: number;

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

	/** Enable Node-style disk/module resolution behavior. */
	nodeResolve?: boolean;
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
	 * Using `envFile` automatically enables runtime env permission.
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
	/**
	 * Extended module loading behavior.
	 *
	 * Use for remote imports, TS/TSX/JSX transpilation, and cache tuning.
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
};
