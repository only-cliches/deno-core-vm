// src/index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const native = require("../index.node");

// Provide a stable V8 serialize/deserialize bridge for the native addon.
// The Rust side may emit JsValueBridge::V8Serialized values.
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const v8mod = require("node:v8");
	const g: any = globalThis as any;
	if (!g.__v8) {
		g.__v8 = {
			serialize: (value: any) => v8mod.serialize(value), // Buffer
			deserialize: (buf: any) => v8mod.deserialize(buf),
		};
	}
} catch {
	// ignore
}

type WireJson = any;

function wireUndef(): WireJson {
	return { __undef: true };
}

function wireNum(tag: string): WireJson {
	return { __num: tag };
}

function dehydrateForWire(value: any): WireJson {
	const seen = typeof WeakSet !== "undefined" ? new WeakSet<object>() : null;
	const CYCLE = Symbol("denojs_worker_cycle");

	function inner(x: any, depth: number): WireJson {
		if (x === undefined) return wireUndef();
		if (x === null) return null;
		if (depth > 200) return wireUndef();

		const t = typeof x;

		if (t === "number") {
			if (Object.is(x, -0)) return { __denojs_worker_num: "-0" };
			if (Number.isNaN(x)) return wireNum("NaN");
			if (x === Number.POSITIVE_INFINITY) return wireNum("Infinity");
			if (x === Number.NEGATIVE_INFINITY) return wireNum("-Infinity");
			if (!Number.isFinite(x)) return wireUndef();
			return x;
		}

		if (t === "string" || t === "boolean") return x;

		if (t === "bigint") {
			return { __bigint: x.toString() };
		}

		if (t === "function" || t === "symbol") return wireUndef();

		if (t === "object" && seen) {
			if (seen.has(x)) return CYCLE as any;
			seen.add(x);
		}

		if (Array.isArray(x)) {
			const out = x.map((it) => inner(it, depth + 1));
			return out.some((it) => it === CYCLE) ? wireUndef() : out;
		}

		if (typeof Date !== "undefined" && x instanceof Date) {
			return { __date: x.getTime() };
		}

		if (typeof RegExp !== "undefined" && x instanceof RegExp) {
			return { __regexp: { source: x.source, flags: x.flags } };
		}

		if (typeof URL !== "undefined" && x instanceof URL) {
			return { __url: x.href };
		}

		if (typeof URLSearchParams !== "undefined" && x instanceof URLSearchParams) {
			return { __urlSearchParams: x.toString() };
		}

		// ArrayBuffer + TypedArrays + DataView
		if (typeof ArrayBuffer !== "undefined" && x instanceof ArrayBuffer) {
			const bytes = Array.from(new Uint8Array(x));
			return { __buffer: { kind: "ArrayBuffer", bytes, byteOffset: 0, length: bytes.length } };
		}

		if (typeof SharedArrayBuffer !== "undefined" && x instanceof SharedArrayBuffer) {
			const bytes = Array.from(new Uint8Array(x));
			return { __buffer: { kind: "SharedArrayBuffer", bytes, byteOffset: 0, length: bytes.length } };
		}

		if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(x)) {
			const kind =
				x && x.constructor && typeof x.constructor.name === "string" ? x.constructor.name : "Uint8Array";
			const byteOffset = typeof x.byteOffset === "number" ? x.byteOffset : 0;
			const byteLength = typeof x.byteLength === "number" ? x.byteLength : 0;
			const length = kind === "DataView" ? byteLength : typeof (x as any).length === "number" ? (x as any).length : byteLength;

			try {
				const u8 = new Uint8Array(x.buffer, byteOffset, byteLength);
				const bytes = Array.from(u8);
				return { __buffer: { kind, bytes, byteOffset: 0, length } };
			} catch {
				return wireUndef();
			}
		}

		// Map/Set (primitive keys only)
		if (typeof Map !== "undefined" && x instanceof Map) {
			const out: any[] = [];
			for (const [k, v] of x.entries()) {
				const kt = typeof k;
				const kOk = k === null || kt === "string" || kt === "number" || kt === "boolean" || kt === "bigint";
				if (!kOk) continue;
				out.push([inner(k, depth + 1), inner(v, depth + 1)]);
			}
			return { __map: out };
		}

		if (typeof Set !== "undefined" && x instanceof Set) {
			const out: any[] = [];
			for (const v of x.values()) out.push(inner(v, depth + 1));
			return { __set: out };
		}

		// Error (best-effort)
		if (typeof Error !== "undefined" && x instanceof Error) {
			const out: any = {
				__denojs_worker_type: "error",
				name: typeof x.name === "string" ? x.name : "Error",
				message: typeof x.message === "string" ? x.message : String((x as any).message ?? ""),
			};
			if (typeof (x as any).stack === "string") out.stack = (x as any).stack;
			if ("code" in (x as any) && (x as any).code != null) out.code = String((x as any).code);

			if ("cause" in (x as any) && (x as any).cause != null) {
				out.cause = inner((x as any).cause, depth + 1);
			}
			return out;
		}

		if (t === "object") {
			const out: any = {};
			for (const [k, v] of Object.entries(x)) {
				const vv = inner(v, depth + 1);
				if (vv === CYCLE) return wireUndef();
				out[k] = vv;
			}
			return out;
		}

		return wireUndef();
	}

	const out = inner(value, 0);
	return out === CYCLE ? wireUndef() : out;
}

