/* eslint-disable @typescript-eslint/no-explicit-any */

import { nativeAddon } from "./native";
import { wrapModuleNamespace } from "./module-namespace";
import { coerceMemoryPayload, normalizeEvalOptions, normalizeWorkerOptions } from "./options";
import { dehydrateForWire, hydrateFromWire } from "./wire";
import type {
	DenoWorkerCloseHandler,
	DenoWorkerEvent,
	DenoWorkerLifecycleContext,
	DenoWorkerLifecycleHandler,
	DenoWorkerLifecycleHooks,
	DenoWorkerLifecyclePhase,
	DenoWorkerCloseOptions,
	DenoWorkerMemory,
	DenoWorkerMessageHandler,
	DenoWorkerOptions,
	DenoWorkerRestartOptions,
	EvalOptions,
	ExecStats,
	NativeWorker,
} from "./types";

export class DenoWorker {
	private native: NativeWorker;
	private closePromise: Promise<void> | null = null;
	private closed = false;
	private closeRequested = false;
	private readonly lifecycleHooks?: DenoWorkerLifecycleHooks;
	private readonly creationOptions?: DenoWorkerOptions;
	private readonly messageHandlers = new Set<DenoWorkerMessageHandler>();
	private readonly closeHandlers = new Set<DenoWorkerCloseHandler>();
	private readonly lifecycleHandlers = new Set<DenoWorkerLifecycleHandler>();
	private readonly inFlightRejectors = new Set<(reason: unknown) => void>();
	private nativeEpoch = 0;
	private startupPromise: Promise<void> = Promise.resolve();
	private startupReady = true;
	private startupError: unknown = null;

	private isBinaryLikeValue(value: any): boolean {
		if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
		if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
		if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return true;
		if (
			typeof ArrayBuffer !== "undefined" &&
			typeof ArrayBuffer.isView === "function" &&
			ArrayBuffer.isView(value)
		) {
			// Keep fast-path conservative for setGlobal to preserve typed-array class fidelity.
			return false;
		}
		return false;
	}