function dehydrateArgs(args: any[] | undefined): any[] {
	if (!Array.isArray(args)) return [];
	return args.map((a) => dehydrateForWire(a));
}

function maybeBigIntToNumber(x: bigint): number | bigint {
	const n = Number(x);
	if (Number.isSafeInteger(n) && BigInt(n) === x) return n;
	return x;
}

function cloneViewToRealm(x: any): any {
	// Preserve Buffer
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return Buffer.from(x);

	if (typeof ArrayBuffer === "undefined" || typeof ArrayBuffer.isView !== "function") return x;
	if (!ArrayBuffer.isView(x)) return x;

	const kind =
		x && x.constructor && typeof x.constructor.name === "string" ? x.constructor.name : "Uint8Array";
	const bo = typeof x.byteOffset === "number" ? x.byteOffset : 0;
	const bl = typeof x.byteLength === "number" ? x.byteLength : 0;
	const len = kind === "DataView" ? bl : typeof (x as any).length === "number" ? (x as any).length : bl;

	try {
		const src = new Uint8Array(x.buffer, bo, bl);
		const bytes = new Uint8Array(src); // copy
		const ab = bytes.buffer;

		if (kind === "DataView") return new DataView(ab, 0, bl);

		const Ctor = (globalThis as any)[kind];
		if (typeof Ctor === "function") {
			try {
				return new Ctor(ab, 0, len);
			} catch {
				// ignore
			}
		}

		return new Uint8Array(ab, 0, bytes.byteLength);
	} catch {
		return x;
	}
}

function bufferViewFromWire(obj: any): any {
	const b =
		obj && typeof obj === "object"
			? obj.__buffer && typeof obj.__buffer === "object"
				? obj.__buffer
				: typeof obj.kind === "string" && "bytes" in obj
					? obj
					: null
			: null;
	if (!b || typeof b !== "object") return undefined;

	const kind = typeof b.kind === "string" ? b.kind : "Uint8Array";
	const bytes = Array.isArray(b.bytes) ? b.bytes : [];
	const byteOffset = typeof b.byteOffset === "number" ? b.byteOffset : 0;
	const length = typeof b.length === "number" ? b.length : bytes.length;

	const u8 = new Uint8Array(bytes.map((n) => (typeof n === "number" ? n & 255 : 0)));

	if (kind === "ArrayBuffer") return u8.buffer;

	if (kind === "SharedArrayBuffer") {
		if (typeof SharedArrayBuffer !== "undefined") {
			const sab = new SharedArrayBuffer(u8.byteLength);
			new Uint8Array(sab).set(u8);
			return sab;
		}
		return u8.buffer;
	}

	const ab = u8.buffer;

	if (kind === "DataView") {
		try {
			return new DataView(ab, byteOffset, length);
		} catch {
			return undefined;
		}
	}

	const Ctor = (globalThis as any)[kind];
	if (typeof Ctor === "function") {
		try {
			return new Ctor(ab, byteOffset, length);
		} catch {
			// ignore
		}
	}

	try {
		return new Uint8Array(ab, byteOffset, length);
	} catch {
		return undefined;
	}
}

function hydrateFromWire(v: any): any {
	function inner(x: any): any {
		if (x == null) return x;

		// BigInt from another realm stays a BigInt. Convert to number if safe.
		if (typeof x === "bigint") return maybeBigIntToNumber(x);

		if (typeof x !== "object") return x;

		if (Array.isArray(x)) return x.map(inner);

		// Cross-realm clones
		const tag = Object.prototype.toString.call(x);

		if (tag === "[object Date]" && typeof (x as any).getTime === "function") {
			return new Date(Number((x as any).getTime()));
		}
		if (tag === "[object RegExp]" && typeof (x as any).source === "string") {
			try {
				return new RegExp((x as any).source, String((x as any).flags ?? ""));
			} catch {
				// ignore
			}
		}
		if (tag === "[object ArrayBuffer]") {
			try {
				const src = new Uint8Array(x as ArrayBuffer);
				return new Uint8Array(src).buffer;
			} catch {
				return x;
			}
		}
		if (tag === "[object Map]" && typeof (x as any).entries === "function") {
			const m = new Map<any, any>();
			for (const [k, v2] of (x as any).entries()) m.set(inner(k), inner(v2));
			return m;
		}
		if (tag === "[object Set]" && typeof (x as any).values === "function") {
			const s = new Set<any>();
			for (const v2 of (x as any).values()) s.add(inner(v2));
			return s;
		}
		if (tag === "[object URL]" && typeof (x as any).href === "string") {
			try {
				return new URL(String((x as any).href));
			} catch {
				return x;
			}
		}
		if (tag === "[object URLSearchParams]") {
			try {
				return new URLSearchParams(String((x as any).toString?.() ?? ""));
			} catch {
				return x;
			}
		}
		if (tag === "[object Error]") {
			const msg = typeof (x as any).message === "string" ? (x as any).message : String((x as any).message ?? "");
			const e = new Error(msg);
			if (typeof (x as any).name === "string") (e as any).name = (x as any).name;
			if (typeof (x as any).stack === "string") (e as any).stack = (x as any).stack;
			if ("code" in x && (x as any).code != null) (e as any).code = (x as any).code;
			if ("cause" in x && (x as any).cause != null) (e as any).cause = inner((x as any).cause);
			return e;
		}
		if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(x)) {
			return cloneViewToRealm(x);
		}
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(x)) return Buffer.from(x);

		// Wire tags
		if ((x as any).__undef === true) return undefined;

		if ((x as any).__denojs_worker_num === "-0") return -0;

		if ((x as any).__num === "NaN") return NaN;
		if ((x as any).__num === "Infinity") return Infinity;
		if ((x as any).__num === "-Infinity") return -Infinity;

		if ("__date" in x) return new Date(Number((x as any).__date));

		if ("__bigint" in x) {
			try {
				const bi = BigInt(String((x as any).__bigint));
				return maybeBigIntToNumber(bi);
			} catch {
				return undefined;
			}
		}

		if ((x as any).__regexp && typeof (x as any).__regexp === "object") {
			try {
				const src = String((x as any).__regexp.source ?? "");
				const flags = String((x as any).__regexp.flags ?? "");
				return new RegExp(src, flags);
			} catch {
				return undefined;
			}
		}

		if ("__url" in x) {
			try {
				return new URL(String((x as any).__url));
			} catch {
				return String((x as any).__url);
			}
		}

		if ("__urlSearchParams" in x) {
			try {
				return new URLSearchParams(String((x as any).__urlSearchParams));
			} catch {
				return String((x as any).__urlSearchParams);
			}
		}

		if ("__buffer" in x) {
			return bufferViewFromWire(x);
		}

		if ((x as any).__map !== undefined && Array.isArray((x as any).__map)) {
			const m = new Map<any, any>();
			for (const pair of (x as any).__map) {
				if (!Array.isArray(pair) || pair.length !== 2) continue;
				m.set(inner(pair[0]), inner(pair[1]));
			}
			return m;
		}

		if ((x as any).__set !== undefined && Array.isArray((x as any).__set)) {
			const s = new Set<any>();
			for (const item of (x as any).__set) s.add(inner(item));
			return s;
		}

		if ((x as any).__denojs_worker_type === "error") {
			const msg = String((x as any).message ?? "");
			const e = new Error(msg);

			if (typeof (x as any).name === "string") (e as any).name = (x as any).name;
			if (typeof (x as any).stack === "string") (e as any).stack = (x as any).stack;
			if ("code" in x && (x as any).code != null) (e as any).code = (x as any).code;

			if ("cause" in x && (x as any).cause != null) {
				(e as any).cause = inner((x as any).cause);
			}

			return e;
		}

		const out: any = {};
		for (const [k, v2] of Object.entries(x)) out[k] = inner(v2);
		return out;
	}

	return inner(v);
}