	private serializeGlobalValue(value: any, seen?: WeakSet<object>): any {
		if (value === undefined) return null;
		if (value === null) return null;

		const t = typeof value;
		if (t === "function") return value;
		if (t !== "object") return value;

		const ws = seen ?? new WeakSet<object>();
		if (ws.has(value)) return null;
		ws.add(value);

		const isSpecial =
			value instanceof Date ||
			value instanceof RegExp ||
			(typeof URL !== "undefined" && value instanceof URL) ||
			(typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) ||
			(typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) ||
			(typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) ||
			(typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(value)) ||
			value instanceof Map ||
			value instanceof Set ||
			value instanceof Error ||
			(typeof Buffer !== "undefined" && Buffer.isBuffer(value));

		if (isSpecial) return dehydrateForWire(value);

		if (Array.isArray(value)) return value.map((x) => this.serializeGlobalValue(x, ws));

		const out: Record<string, any> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = this.serializeGlobalValue(v, ws);
		}
		return out;
	}

	private async setGlobalInternal(key: string, value: any): Promise<void> {
		try {
			const payload = this.isBinaryLikeValue(value) ? value : this.serializeGlobalValue(value);
			await this.trackInFlight(this.native.setGlobal(key, payload));
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	private initializeStartup(globals?: Record<string, any>): void {
		const entries = globals && typeof globals === "object" ? Object.entries(globals) : [];
		if (entries.length === 0) {
			this.startupReady = true;
			this.startupError = null;
			this.startupPromise = Promise.resolve();
			return;
		}

		this.startupReady = false;
		this.startupError = null;
		this.startupPromise = (async () => {
			for (const [k, v] of entries) {
				await this.setGlobalInternal(k, v);
			}
		})()
			.then(() => {
				this.startupReady = true;
				this.startupError = null;
			})
			.catch((e) => {
				this.startupReady = true;
				this.startupError = e;
				throw e;
			});
	}

	private invokeHook(phase: DenoWorkerLifecyclePhase, extra?: Partial<DenoWorkerLifecycleContext>): void {
		const ctx: DenoWorkerLifecycleContext = {
			phase,
			worker: this,
			options: this.creationOptions,
			...extra,
		};

		const fn = this.lifecycleHooks?.[phase];
		if (typeof fn === "function") {
			try {
				fn(ctx);
			} catch {
				// Lifecycle hooks must not break worker control-flow.
			}
		}

		if (this.lifecycleHandlers.size > 0) {
			for (const cb of [...this.lifecycleHandlers]) {
				try {
					cb(ctx);
				} catch {
					// ignore subscriber errors
				}
			}
		}
	}

	private createNative(requested: boolean): NativeWorker {
		try {
			return (nativeAddon as any).DenoWorker(normalizeWorkerOptions(this.creationOptions)) as NativeWorker;
		} catch (e) {
			try {
				this.lifecycleHooks?.onCrash?.({
					phase: "onCrash",
					options: this.creationOptions,
					reason: e,
					requested,
				});
			} catch {
				// ignore
			}
			throw e;
		}
	}

	private bindNativeEvents(native: NativeWorker, epoch: number): void {
		native.on("message", (msg: any) => {
			if (epoch !== this.nativeEpoch) return;
			if (this.messageHandlers.size === 0) return;
			const hydrated = hydrateFromWire(msg);
			for (const cb of [...this.messageHandlers]) {
				try {
					cb(hydrated);
				} catch {
					// ignore subscriber errors
				}
			}
		});

		native.on("close", () => {
			if (epoch !== this.nativeEpoch) return;
			this.closed = true;
			this.emitCloseHandlers();
			if (!this.closeRequested) {
				this.invokeHook("onCrash", {
					reason: new Error("Worker closed unexpectedly"),
					requested: false,
				});
			}
		});
	}

	private emitCloseHandlers(): void {
		if (this.closeHandlers.size === 0) return;
		for (const cb of [...this.closeHandlers]) {
			try {
				cb();
			} catch {
				// ignore subscriber errors
			}
		}
	}

	private trackInFlight<T>(promise: Promise<T>): Promise<T> {
		let settled = false;
		let rejectTracked: (reason: unknown) => void = () => {};

		const wrapped = new Promise<T>((resolve, reject) => {
			rejectTracked = (reason: unknown) => {
				if (settled) return;
				settled = true;
				reject(reason);
			};

			promise.then(
				(v) => {
					if (settled) return;
					settled = true;
					resolve(v);
				},
				(e) => {
					if (settled) return;
					settled = true;
					reject(e);
				},
			);
		});

		this.inFlightRejectors.add(rejectTracked);
		void wrapped.then(
			() => {
				this.inFlightRejectors.delete(rejectTracked);
			},
			() => {
			this.inFlightRejectors.delete(rejectTracked);
			},
		);

		return wrapped;
	}

	private rejectInFlight(reason: unknown): void {
		const pending = [...this.inFlightRejectors];
		this.inFlightRejectors.clear();
		for (const rej of pending) {
			try {
				rej(reason);
			} catch {
				// ignore
			}
		}
	}

	/**
	 * Create a runtime-backed worker.
	 *
	 * Constructor `options.globals` are applied asynchronously right after startup.
	 * Async APIs wait for that startup phase; `evalSync` throws until startup globals finish.
	 */
	constructor(options?: DenoWorkerOptions) {
		this.lifecycleHooks = options?.lifecycle;
		this.creationOptions = options;
		this.invokeHook("beforeStart", { options });
		this.native = this.createNative(false);
		this.nativeEpoch += 1;
		this.bindNativeEvents(this.native, this.nativeEpoch);
		this.initializeStartup(options?.globals);
		this.invokeHook("afterStart");
	}

	/**
	 * Subscribe to runtime events.
	 *
	 * Event semantics:
	 * - `message`: receives payloads posted from runtime `postMessage(...)`.
	 * - `close`: emitted once runtime closes.
	 * - `lifecycle`: emits lifecycle transitions and crash/requested flags.
	 *
	 * @example
	 * ```ts
	 * dw.on("message", (msg) => console.log("worker message", msg));
	 * dw.on("lifecycle", (ctx) => console.log("phase", ctx.phase));
	 * ```
	 */
	on(event: "message", cb: DenoWorkerMessageHandler): void;
	on(event: "close", cb: DenoWorkerCloseHandler): void;
	on(event: "lifecycle", cb: DenoWorkerLifecycleHandler): void;
	on(event: DenoWorkerEvent, cb: DenoWorkerMessageHandler | DenoWorkerCloseHandler | DenoWorkerLifecycleHandler): void {
		if (event === "message") {
			if (typeof cb === "function") this.messageHandlers.add(cb as DenoWorkerMessageHandler);
			return;
		}
		if (event === "close") {
			if (typeof cb === "function") this.closeHandlers.add(cb as DenoWorkerCloseHandler);
			return;
		}
		if (event === "lifecycle" && typeof cb === "function") {
			this.lifecycleHandlers.add(cb as DenoWorkerLifecycleHandler);
		}
	}

	/**
	 * Unsubscribe runtime event listeners.
	 *
	 * If `cb` is omitted, all listeners for `event` are removed.
	 *
	 * @example
	 * ```ts
	 * const onMsg = (msg: any) => {};
	 * dw.on("message", onMsg);
	 * dw.off("message", onMsg); // remove one
	 * dw.off("message");        // clear all message listeners
	 * ```
	 */
	off(event: "message", cb?: DenoWorkerMessageHandler): void;
	off(event: "close", cb?: DenoWorkerCloseHandler): void;
	off(event: "lifecycle", cb?: DenoWorkerLifecycleHandler): void;
	off(event: DenoWorkerEvent, cb?: DenoWorkerMessageHandler | DenoWorkerCloseHandler | DenoWorkerLifecycleHandler): void {
		if (event === "message") {
			if (cb) this.messageHandlers.delete(cb as DenoWorkerMessageHandler);
			else this.messageHandlers.clear();
			return;
		}
		if (event === "close") {
			if (cb) this.closeHandlers.delete(cb as DenoWorkerCloseHandler);
			else this.closeHandlers.clear();
			return;
		}
		if (cb) this.lifecycleHandlers.delete(cb as DenoWorkerLifecycleHandler);
		else this.lifecycleHandlers.clear();
	}

	/**
	 * Post a message into the runtime event channel.
	 *
	 * Throws when queue is full or runtime is closed.
	 */
	postMessage(msg: any): void {
		if (this.isClosed()) {
			throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
		}

		const payload =
			typeof Buffer !== "undefined" && Buffer.isBuffer(msg) ? msg : dehydrateForWire(msg);
		const ok = this.native.postMessage(payload);
		if (!ok) {
			throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
		}
	}

	/**
	 * Batch enqueue variant of {@link postMessage}.
	 *
	 * Returns the number of messages accepted by the native queue.
	 * Throws if worker is closed or any message in the batch is dropped.
	 */
	postMessages(msgs: any[]): number {
		if (this.isClosed()) {
			throw new Error("DenoWorker.postMessages dropped: worker queue full or closed");
		}
		if (!Array.isArray(msgs) || msgs.length === 0) return 0;

		const payloads = msgs.map((m) =>
			typeof Buffer !== "undefined" && Buffer.isBuffer(m) ? m : dehydrateForWire(m),
		);
		const sent = (this.native as any).postMessages(payloads) as number;
		if (sent !== payloads.length) {
			throw new Error("DenoWorker.postMessages dropped: worker queue full or closed");
		}
		return sent;
	}

	/**
	 * Best-effort batch enqueue variant.
	 *
	 * Returns the number of messages accepted by the native queue.
	 */
	tryPostMessages(msgs: any[]): number {
		if (this.isClosed()) return 0;
		if (!Array.isArray(msgs) || msgs.length === 0) return 0;
		const payloads = msgs.map((m) =>
			typeof Buffer !== "undefined" && Buffer.isBuffer(m) ? m : dehydrateForWire(m),
		);
		const sent = (this.native as any).postMessages(payloads);
		return typeof sent === "number" && Number.isFinite(sent) ? sent : 0;
	}

	/**
	 * Best-effort message enqueue variant of {@link postMessage}.
	 *
	 * Returns `false` instead of throwing when enqueue fails.
	 */
	tryPostMessage(msg: any): boolean {
		if (this.isClosed()) return false;
		const payload =
			typeof Buffer !== "undefined" && Buffer.isBuffer(msg) ? msg : dehydrateForWire(msg);
		return this.native.postMessage(payload);
	}

	/**
	 * Returns `true` when runtime is closed or closing.
	 */
	isClosed(): boolean {
		if (this.closed) return true;
		const nativeClosed = this.native.isClosed();
		if (nativeClosed) {
			this.closed = true;
			return true;
		}
		return this.closePromise !== null;
	}

	/**
	 * Last known execution stats from the native runtime.
	 *
	 * Values are updated after successful/failed eval operations.
	 */
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

	/**
	 * Gracefully close runtime.
	 *
	 * - default close waits for close command to be processed.
	 * - `force: true` rejects in-flight wrapper promises immediately and
	 *   performs best-effort background native close.
	 */
	async close(options?: DenoWorkerCloseOptions): Promise<void> {
		const force = options?.force === true;
		if (this.closed) return;
		if (this.closePromise && !force) return this.closePromise;

		const alreadyClosing = this.closePromise !== null;
		this.closeRequested = true;
		if (!alreadyClosing) {
			this.invokeHook("beforeStop", { requested: true });
		}

		if (force) {
			const oldNative = this.native;
			this.nativeEpoch += 1;
			this.rejectInFlight(new Error("DenoWorker force-closed"));
			this.closed = true;

			this.closePromise = Promise.resolve().then(() => {
				this.emitCloseHandlers();
				this.invokeHook("afterStop", { requested: true });
			});

			void oldNative.close().catch(() => undefined);
			await this.closePromise;
			return;
		}

		this.closePromise = this.native
			.close()
			.then(() => {
				this.closed = true;
				this.invokeHook("afterStop", { requested: true });
			})
			.catch(async (e: any) => {
				this.closePromise = null;
				const err = hydrateFromWire(e);
				const msg = String((err as any)?.message ?? err ?? "");
				if (/queue is full|request queue is full/i.test(msg)) {
					await this.close({ force: true });
					return;
				}
				this.invokeHook("onCrash", { reason: err, requested: true });
				throw err;
			});

		await this.closePromise;
	}

	/**
	 * Restart runtime in-place using the original creation options.
	 *
	 * Existing event listeners remain attached to this wrapper.
	 * Constructor globals are re-applied after restart.
	 */
	async restart(options?: DenoWorkerRestartOptions): Promise<void> {
		if (!this.isClosed()) {
			await this.close({ force: options?.force === true });
		}

		this.closePromise = null;
		this.closed = false;
		this.closeRequested = false;

		this.invokeHook("beforeStart", { options: this.creationOptions });
		this.native = this.createNative(true);
		this.nativeEpoch += 1;
		this.bindNativeEvents(this.native, this.nativeEpoch);
		this.initializeStartup(this.creationOptions?.globals);
		await this.startupPromise;
		this.invokeHook("afterStart");
	}

	/**
	 * Query V8 heap memory stats for the runtime.
	 *
	 * Waits for constructor globals startup to finish before querying memory.
	 */
	async memory(): Promise<DenoWorkerMemory> {
		await this.startupPromise;
		const raw = await this.trackInFlight(this.native.memory());
		return coerceMemoryPayload(raw);
	}

	/**
	 * Set a global value inside the runtime (`globalThis[key] = value`).
	 *
	 * Serialization behavior:
	 * - functions are bridged as host-callable functions
	 * - special runtime values (Date/Map/Set/TypedArrays/URL/Error/etc) preserve type via wire tags
	 * - nested object functions are preserved (e.g. `fs.readFileSync`)
	 *
	 * @example
	 * ```ts
	 * await dw.setGlobal("API_URL", "https://example.com");
	 * await dw.eval("API_URL"); // "https://example.com"
	 * ```
	 */
	async setGlobal(key: string, value: any): Promise<void> {
		await this.startupPromise;
		await this.setGlobalInternal(key, value);
	}

	/**
	 * Evaluate script source in the runtime.
	 *
	 * If evaluated source resolves to a Promise, this method waits until fulfillment/rejection.
	 */
	async eval(src: string, options?: EvalOptions): Promise<any> {
		await this.startupPromise;
		try {
			const raw = await this.trackInFlight(this.native.eval(src, normalizeEvalOptions(options)));
			return hydrateFromWire(raw);
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	/**
	 * Synchronous script evaluation in the runtime.
	 *
	 * Throws while constructor globals are still initializing.
	 */
	evalSync(src: string, options?: EvalOptions): any {
		if (!this.startupReady) {
			throw new Error(
				"DenoWorker.evalSync cannot run while constructor globals are still initializing; use eval(...) or await startup completion",
			);
		}
		if (this.startupError) {
			throw this.startupError;
		}
		try {
			const raw = this.native.evalSync(src, normalizeEvalOptions(options));
			return hydrateFromWire(raw);
		} catch (e) {
			throw hydrateFromWire(e);
		}
	}

	/**
	 * Evaluate ES module source and return a callable namespace proxy.
	 *
	 * Function exports are wrapped as Node-callable host functions.
	 * Non-function exports are hydrated to equivalent host-side values.
	 *
	 * @example
	 * ```ts
	 * const mod = await dw.evalModule(`export const x = 1; export function add(a,b){return a+b}`);
	 * const n = await mod.add(2, 3); // 5
	 * ```
	 */
	async evalModule<T extends Record<string, any> = Record<string, any>>(
		source: string,
		options?: Omit<EvalOptions, "type">,
	): Promise<T> {
		await this.startupPromise;
		let raw: any;
		try {
			if (typeof this.native.evalModule === "function") {
				raw = await this.trackInFlight(
					this.native.evalModule(source, normalizeEvalOptions({ ...(options ?? {}), type: "module" })),
				);
			} else {
				raw = await this.eval(source, { ...(options ?? {}), type: "module" });
			}
			} catch (e) {
				throw hydrateFromWire(e);
			}
			return wrapModuleNamespace<T>(this, hydrateFromWire(raw));
		}
	}

export default DenoWorker;