export type DenoWorkerEvent = "message" | "close";
export type DenoWorkerMessageHandler = (msg: any) => void;

export type ImportsCallbackResult = boolean | { js: string } | { resolve: string };

export type ImportsCallback = (specifier: string, referrer?: string) => ImportsCallbackResult | Promise<ImportsCallbackResult>;

export type DenoPermissionValue = boolean | string[];
export type DenoPermissions = {
	read?: DenoPermissionValue;
	write?: DenoPermissionValue;
	net?: DenoPermissionValue;
	env?: DenoPermissionValue;
	run?: DenoPermissionValue;
	ffi?: DenoPermissionValue;
	sys?: DenoPermissionValue;
	import?: DenoPermissionValue;
	hrtime?: boolean;
};

export type DenoConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
export type DenoConsoleHandler = false | undefined | ((...args: any[]) => any);
export type DenoWorkerConsoleOption = undefined | false | Console | Partial<Record<DenoConsoleMethod, DenoConsoleHandler>>;

export type DenoWorkerInspectOption =
	| undefined
	| boolean
	| {
			host?: string;
			port?: number;
			break?: boolean;
	  };

/**
 * env config:
 * - undefined: default Deno behavior
 * - string: dotenv file path to load (throws if missing or unreadable)
 * - Record<string,string>: explicit env map
 */
export type DenoWorkerEnvOption = undefined | string | Record<string, string>;

export type DenoWorkerOptions = {
	maxEvalMs?: number;
	maxMemoryBytes?: number;
	maxStackSizeBytes?: number;
	channelSize?: number;

	imports?: boolean | ImportsCallback;

	cwd?: string;
	startup?: string;

	permissions?: DenoPermissions;

	nodeResolve?: boolean;
	nodeCompat?: boolean;

	console?: DenoWorkerConsoleOption;

	env?: DenoWorkerEnvOption;

	/**
	 * Convenience dotenv loader:
	 * - true: search ".env" upwards from cwd
	 * - string: load explicit dotenv path
	 */
	envFile?: boolean | string;

	inspect?: DenoWorkerInspectOption;
};

export type EvalOptions = {
	filename?: string;
	type?: "script" | "module";
	args?: any[];
	maxEvalMs?: number;
};

export type ExecStats = {
	cpuTimeMs?: number;
	evalTimeMs?: number;
};

export type V8HeapStatistics = {
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

export type V8HeapSpaceStatistics = {
	spaceName: string;
	physicalSpaceSize: number;
	spaceSize: number;
	spaceUsedSize: number;
	spaceAvailableSize: number;
};

export type DenoWorkerMemory = {
	heapStatistics: V8HeapStatistics;
	heapSpaceStatistics: V8HeapSpaceStatistics[];
};

type NativeWorker = {
	postMessage(msg: any): boolean;
	on(event: string, cb: (...args: any[]) => void): void;
	isClosed(): boolean;

	close(): Promise<void>;
	memory(): Promise<any>;
	setGlobal(key: string, value: any): Promise<void>;

	eval(src: string, options?: EvalOptions): Promise<any>;
	evalSync(src: string, options?: EvalOptions): any;

	evalModule?: (src: string, options?: EvalOptions) => Promise<any>;

	lastExecutionStats: ExecStats;
};

function normalizeEvalOptions(options?: EvalOptions): EvalOptions | undefined {
	if (!options) return undefined;
	const out: EvalOptions = {};
	if (typeof options.filename === "string") out.filename = options.filename;
	if (options.type === "module") out.type = "module";
	if ("args" in options) out.args = Array.isArray(options.args) ? dehydrateArgs(options.args) : [];
	if (typeof options.maxEvalMs === "number" && Number.isFinite(options.maxEvalMs) && options.maxEvalMs > 0) {
		out.maxEvalMs = options.maxEvalMs;
	}
	return out;
}

function coerceMemoryPayload(raw: unknown): DenoWorkerMemory {
	const hs = (raw as any).heapStatistics;
	const hss = (raw as any).heapSpaceStatistics;
	return { heapStatistics: hs, heapSpaceStatistics: hss };
}

function normalizeConsoleOption(x: unknown): unknown {
	if (x === undefined) return undefined;
	if (x === false) return false;

	if (x && typeof x === "object") {
		const o: any = x as any;
		if (typeof o.__denojs_worker_console_mode === "string") return o;

		const out: any = {};
		const methods: DenoConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

		for (const m of methods) {
			if (!(m in o)) continue;

			const v = o[m];
			if (v === undefined) out[m] = undefined;
			else if (v === false) out[m] = false;
			else if (typeof v === "function") out[m] = v;
		}

		return out;
	}

	return undefined;
}

function normalizeEnvOption(x: unknown): unknown {
	if (x === undefined) return undefined;

	if (typeof x === "string") {
		const s = x.trim();
		return s ? s : undefined;
	}

	if (x && typeof x === "object") {
		const o: any = x as any;
		const out: Record<string, string> = {};

		for (const [k, v] of Object.entries(o)) {
			if (typeof k !== "string" || !k) continue;
			if (typeof v !== "string") continue;
			out[k] = v;
		}

		return Object.keys(out).length ? out : {};
	}

	return undefined;
}

function normalizeInspectOption(x: unknown): unknown {
	if (x === undefined) return undefined;

	if (x === true || x === false) return x;

	if (x && typeof x === "object") {
		const o: any = x as any;
		const out: any = {};

		if (typeof o.host === "string") out.host = o.host;

		if (typeof o.port === "number" && Number.isFinite(o.port) && o.port > 0 && o.port <= 65535) {
			out.port = Math.trunc(o.port);
		}

		if (typeof o.break === "boolean") out.break = o.break;

		return out;
	}

	return undefined;
}

function normalizeWorkerOptions(options?: DenoWorkerOptions): DenoWorkerWorkerOptions {
	const o: any = { ...(options ?? {}) };

	if (typeof o.nodeResolve !== "boolean") delete o.nodeResolve;
	if (typeof o.nodeCompat !== "boolean") delete o.nodeCompat;

	o.console = normalizeConsoleOption(o.console);
	o.env = normalizeEnvOption(o.env);
	o.inspect = normalizeInspectOption(o.inspect);

	if (!(typeof o.envFile === "boolean" || typeof o.envFile === "string")) delete o.envFile;
	if (typeof o.envFile === "string") {
		const s = o.envFile.trim();
		if (!s) delete o.envFile;
		else o.envFile = s;
	}

	return o as any;
}

// Alias to preserve existing exported name
type DenoWorkerWorkerOptions = DenoWorkerOptions;

function getModuleFnTag(x: any): { spec: string; name: string } | null {
	if (!x || typeof x !== "object") return null;
	const specRaw = (x as any).spec;
	const nameRaw = (x as any).name;
	const tag = (x as any).__denojs_worker_type;
	if (specRaw == null || nameRaw == null) return null;

	const spec = String(specRaw);
	const name = String(nameRaw);
	if (!spec.startsWith("denojs+")) return null;

	if (tag === "module_fn") return { spec, name };
	const keys = Object.keys(x);
	if (keys.length <= 3 && keys.every((k) => k === "__denojs_worker_type" || k === "spec" || k === "name")) {
		return { spec, name };
	}
	return null;
}

function wrapModuleNamespace<T extends Record<string, any>>(dw: DenoWorker, ns: any): T {
	if (!ns || typeof ns !== "object") return ns as T;

	const proto = Object.getPrototypeOf(ns);
	const out: any = proto === null ? Object.create(null) : {};
	const moduleSpec = typeof (ns as any).__denojs_worker_module_spec === "string" ? (ns as any).__denojs_worker_module_spec : undefined;
	const moduleFnKeys = new Set(
		Array.isArray((ns as any).__denojs_worker_module_fns)
			? (ns as any).__denojs_worker_module_fns.filter((x: any) => typeof x === "string")
			: [],
	);

	for (const [k, v] of Object.entries(ns)) {
		if (k === "__denojs_worker_module_spec" || k === "__denojs_worker_module_fns") continue;
		const modFn = getModuleFnTag(v);
		const shouldWrap = !!modFn || moduleFnKeys.has(k);
		if (shouldWrap) {
			const spec = modFn?.spec ?? moduleSpec;
			const name = modFn?.name ?? k;
			if (typeof spec !== "string") {
				out[k] = hydrateFromWire(v);
				continue;
			}

			const specJson = JSON.stringify(spec);
			const nameJson = JSON.stringify(name);

			out[k] = (...args: any[]) => {
				return dw.evalSync(`(...args) => import(${specJson}).then(m => m[${nameJson}](...args))`, { args });
			};
		} else {
			out[k] = hydrateFromWire(v);
		}
	}

	return out as T;
}

export class DenoWorker {
	private readonly native: NativeWorker;
	private closePromise: Promise<void> | null = null;
	private closed = false;

	constructor(options?: DenoWorkerOptions) {
		this.native = (native as any).DenoWorker(normalizeWorkerOptions(options)) as NativeWorker;
	}

	on(event: DenoWorkerEvent, cb: DenoWorkerMessageHandler): void {
		if (event === "message") {
			this.native.on(event, (msg: any) => {
				cb(hydrateFromWire(msg));
			});
			return;
		}
		this.native.on(event, cb);
	}

	postMessage(msg: any): void {
		if (this.isClosed()) {
			throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
		}

		const ok = this.native.postMessage(dehydrateForWire(msg));
		if (!ok) {
			throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
		}
	}

	tryPostMessage(msg: any): boolean {
		if (this.isClosed()) return false;
		return this.native.postMessage(dehydrateForWire(msg));
	}

	isClosed(): boolean {
		if (this.closed) return true;
		const nativeClosed = this.native.isClosed();
		if (nativeClosed) {
			this.closed = true;
			return true;
		}
		return this.closePromise !== null;
	}

	get lastExecutionStats(): ExecStats {
		const v: any = (this.native as any).lastExecutionStats;
		if (!v || typeof v !== "object") return {};

		const cpu = v.cpuTimeMs;
		const evalt = v.evalTimeMs;

		if (typeof cpu === "number" && typeof evalt === "number") {
			return { cpuTimeMs: cpu, evalTimeMs: evalt };
		}
		return {};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (this.closePromise) return this.closePromise;

		this.closePromise = this.native
			.close()
			.then(() => {
				this.closed = true;
			})
			.catch((e: any) => {
				this.closePromise = null;
				throw hydrateFromWire(e);
			});

		await this.closePromise;
	}

	async memory(): Promise<DenoWorkerMemory> {
		const raw = await this.native.memory();
		return coerceMemoryPayload(raw);
	}

	async setGlobal(key: string, value: any): Promise<void> {
		try {
			const payload = value === undefined ? null : typeof value === "function" ? value : dehydrateForWire(value);
			await this.native.setGlobal(key, payload);
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	async eval(src: string, options?: EvalOptions): Promise<any> {
		try {
			const raw = await this.native.eval(src, normalizeEvalOptions(options));
			return hydrateFromWire(raw);
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	evalSync(src: string, options?: EvalOptions): any {
		try {
			const raw = this.native.evalSync(src, normalizeEvalOptions(options));
			return hydrateFromWire(raw);
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	async evalModule<T extends Record<string, any> = Record<string, any>>(
		source: string,
		options?: Omit<EvalOptions, "type">,
	): Promise<T> {
		let raw: any;
		try {
			if (typeof this.native.evalModule === "function") {
				raw = await this.native.evalModule(source, normalizeEvalOptions({ ...(options ?? {}), type: "module" }));
			} else {
				raw = await this.eval(source, { ...(options ?? {}), type: "module" });
			}
		} catch (e) {
			throw hydrateFromWire(e);
		}
		return wrapModuleNamespace<T>(this, raw);
	}
}

export default DenoWorker;
