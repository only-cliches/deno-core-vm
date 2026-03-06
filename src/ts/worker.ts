/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomBytes, randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { nativeAddon } from "./native";
import { wrapModuleNamespace } from "./module-namespace";
import { buildImportModuleSource } from "./module-source";
import { coerceMemoryPayload, normalizeEvalOptions, normalizeWorkerOptions } from "./options";
import {
    STREAM_BRIDGE_TAG as STREAM_BRIDGE_TAG_RAW,
    STREAM_CHUNK_MAGIC,
    STREAM_FRAME_TYPE_TO_CODE,
    decodeStreamFrameEnvelope,
    encodeStreamFrameEnvelope,
    STREAM_TYPED_CHUNK_PREFIX as STREAM_TYPED_CHUNK_PREFIX_RAW,
} from "../shared/stream-envelope";
import { dehydrateForWire, hydrateFromWire } from "./wire";
import type {
    DenoWorkerHandleApplyOp,
    DenoWorkerHandleAwaitOptions,
    DenoWorkerHandleExecOptions,
    DenoWorkerHandleApi,
    DenoWorkerGlobalApi,
    DenoWorkerCloseHandler,
    DenoWorkerEvent,
    DenoWorkerHandle,
    DenoWorkerHandleTypeInfo,
    DenoWorkerLifecycleContext,
    DenoWorkerLifecycleHandler,
    DenoWorkerLifecycleHooks,
    DenoWorkerLifecyclePhase,
    DenoWorkerCloseOptions,
    DenoWorkerMemory,
    DenoWorkerMessageHandler,
    DenoWorkerModuleApi,
    DenoWorkerModuleEvalOptions,
    DenoWorkerOptions,
    DenoWorkerRestartOptions,
    DenoWorkerRuntimeEvent,
    DenoWorkerRuntimeHandler,
    DenoWorkerStreamApi,
    DenoWorkerStreamReader,
    DenoWorkerStreamWriter,
    EvalOptions,
    ExecStats,
    NativeWorker,
} from "./types";

const STREAM_BRIDGE_TAG = STREAM_BRIDGE_TAG_RAW as "__denojs_worker_stream_v1";
const STREAM_TYPED_CHUNK_PREFIX = STREAM_TYPED_CHUNK_PREFIX_RAW as "__denojs_worker_stream_chunk_v1:";
const STREAM_TYPED_CHUNK_MIN_BYTES = 1;
const STREAM_V2_ENABLED = process.env.DENO_DIRECTOR_STREAM_V2 !== "0";
const STREAM_V2_STATS_DEBUG = process.env.DENO_DIRECTOR_STREAM_V2_STATS_DEBUG === "1";
const textEncoder = new TextEncoder();

// Default stream flow-control window.
const STREAM_DEFAULT_WINDOW_BYTES = 256 * 1024 * 1024;
// Default credit flush threshold (256 KiB): avoids chatty credit updates while
// keeping writers responsive under sustained transfer.
const STREAM_CREDIT_FLUSH_THRESHOLD = 256 * 1024;
const STREAM_V2_MAX_QUEUED_CHUNKS = 2048;
const STREAM_V2_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const STREAM_V2_BATCH_MAX_CHUNK_BYTES = 1024 * 1024;
const NATIVE_STREAM_DEBUG = process.env.DENO_DIRECTOR_NATIVE_STREAM_DEBUG === "1";
const STREAM_READER_DEFAULT_HIGH_WATER_MARK_BYTES = STREAM_DEFAULT_WINDOW_BYTES;
const STREAM_BACKLOG_DEFAULT_LIMIT = 256;
const STREAM_CONNECT_HOST_TO_WORKER_SUFFIX = "::h2w";
const STREAM_CONNECT_WORKER_TO_HOST_SUFFIX = "::w2h";
const STREAM_SLOT_POOL_MIN = 16;
const STREAM_SLOT_POOL_MAX = 1024;
const STREAM_SLOT_POOL_HEADROOM = 8;
const STREAM_SLOT_POOL_SCALE_NUM = 3;
const STREAM_SLOT_POOL_SCALE_DEN = 2;
const STREAM_SLOT_POOL_HYSTERESIS = 8;
const STREAM_SLOT_POOL_TUNE_INTERVAL = 16;
const HANDLE_DEFAULT_MAX = 128;
const WIRE_MARKER_KEY_SET = new Set([
    "__undef",
    "__num",
    "__denojs_worker_num",
    "__date",
    "__bigint",
    "__regexp",
    "__url",
    "__urlSearchParams",
    "__buffer",
    "__map",
    "__set",
    "__denojs_worker_type",
    "__denojs_worker_graph_id",
    "__denojs_worker_graph_ref",
    "__denojs_worker_graph_kind",
    "__denojs_worker_graph_value",
]);
const HANDLE_RUNTIME_KEY = "__denojs_worker_handle_v1";
const HANDLE_RUNTIME_INSTALL_SOURCE = `(() => {
    const mkErr = (code, message) => {
        const e = new Error(message);
        e.code = code;
        throw e;
    };

    const existing = globalThis.${HANDLE_RUNTIME_KEY};
    if (existing) {
        if (existing.__denojs_worker_handle_api_v1 === true) return true;
        mkErr("HANDLE_BRIDGE_TAMPERED", "Handle runtime bridge key is already occupied by incompatible value");
    }

    const reg = new Map();
    const splitPath = (path) => {
        if (path == null || path === "") return [];
        if (typeof path !== "string") mkErr("HANDLE_PATH_INVALID", "Handle path must be a string");
        const segs = path.split(".").map((s) => s.trim());
        if (segs.length === 0 || segs.some((s) => !s)) {
            mkErr("HANDLE_PATH_INVALID", \`Invalid handle path: \${String(path)}\`);
        }
        if (segs.some((s) => s === "__proto__" || s === "prototype" || s === "constructor")) {
            mkErr("HANDLE_PATH_FORBIDDEN", "Path contains forbidden prototype mutation segment");
        }
        return segs;
    };
    const mustObjectLike = (v, path) => {
        const t = typeof v;
        if (v == null || (t !== "object" && t !== "function")) {
            mkErr("HANDLE_PATH_INVALID", \`Cannot traverse handle path '\${path}'\`);
        }
    };
    const hasOwnOrProto = (obj, key) => key in Object(obj);
    const resolve = (base, path) => {
        const segs = splitPath(path);
        let cur = base;
        for (const seg of segs) {
            mustObjectLike(cur, path);
            cur = cur[seg];
        }
        return cur;
    };
    const resolveWithExistence = (base, path) => {
        const segs = splitPath(path);
        let cur = base;
        for (const seg of segs) {
            mustObjectLike(cur, path);
            if (!hasOwnOrProto(cur, seg)) return { exists: false, value: undefined };
            cur = cur[seg];
        }
        return { exists: true, value: cur };
    };
    const resolveParent = (base, path) => {
        const segs = splitPath(path);
        if (segs.length === 0) mkErr("HANDLE_PATH_INVALID", "Handle set/call path cannot be empty");
        let cur = base;
        for (let i = 0; i < segs.length - 1; i += 1) {
            const seg = segs[i];
            mustObjectLike(cur, path);
            cur = cur[seg];
        }
        return { parent: cur, key: segs[segs.length - 1] };
    };
    const toEntries = (value) => {
        if (value == null) return [];
        if (value instanceof Map) return Array.from(value.entries());
        if (value instanceof Set) return Array.from(value.entries());
        if (typeof value === "object" || typeof value === "function") return Object.entries(value);
        return [];
    };
    const toKeys = (value) => {
        if (value == null) return [];
        if (value instanceof Map || value instanceof Set) return Array.from(value.keys());
        if (typeof value === "object" || typeof value === "function") return Object.keys(value);
        return [];
    };
    const toJsonSnapshot = (value) => {
        const seen = new WeakSet();
        const s = JSON.stringify(value, (_key, v) => {
            if (typeof v === "bigint") return { __bigint: v.toString() };
            if (typeof v === "function") return \`[Function \${v.name || "anonymous"}]\`;
            if (typeof v === "symbol") return String(v);
            if (v instanceof Map) return { __map: Array.from(v.entries()) };
            if (v instanceof Set) return { __set: Array.from(v.values()) };
            if (v instanceof Date) return { __date: v.toISOString() };
            if (v instanceof Error) return { __error: { name: v.name, message: v.message, stack: v.stack } };
            if (v && typeof v === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
            }
            return v;
        });
        if (s === undefined) return undefined;
        return JSON.parse(s);
    };
    const isPromiseLike = (value) =>
        value != null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof value.then === "function";
    const awaitOne = (value) =>
        new Promise((resolve, reject) => {
            try {
                value.then(
                    (v) => resolve({ value: v }),
                    reject,
                );
            } catch (e) {
                reject(e);
            }
        });
    const typeInfo = (value) => {
        const tag = Object.prototype.toString.call(value);
        let type = "object";
        if (value === undefined) type = "undefined";
        else if (value === null) type = "null";
        else if (Array.isArray(value)) type = "array";
        else if (tag === "[object Date]") type = "date";
        else if (tag === "[object RegExp]") type = "regexp";
        else if (tag === "[object Map]") type = "map";
        else if (tag === "[object Set]") type = "set";
        else if (tag === "[object ArrayBuffer]") type = "arraybuffer";
        else if (typeof ArrayBuffer !== "undefined" && typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(value)) type = "typedarray";
        else if (value instanceof Error) type = "error";
        else if (tag === "[object Promise]") type = "promise";
        else type = typeof value;
        const out = { type, callable: typeof value === "function" };
        if (value && (typeof value === "object" || typeof value === "function")) {
            const ctorName = value.constructor && typeof value.constructor.name === "string" ? value.constructor.name : undefined;
            if (ctorName) out.constructorName = ctorName;
        }
        return out;
    };
    const api = {
        async run(payload) {
            if (!payload || typeof payload !== "object") mkErr("HANDLE_PAYLOAD_INVALID", "Invalid handle payload");
            const op = String(payload.op || "");
            const id = String(payload.id || "");
            if (!id) mkErr("HANDLE_ID_INVALID", "Invalid handle id");

            if (op === "createFromPath") {
                const found = resolveWithExistence(globalThis, payload.path);
                if (!found.exists) mkErr("HANDLE_PATH_NOT_FOUND", \`Handle path not found: \${String(payload.path)}\`);
                reg.set(id, found.value);
                return { id };
            }
            if (op === "createFromEval") {
                const src = String(payload.source || "");
                if (!src.trim()) mkErr("HANDLE_EVAL_SOURCE_EMPTY", "handle.eval(source) requires non-empty source");
                const root = (0, eval)(src);
                reg.set(id, root);
                return { id };
            }
            if (op === "dispose") {
                reg.delete(id);
                return true;
            }

            if (!reg.has(id)) mkErr("HANDLE_INVALIDATED", "Handle disposed or invalidated");
            const root = reg.get(id);

            if (op === "get") return resolve(root, payload.path);
            if (op === "set") {
                const { parent, key } = resolveParent(root, payload.path);
                mustObjectLike(parent, payload.path);
                parent[key] = payload.value;
                return null;
            }
            if (op === "has") {
                const found = resolveWithExistence(root, payload.path);
                return found.exists;
            }
            if (op === "delete") {
                const { parent, key } = resolveParent(root, payload.path);
                mustObjectLike(parent, payload.path);
                if (!(key in Object(parent))) return false;
                return delete parent[key];
            }
            if (op === "keys") return toKeys(resolve(root, payload.path));
            if (op === "entries") return toEntries(resolve(root, payload.path));
            if (op === "getOwnPropertyDescriptor") {
                const { parent, key } = resolveParent(root, payload.path);
                mustObjectLike(parent, payload.path);
                return Object.getOwnPropertyDescriptor(parent, key);
            }
            if (op === "define") {
                const { parent, key } = resolveParent(root, payload.path);
                mustObjectLike(parent, payload.path);
                Object.defineProperty(parent, key, payload.descriptor || {});
                return true;
            }
            if (op === "instanceOf") {
                const ctor = resolve(globalThis, payload.constructorPath);
                if (typeof ctor !== "function") mkErr("HANDLE_CTOR_INVALID", "constructorPath does not resolve to a function");
                return root instanceof ctor;
            }
            if (op === "isCallable") return typeof resolve(root, payload.path) === "function";
            if (op === "isPromise") return isPromiseLike(resolve(root, payload.path));
            if (op === "call") {
                const path = payload.path == null ? "" : String(payload.path);
                const args = Array.isArray(payload.args) ? payload.args : [];
                if (!path) {
                    if (typeof root !== "function") mkErr("HANDLE_NOT_CALLABLE", "Handle root is not callable");
                    return root(...args);
                }
                const { parent, key } = resolveParent(root, path);
                mustObjectLike(parent, path);
                const fn = parent[key];
                if (typeof fn !== "function") mkErr("HANDLE_NOT_CALLABLE", \`Handle path is not callable: \${path}\`);
                return fn.apply(parent, args);
            }
            if (op === "construct") {
                const args = Array.isArray(payload.args) ? payload.args : [];
                if (typeof root !== "function") mkErr("HANDLE_NOT_CONSTRUCTABLE", "Handle root is not constructable");
                return new root(...args);
            }
            if (op === "await") {
                const returnValue = payload.returnValue !== false;
                const untilNonPromise = payload.untilNonPromise === true;
                const run = async () => {
                    if (!untilNonPromise) {
                        return await Promise.resolve(root);
                    }
                    let resolved = root;
                    for (let i = 0; i < 1024; i += 1) {
                        if (!isPromiseLike(resolved)) break;
                        const step = await awaitOne(resolved);
                        resolved = step.value;
                    }
                    if (isPromiseLike(resolved)) {
                        mkErr("HANDLE_AWAIT_MAX_DEPTH", "handle.await({ untilNonPromise: true }) exceeded max unwrap depth");
                    }
                    return resolved;
                };
                return run().then((resolved) => {
                    reg.set(id, resolved);
                    return returnValue ? resolved : undefined;
                });
            }
            if (op === "clone") {
                const nextId = String(payload.nextId || "");
                if (!nextId) mkErr("HANDLE_CLONE_ID_INVALID", "clone requires nextId");
                reg.set(nextId, root);
                return { id: nextId };
            }
            if (op === "toJSON") return toJsonSnapshot(resolve(root, payload.path));
            if (op === "apply") {
                const items = Array.isArray(payload.ops) ? payload.ops : [];
                const out = [];
                for (const item of items) {
                    const opName = item && typeof item.op === "string" ? item.op : "";
                    if (!opName) mkErr("HANDLE_APPLY_OP_INVALID", "Invalid handle apply op");
                    if (opName === "get") out.push(resolve(root, item.path == null ? "" : item.path));
                    else if (opName === "set") {
                        const { parent, key } = resolveParent(root, item.path);
                        mustObjectLike(parent, item.path);
                        parent[key] = item.value;
                        out.push(null);
                    } else if (opName === "call") {
                        const path = item.path == null ? "" : String(item.path);
                        const args = Array.isArray(item.args) ? item.args : [];
                        if (!path) {
                            if (typeof root !== "function") mkErr("HANDLE_NOT_CALLABLE", "Handle root is not callable");
                            let result = root(...args);
                            if (isPromiseLike(result)) result = await Promise.resolve(result);
                            out.push(result);
                        } else {
                            const { parent, key } = resolveParent(root, path);
                            mustObjectLike(parent, path);
                            const fn = parent[key];
                            if (typeof fn !== "function") mkErr("HANDLE_NOT_CALLABLE", \`Handle path is not callable: \${path}\`);
                            let result = fn.apply(parent, args);
                            if (isPromiseLike(result)) result = await Promise.resolve(result);
                            out.push(result);
                        }
                    } else if (opName === "has") {
                        out.push(resolveWithExistence(root, item.path).exists);
                    } else if (opName === "delete") {
                        const { parent, key } = resolveParent(root, item.path);
                        mustObjectLike(parent, item.path);
                        out.push(key in Object(parent) ? delete parent[key] : false);
                    } else if (opName === "getType") {
                        out.push(typeInfo(resolve(root, item.path == null ? "" : item.path)));
                    } else if (opName === "toJSON") {
                        out.push(toJsonSnapshot(resolve(root, item.path == null ? "" : item.path)));
                    } else if (opName === "isCallable") {
                        out.push(typeof resolve(root, item.path == null ? "" : item.path) === "function");
                    } else if (opName === "isPromise") {
                        out.push(isPromiseLike(resolve(root, item.path == null ? "" : item.path)));
                    } else {
                        mkErr("HANDLE_APPLY_OP_UNSUPPORTED", \`Unsupported apply op: \${opName}\`);
                    }
                }
                return out;
            }
            if (op === "getType") return typeInfo(resolve(root, payload.path));

            mkErr("HANDLE_OP_UNKNOWN", \`Unknown handle operation: \${op}\`);
        },
    };
    Object.defineProperty(api, "__denojs_worker_handle_api_v1", {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
    });

    Object.defineProperty(globalThis, "${HANDLE_RUNTIME_KEY}", {
        value: api,
        configurable: false,
        enumerable: false,
        writable: false,
    });
    return true;
})()`;
const HANDLE_RUNTIME_RUN_SOURCE = `(payload) => {
    const api = globalThis.${HANDLE_RUNTIME_KEY};
    if (!api || typeof api.run !== "function") {
        const e = new Error("Handle runtime bridge is not installed");
        e.code = "HANDLE_BRIDGE_MISSING";
        throw e;
    }
    return api.run(payload);
}`;
const HANDLE_RUNTIME_CALL_SOURCE = `(id, path, ...args) => {
    const api = globalThis.${HANDLE_RUNTIME_KEY};
    if (!api || typeof api.run !== "function") {
        const e = new Error("Handle runtime bridge is not installed");
        e.code = "HANDLE_BRIDGE_MISSING";
        throw e;
    }
    return api.run({ op: "call", id, path, args });
}`;
type StreamFrameType = "open" | "chunk" | "close" | "error" | "cancel" | "discard" | "credit";

type StreamFrame = {
    [STREAM_BRIDGE_TAG]: true;
    t: StreamFrameType;
    id: string;
    key?: string;
    chunk?: Uint8Array;
    error?: string;
    reason?: string;
    credit?: number;
};

type StreamSlotMeta = {
    name: string;
    localDiscarded: boolean;
    remoteDiscarded: boolean;
};

/** Checks whether a payload matches the structured stream-frame envelope shape. */
function isStreamFrame(v: unknown): v is StreamFrame {
    if (!v || typeof v !== "object") return false;
    const obj = v as Record<string, unknown>;
    return obj[STREAM_BRIDGE_TAG] === true && typeof obj.id === "string" && typeof obj.t === "string";
}

/** Converts outgoing stream chunks to an efficient Uint8Array/Buffer view without copying when possible. */
function toBinaryChunk(chunk: Uint8Array | ArrayBuffer): Uint8Array {
    if (chunk instanceof Uint8Array) {
        return chunk;
    }
    return new Uint8Array(chunk);
}

/** Builds a stream-chunk envelope encoder with cached id/header bytes for hot write loops. */
function createChunkEnvelopeEncoder(id: string): (chunk: Uint8Array) => Uint8Array {
    const idBytes = textEncoder.encode(id);
    if (idBytes.byteLength === 0 || idBytes.byteLength > 0xffff) {
        throw new Error(`Invalid stream id length: ${idBytes.byteLength}`);
    }
    const head = new Uint8Array(STREAM_CHUNK_MAGIC.length + 1 + 2 + 2 + idBytes.byteLength);
    head.set(STREAM_CHUNK_MAGIC, 0);
    let off = STREAM_CHUNK_MAGIC.length;
    head[off] = STREAM_FRAME_TYPE_TO_CODE.chunk & 0xff;
    off += 1;
    head[off] = (idBytes.byteLength >>> 8) & 0xff;
    head[off + 1] = idBytes.byteLength & 0xff;
    off += 2;
    // chunk frames use empty aux text
    head[off] = 0;
    head[off + 1] = 0;
    off += 2;
    head.set(idBytes, off);

    return (chunk: Uint8Array): Uint8Array => {
        const out = new Uint8Array(head.byteLength + chunk.byteLength);
        out.set(head, 0);
        out.set(chunk, head.byteLength);
        if (typeof Buffer !== "undefined") {
            return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
        }
        return out;
    };
}

class HeaderCache {
    private readonly chunkEnvelopeById = new Map<string, (chunk: Uint8Array) => Uint8Array>();

    chunkEncoder(id: string): (chunk: Uint8Array) => Uint8Array {
        let encoder = this.chunkEnvelopeById.get(id);
        if (!encoder) {
            encoder = createChunkEnvelopeEncoder(id);
            this.chunkEnvelopeById.set(id, encoder);
        }
        return encoder;
    }

    clear(id: string): void {
        this.chunkEnvelopeById.delete(id);
    }
}

/** Generates a high-entropy stream key used when callers do not provide one. */
function generateSecureRandomStreamKey(): string {
    try {
        if (typeof globalThis.crypto?.randomUUID === "function") {
            return globalThis.crypto.randomUUID();
        }
    } catch {
        // ignore
    }
    try {
        return randomUUID();
    } catch {
        return randomBytes(16).toString("hex");
    }
}

type StreamReadEvent =
    | { kind: "chunk"; chunk: Uint8Array }
    | { kind: "close" }
    | { kind: "error"; error: unknown };
type InternalStreamWriterFastPath = {
    __writeWithCallbacks?: (chunk: Uint8Array, onDone: () => void, onError: (err: unknown) => void) => void;
};

class StreamReaderImpl implements DenoWorkerStreamReader {
    private queue: StreamReadEvent[] = [];
    private waiting: Array<{
        resolve: (r: IteratorResult<Uint8Array>) => void;
        reject: (e: unknown) => void;
    }> = [];
    private closed = false;
    private done = false;
    private remoteCancel?: (reason?: string) => void;
    private onLocalDiscard?: () => void;
    private onChunkConsumed?: (bytes: number) => void;
    private discarded = false;
    private bufferedBytes = 0;
    private pendingCreditBytes = 0;
    private readonly highWaterMarkBytes: number;

    constructor(highWaterMarkBytes: number) {
        this.highWaterMarkBytes =
            Number.isFinite(highWaterMarkBytes) && highWaterMarkBytes >= 1
                ? Math.trunc(highWaterMarkBytes)
                : STREAM_READER_DEFAULT_HIGH_WATER_MARK_BYTES;
    }

    /** Registers a callback used to send local cancel notifications to the remote writer. */
    setRemoteCancel(fn: (reason?: string) => void): void {
        this.remoteCancel = fn;
    }

    /** Registers a callback invoked once this reader has been locally discarded. */
    setOnLocalDiscard(fn: () => void): void {
        this.onLocalDiscard = fn;
    }

    /** Registers a callback fired after each consumed chunk for credit replenishment. */
    setOnChunkConsumed(fn: (bytes: number) => void): void {
        this.onChunkConsumed = fn;
    }

    /** Marks the reader as locally discarded exactly once and fires discard hooks. */
    private markLocalDiscarded(): void {
        if (this.discarded) return;
        this.discarded = true;
        try {
            this.onLocalDiscard?.();
        } catch {
            // ignore
        }
    }

    /** Queues an incoming data chunk for `read()` consumers. */
    pushChunk(chunk: Uint8Array): void {
        if (this.closed || this.done) return;
        this.bufferedBytes += chunk.byteLength;
        this.pushEvent({ kind: "chunk", chunk });
    }

    private onChunkDelivered(byteLength: number): void {
        this.bufferedBytes = Math.max(0, this.bufferedBytes - byteLength);
        this.pendingCreditBytes += byteLength;
        if (this.bufferedBytes > this.highWaterMarkBytes) return;
        if (this.pendingCreditBytes <= 0) return;
        try {
            this.onChunkConsumed?.(this.pendingCreditBytes);
        } catch {
            // ignore
        }
        this.pendingCreditBytes = 0;
    }

    /** Marks the remote side as closed and resolves pending reads as done. */
    closeRemote(): void {
        if (this.closed) return;
        this.closed = true;
        this.markLocalDiscarded();
        this.pushEvent({ kind: "close" });
    }

    /** Marks the remote side as failed and rejects pending reads with the error. */
    errorRemote(error: unknown): void {
        if (this.closed) return;
        this.closed = true;
        this.markLocalDiscarded();
        this.pushEvent({ kind: "error", error });
    }

    /** Delivers an event to waiters immediately or appends it to the internal queue. */
    private pushEvent(ev: StreamReadEvent): void {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift()!;
            if (ev.kind === "chunk") {
                next.resolve({ done: false, value: ev.chunk });
                this.onChunkDelivered(ev.chunk.byteLength);
            }
            else if (ev.kind === "close") next.resolve({ done: true, value: undefined as any });
            else next.reject(ev.error);
            return;
        }
        this.queue.push(ev);
    }

    /** Reads the next stream chunk or terminal event from this reader. */
    async read(): Promise<IteratorResult<Uint8Array>> {
        if (this.done) return { done: true, value: undefined as any };
        if (this.queue.length > 0) {
            const ev = this.queue.shift()!;
            if (ev.kind === "chunk") {
                this.onChunkDelivered(ev.chunk.byteLength);
                return { done: false, value: ev.chunk };
            }
            this.done = true;
            if (ev.kind === "close") return { done: true, value: undefined as any };
            throw ev.error;
        }

        return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            this.waiting.push({ resolve, reject });
        });
    }

    /** Cancels local consumption and notifies the remote side with an optional reason. */
    async cancel(reason?: string): Promise<void> {
        if (!this.done && !this.closed) {
            this.closed = true;
            this.done = true;
            this.queue.length = 0;
            while (this.waiting.length > 0) {
                const next = this.waiting.shift()!;
                next.resolve({ done: true, value: undefined as any });
            }
            try {
                this.remoteCancel?.(reason);
            } catch {
                // ignore
            }
            this.markLocalDiscarded();
        }
    }

    /** Exposes this reader as an async iterator yielding incoming binary chunks. */
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
        const self = this;
        return {
            next() {
                return self.read();
            },
            return() {
                return self.cancel("iterator return").then(() => ({ done: true, value: undefined as any }));
            },
            throw(err?: unknown) {
                return self.cancel(String(err ?? "iterator throw")).then(() => Promise.reject(err));
            },
            [Symbol.asyncIterator]() {
                return this;
            },
        };
    }
}

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
    private readonly runtimeHandlers = new Set<DenoWorkerRuntimeHandler>();
    private readonly inFlightRejectors = new Set<(reason: unknown) => void>();
    private nativeEpoch = 0;
    private closeNotified = false;
    private startupPromise: Promise<void> = Promise.resolve();
    private startupReady = true;
    private startupError: unknown = null;
    private streamCounter = 0;
    private readonly streamIncoming = new Map<string, StreamReaderImpl>();
    private readonly streamById = new Map<string, StreamSlotMeta>();
    private readonly streamNameToId = new Map<string, string>();
    private readonly streamPendingAccepts = new Map<
        string,
        { resolve: (reader: DenoWorkerStreamReader) => void; reject: (error: unknown) => void }
    >();
    private readonly streamBacklog = new Map<string, DenoWorkerStreamReader>();
    private readonly streamWriterCredits = new Map<string, number>();
    private readonly streamWriterWaiters = new Map<
        string,
        Array<{ minBytes: number; resolve: () => void; reject: (e: unknown) => void }>
    >();
    private readonly pendingCreditFrames = new Map<string, number>();
    private creditFlushScheduled = false;
    private readonly pendingIncomingStreamFrames = new Map<string, StreamFrame[]>();
    private readonly streamSlotPool: StreamSlotMeta[] = [];
    private streamSlotsInUse = 0;
    private streamSlotPoolTarget = STREAM_SLOT_POOL_MIN;
    private streamSlotPoolOps = 0;
    private readonly streamWindowBytes: number;
    private readonly streamCreditFlushBytes: number;
    private readonly streamBacklogLimit: number;
    private readonly streamReaderHighWaterMarkBytes: number;
    private readonly streamHeaderCache = new HeaderCache();
    private handleGeneration = 1;
    private handleCounter = 0;
    private handleBridgeInstallPromise: Promise<void> | null = null;
    private handleBridgeInstalled = false;
    private readonly activeHandleIds = new Set<string>();
    private readonly maxHandle: number;
    /** Stream transport API for creating writers and accepting incoming readers. */
    readonly stream: DenoWorkerStreamApi = {
        connect: (key: string) => this.streamConnect(key),
        create: (key?: string) => this.streamCreate(key),
        accept: (key: string) => this.streamAccept(key),
    };
    /** Handle API for binding to runtime values by path or evaluated source. */
    readonly handle: DenoWorkerHandleApi = {
        get: (path: string, options?: DenoWorkerHandleExecOptions) => this.handleGet(path, options),
        tryGet: (path: string, options?: DenoWorkerHandleExecOptions) => this.handleTryGet(path, options),
        eval: (source: string, options?: Omit<EvalOptions, "args" | "type">) => this.handleEval(source, options),
    };
    /** Global namespace API for setting, reading, and calling runtime globals. */
    readonly global: DenoWorkerGlobalApi = {
        set: (path: string, value: any, options?: DenoWorkerHandleExecOptions) => this.globalSet(path, value, options),
        get: <T = any>(path: string, options?: DenoWorkerHandleExecOptions) => this.globalGet<T>(path, options),
        has: (path: string, options?: DenoWorkerHandleExecOptions) => this.globalHas(path, options),
        delete: (path: string, options?: DenoWorkerHandleExecOptions) => this.globalDelete(path, options),
        keys: (path?: string, options?: DenoWorkerHandleExecOptions) => this.globalKeys(path, options),
        entries: (path?: string, options?: DenoWorkerHandleExecOptions) => this.globalEntries(path, options),
        getOwnPropertyDescriptor: (path: string, options?: DenoWorkerHandleExecOptions) =>
            this.globalGetOwnPropertyDescriptor(path, options),
        define: (path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions) =>
            this.globalDefine(path, descriptor, options),
        isCallable: (path?: string, options?: DenoWorkerHandleExecOptions) => this.globalIsCallable(path, options),
        isPromise: (path?: string, options?: DenoWorkerHandleExecOptions) => this.globalIsPromise(path, options),
        call: <T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions) => this.globalCall<T>(path, args, options),
        construct: <T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions) =>
            this.globalConstruct<T>(path, args, options),
        await: <T = any>(path: string, options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions) =>
            this.globalAwait<T>(path, options),
        clone: (path: string, options?: DenoWorkerHandleExecOptions) => this.globalClone(path, options),
        toJSON: <T = any>(path?: string, options?: DenoWorkerHandleExecOptions) => this.globalToJSON<T>(path, options),
        apply: <T = any[]>(path: string, ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions) =>
            this.globalApply<T>(path, ops, options),
        getType: (path?: string, options?: DenoWorkerHandleExecOptions) => this.globalGetType(path, options),
        instanceOf: (path: string, constructorPath: string, options?: DenoWorkerHandleExecOptions) =>
            this.globalInstanceOf(path, constructorPath, options),
    };
    /** Module API for source evaluation and named module registry operations. */
    readonly module: DenoWorkerModuleApi = {
        import: <T extends Record<string, any> = Record<string, any>>(specifier: string) =>
            this.moduleApiImport<T>(specifier),
        eval: <T extends Record<string, any> = Record<string, any>>(source: string, options?: DenoWorkerModuleEvalOptions) =>
            this.moduleApiEval<T>(source, options),
        register: (moduleName: string, source: string) => this.moduleApiRegister(moduleName, source),
        clear: (moduleName: string) => this.moduleApiClear(moduleName),
    };

    /** Allocates the next unique handle id scoped to the current native epoch. */
    private nextHandleId(): string {
        this.handleCounter += 1;
        return `h:${this.nativeEpoch}:${this.handleCounter}`;
    }

    /** Enforces the configured maximum number of simultaneously active handles. */
    private ensureHandleCapacity(): void {
        if (this.activeHandleIds.size < this.maxHandle) return;
        const e: any = new Error(`handle limit reached (${this.maxHandle})`);
        e.code = "HANDLE_LIMIT_REACHED";
        throw e;
    }

    /** Invalidates all host handle wrappers after close/restart and clears handle bookkeeping. */
    private invalidateHandles(): void {
        this.handleGeneration += 1;
        this.handleBridgeInstallPromise = null;
        this.handleBridgeInstalled = false;
        this.activeHandleIds.clear();
    }

    /** Installs the runtime-side handle bridge once per epoch, with shared in-flight installation. */
    private async ensureHandleBridgeInstalled(): Promise<void> {
        if (this.handleBridgeInstalled) return;
        if (this.handleBridgeInstallPromise) return this.handleBridgeInstallPromise;
        const pending = this.eval(HANDLE_RUNTIME_INSTALL_SOURCE).then(() => undefined);
        this.handleBridgeInstallPromise = pending;
        try {
            await pending;
            this.handleBridgeInstalled = true;
        } catch (e) {
            this.handleBridgeInstallPromise = null;
            this.handleBridgeInstalled = false;
            throw e;
        }
    }

    /** Runs a handle operation by dispatching payload through the runtime handle bridge entrypoint. */
    private async runHandleOp(
        payload: Record<string, unknown>,
        options?: Omit<EvalOptions, "args" | "type">,
    ): Promise<any> {
        if (!(this.startupReady && !this.startupError && this.handleBridgeInstalled)) {
            await this.startupPromise;
            await this.ensureHandleBridgeInstalled();
        }
        return await this.eval(HANDLE_RUNTIME_RUN_SOURCE, {
            ...(options ?? {}),
            args: [payload],
        });
    }

    /** Runs handle.call using variadic eval args to keep large binary args off JSON dehydration paths. */
    private async runHandleCallOp(
        id: string,
        path: string,
        args: any[],
        options?: Omit<EvalOptions, "args" | "type">,
    ): Promise<any> {
        if (!(this.startupReady && !this.startupError && this.handleBridgeInstalled)) {
            await this.startupPromise;
            await this.ensureHandleBridgeInstalled();
        }
        return await this.eval(HANDLE_RUNTIME_CALL_SOURCE, {
            ...(options ?? {}),
            args: [id, path, ...(Array.isArray(args) ? args : [])],
        });
    }

    /** Builds a host-side handle object bound to a runtime handle id and generation. */
    private createHandle(
        id: string,
        generation: number,
        rootType: DenoWorkerHandleTypeInfo,
        defaultExecOptions?: Omit<EvalOptions, "args" | "type">,
    ): DenoWorkerHandle {
        let disposed = false;
        let rootTypeCache = rootType;
        const self = this;
        const toExecOptions = (
            value?: DenoWorkerHandleExecOptions | Omit<EvalOptions, "args" | "type">,
        ): Omit<EvalOptions, "args" | "type"> | undefined => {
            if (!value || typeof value !== "object") return defaultExecOptions ? { ...defaultExecOptions } : undefined;
            const out: Omit<EvalOptions, "args" | "type"> = {};
            if (typeof value.maxEvalMs === "number") out.maxEvalMs = value.maxEvalMs;
            if (typeof value.maxCpuMs === "number") out.maxCpuMs = value.maxCpuMs;
            if (typeof (value as Omit<EvalOptions, "args" | "type">).filename === "string") {
                out.filename = (value as Omit<EvalOptions, "args" | "type">).filename;
            }
            if (Object.keys(out).length === 0) return defaultExecOptions ? { ...defaultExecOptions } : undefined;
            if (!defaultExecOptions) return out;
            return { ...defaultExecOptions, ...out };
        };
        const ensureUsable = () => {
            if (disposed || generation !== self.handleGeneration) {
                disposed = true;
                throw new Error("Handle disposed or invalidated");
            }
        };

        const handle: Record<string, unknown> = {
            id,
            get: async <T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T> => {
                ensureUsable();
                return await self.runHandleOp({ op: "get", id, path: path ?? "" }, toExecOptions(options)) as T;
            },
            has: async (path: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(path ?? "").trim();
                if (!p) throw new Error("handle.has(path) requires a non-empty path");
                return await self.runHandleOp({ op: "has", id, path: p }, toExecOptions(options));
            },
            set: async (path: string, value: any, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(path ?? "").trim();
                if (!p) throw new Error("handle.set(path, value) requires a non-empty path");
                await self.runHandleOp({ op: "set", id, path: p, value }, toExecOptions(options));
            },
            delete: async (path: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(path ?? "").trim();
                if (!p) throw new Error("handle.delete(path) requires a non-empty path");
                return await self.runHandleOp({ op: "delete", id, path: p }, toExecOptions(options));
            },
            keys: async (path?: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                return await self.runHandleOp({ op: "keys", id, path: path ?? "" }, toExecOptions(options));
            },
            entries: async (path?: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                return await self.runHandleOp({ op: "entries", id, path: path ?? "" }, toExecOptions(options));
            },
            getOwnPropertyDescriptor: async (path: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(path ?? "").trim();
                if (!p) throw new Error("handle.getOwnPropertyDescriptor(path) requires a non-empty path");
                return await self.runHandleOp({ op: "getOwnPropertyDescriptor", id, path: p }, toExecOptions(options));
            },
            define: async (path: string, descriptor: PropertyDescriptor, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(path ?? "").trim();
                if (!p) throw new Error("handle.define(path, descriptor) requires a non-empty path");
                return await self.runHandleOp({ op: "define", id, path: p, descriptor }, toExecOptions(options));
            },
            instanceOf: async (constructorPath: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                const p = String(constructorPath ?? "").trim();
                if (!p) throw new Error("handle.instanceOf(constructorPath) requires a non-empty path");
                return await self.runHandleOp({ op: "instanceOf", id, constructorPath: p }, toExecOptions(options));
            },
            isCallable: async (path?: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                return await self.runHandleOp({ op: "isCallable", id, path: path ?? "" }, toExecOptions(options));
            },
            isPromise: async (path?: string, options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                return await self.runHandleOp({ op: "isPromise", id, path: path ?? "" }, toExecOptions(options));
            },
            call: async <T = any>(
                pathOrArgs?: string | any[],
                argsOrOptions?: any[] | DenoWorkerHandleExecOptions,
                optionsMaybe?: DenoWorkerHandleExecOptions,
            ): Promise<T> => {
                ensureUsable();
                const opId = `handle.call:${id}:${randomUUID()}`;
                if (typeof pathOrArgs === "string") {
                    const p = pathOrArgs.trim();
                    if (!p) throw new Error("handle.call(path, args?) requires a non-empty path");
                    if (argsOrOptions !== undefined && !Array.isArray(argsOrOptions)) {
                        throw new Error("handle.call(path, args?, options?) expects args as an array when path is provided");
                    }
                    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
                    self.emitRuntimeEvent({ kind: "handle.call.begin", opId, handleId: id, path: p, args });
                    try {
                        const out = await self.runHandleCallOp(id, p, args, toExecOptions(optionsMaybe));
                        self.emitRuntimeEvent({ kind: "handle.call.end", opId, handleId: id, path: p, ok: true });
                        return out as T;
                    } catch (e) {
                        self.emitRuntimeEvent({ kind: "handle.call.end", opId, handleId: id, path: p, ok: false });
                        self.emitThrownError(opId, "handle.call", e);
                        throw e;
                    }
                }
                const args = pathOrArgs;
                if (args !== undefined && !Array.isArray(args)) {
                    throw new Error("handle.call(args?) expects args as an array");
                }
                const execOptions = toExecOptions(optionsMaybe ?? (Array.isArray(argsOrOptions) ? undefined : argsOrOptions));
                const callArgs = Array.isArray(args) ? args : [];
                self.emitRuntimeEvent({ kind: "handle.call.begin", opId, handleId: id, path: "", args: callArgs });
                try {
                    const out = await self.runHandleCallOp(id, "", callArgs, execOptions);
                    self.emitRuntimeEvent({ kind: "handle.call.end", opId, handleId: id, path: "", ok: true });
                    return out as T;
                } catch (e) {
                    self.emitRuntimeEvent({ kind: "handle.call.end", opId, handleId: id, path: "", ok: false });
                    self.emitThrownError(opId, "handle.call", e);
                    throw e;
                }
            },
            construct: async <T = any>(args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T> => {
                ensureUsable();
                if (args !== undefined && !Array.isArray(args)) {
                    throw new Error("handle.construct(args?) expects args as an array");
                }
                return await self.runHandleOp(
                    { op: "construct", id, args: Array.isArray(args) ? args : [] },
                    toExecOptions(options),
                ) as T;
            },
            await: async <T = any>(options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions): Promise<T> => {
                ensureUsable();
                const resolved = await self.runHandleOp({
                    op: "await",
                    id,
                    returnValue: options?.returnValue,
                    untilNonPromise: options?.untilNonPromise,
                }, toExecOptions(options));
                rootTypeCache = (await self.runHandleOp({ op: "getType", id, path: "" }, toExecOptions(options))) as DenoWorkerHandleTypeInfo;
                return resolved as T;
            },
            clone: async (options?: DenoWorkerHandleExecOptions) => {
                ensureUsable();
                self.ensureHandleCapacity();
                const nextId = self.nextHandleId();
                const execOptions = toExecOptions(options);
                await self.runHandleOp({ op: "clone", id, nextId }, execOptions);
                const clonedRootType = (await self.runHandleOp({
                    op: "getType",
                    id: nextId,
                    path: "",
                }, execOptions)) as DenoWorkerHandleTypeInfo;
                self.activeHandleIds.add(nextId);
                return self.createHandle(nextId, generation, clonedRootType, defaultExecOptions);
            },
            toJSON: async <T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T> => {
                ensureUsable();
                return await self.runHandleOp({ op: "toJSON", id, path: path ?? "" }, toExecOptions(options)) as T;
            },
            apply: async <T = any[]>(ops: DenoWorkerHandleApplyOp[], options?: DenoWorkerHandleExecOptions): Promise<T> => {
                ensureUsable();
                if (!Array.isArray(ops)) throw new Error("handle.apply(ops) expects an array");
                return await self.runHandleOp({ op: "apply", id, ops }, toExecOptions(options)) as T;
            },
            getType: async (path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo> => {
                ensureUsable();
                const p = path ?? "";
                const info = (await self.runHandleOp({ op: "getType", id, path: p }, toExecOptions(options))) as DenoWorkerHandleTypeInfo;
                if (p === "") {
                    rootTypeCache = info;
                }
                return info;
            },
            dispose: async (options?: DenoWorkerHandleExecOptions) => {
                if (disposed) return;
                disposed = true;
                self.activeHandleIds.delete(id);
                if (generation !== self.handleGeneration || self.isClosed()) return;
                const opId = `handle.dispose:${id}`;
                self.emitRuntimeEvent({ kind: "handle.dispose", opId, handleId: id });
                try {
                    await self.runHandleOp({ op: "dispose", id }, toExecOptions(options));
                } catch {
                    // ignore best-effort dispose races
                }
            },
        };

        Object.defineProperty(handle, "disposed", {
            enumerable: true,
            configurable: false,
            get: () => disposed || generation !== self.handleGeneration,
        });
        Object.defineProperty(handle, "rootType", {
            enumerable: true,
            configurable: false,
            get: () => rootTypeCache,
        });
        return handle as DenoWorkerHandle;
    }

    /** Fast-path check for binary payloads that can be forwarded directly to native. */
    private isBinaryLikeValue(value: any): boolean {
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
        if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
        if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return true;
        if (
            typeof ArrayBuffer !== "undefined" &&
            typeof ArrayBuffer.isView === "function" &&
            ArrayBuffer.isView(value)
        ) {
            return true;
        }
        return false;
    }

    /** Detects { type, id, payload } message envelopes that can use a native typed fast path. */
    private extractTypedMessageEnvelope(value: any): { type: string; id: number; payload: any } | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        const type = (value as any).type;
        if (typeof type !== "string" || !type) return null;
        const id = (value as any).id;
        if (typeof id !== "number" || !Number.isFinite(id) || id < 0) return null;
        const payload = (value as any).payload;
        return { type, id: Math.trunc(id), payload };
    }

    /** Conservative binary fast path for setGlobal to preserve typed-array class fidelity. */
    private isSetGlobalBinaryFastPath(value: any): boolean {
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return true;
        if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return true;
        if (typeof Uint8Array !== "undefined" && value instanceof Uint8Array) return true;
        return false;
    }

    /** Recursively serializes globals while preserving special types and avoiding cycles. */
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

    /** Sets a global on native runtime after host-side serialization and in-flight tracking. */
    private async setGlobalInternal(key: string, value: any): Promise<void> {
        try {
            const payload = this.isSetGlobalBinaryFastPath(value) ? value : this.serializeGlobalValue(value);
            await this.trackInFlight(this.native.setGlobal(key, payload));
        } catch (e) {
            throw hydrateFromWire(e);
        }
    }

    /** Registers a module source in native runtime without waiting on startup gates. */
    private async registerModuleInternal(moduleName: string, source: string): Promise<void> {
        const name = String(moduleName ?? "").trim();
        if (!name) throw new Error("registerModule(moduleName, source) requires non-empty moduleName");
        if (typeof this.native.registerModule !== "function") {
            throw new Error("registerModule is not available in this runtime");
        }
        await this.trackInFlight(this.native.registerModule(name, String(source ?? "")));
    }

    /** Clears a module source from native runtime without waiting on startup gates. */
    private async clearModuleInternal(moduleName: string): Promise<boolean> {
        const name = String(moduleName ?? "").trim();
        if (!name) throw new Error("clearModule(moduleName) requires non-empty moduleName");
        if (typeof this.native.clearModule !== "function") {
            throw new Error("clearModule is not available in this runtime");
        }
        return Boolean(await this.trackInFlight(this.native.clearModule(name)));
    }

    /** Initializes constructor-time globals/modules and tracks startup readiness/error state. */
    private initializeStartup(globals?: Record<string, any>, modules?: Record<string, string>): void {
        const globalEntries = globals && typeof globals === "object" ? Object.entries(globals) : [];
        const moduleEntriesRaw = modules && typeof modules === "object" ? Object.entries(modules) : [];
        const moduleEntries = moduleEntriesRaw
            .map(([name, source]) => [String(name ?? "").trim(), String(source ?? "")] as const)
            .filter(([name]) => name.length > 0);
        if (globalEntries.length === 0 && moduleEntries.length === 0) {
            this.startupReady = true;
            this.startupError = null;
            this.startupPromise = Promise.resolve();
            return;
        }

        this.startupReady = false;
        this.startupError = null;
        this.startupPromise = (async () => {
            for (const [name, source] of moduleEntries) {
                await this.registerModuleInternal(name, source);
            }
            for (const [k, v] of globalEntries) {
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

    /** Emits lifecycle callbacks to configured hooks and runtime subscribers. */
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

    /** Emits runtime events to `on("runtime")` listeners with auto timestamping. */
    private emitRuntimeEvent(event: Omit<DenoWorkerRuntimeEvent, "ts"> & { ts?: number }): void {
        if (this.runtimeHandlers.size === 0) return;
        const payload = {
            ...event,
            ts: typeof event.ts === "number" ? event.ts : Date.now(),
        } as DenoWorkerRuntimeEvent;
        for (const cb of [...this.runtimeHandlers]) {
            try {
                cb(payload);
            } catch {
                // ignore runtime subscriber errors
            }
        }
    }

    /** Emits standardized user-visible thrown error events. */
    private emitThrownError(opId: string, surface: string, error: unknown): void {
        this.emitRuntimeEvent({
            kind: "error.thrown",
            opId,
            surface,
            error,
        });
    }

    /** Constructs a new native worker instance and routes creation failures through crash hooks. */
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

    /** Returns true when incoming payload can skip wire rehydration safely. */
    private canBypassWireHydration(value: any): boolean {
        if (value === null) return true;
        const t = typeof value;
        if (t === "string" || t === "boolean") return true;
        if (t === "number") return Number.isFinite(value);
        if (t !== "object") return false;
        if (this.isBinaryLikeValue(value)) return false;

        if (Array.isArray(value)) {
            if (value.length > 32) return false;
            for (const item of value) {
                if (item === null) continue;
                const it = typeof item;
                if (it === "string" || it === "boolean") continue;
                if (it === "number" && Number.isFinite(item)) continue;
                return false;
            }
            return true;
        }

        const proto = Object.getPrototypeOf(value);
        if (!(proto === Object.prototype || proto === null)) return false;
        const entries = Object.entries(value);
        if (entries.length > 32) return false;
        for (const [k, v] of entries) {
            if (k === "__proto__" || WIRE_MARKER_KEY_SET.has(k)) return false;
            if (v === null) continue;
            const vt = typeof v;
            if (vt === "string" || vt === "boolean") continue;
            if (vt === "number" && Number.isFinite(v)) continue;
            return false;
        }
        return true;
    }

    /** Wires native message/close events to wrapper message routing, stream handling, and lifecycle flow. */
    private bindNativeEvents(native: NativeWorker, epoch: number): void {
        native.on("message", (msg: any) => {
            if (epoch !== this.nativeEpoch) return;
            const frame = decodeStreamFrameEnvelope(msg);
            if (frame && this.handleIncomingStreamFrame(frame)) return;
            if (this.handleIncomingStreamFrame(msg)) return;
            const hydrated = this.canBypassWireHydration(msg) ? msg : hydrateFromWire(msg);
            if (this.handleIncomingStreamFrame(hydrated)) return;
            if (this.messageHandlers.size === 0) return;
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
            this.invalidateHandles();
            this.failAllStreams("DenoWorker closed unexpectedly");
            this.emitCloseHandlersIfNeeded();
            if (!this.closeRequested) {
                this.invokeHook("onCrash", {
                    reason: new Error("Worker closed unexpectedly"),
                    requested: false,
                });
            }
        });

        native.on("runtime", (event: any) => {
            if (epoch !== this.nativeEpoch) return;
            const hydrated = this.canBypassWireHydration(event) ? event : hydrateFromWire(event);
            if (!hydrated || typeof hydrated !== "object") return;
            const payload = hydrated as DenoWorkerRuntimeEvent;
            this.emitRuntimeEvent(payload);
        });
    }

    /** Calls all registered close listeners once. */
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

    /** Ensures close listeners are emitted only a single time per worker lifecycle. */
    private emitCloseHandlersIfNeeded(): void {
        if (this.closeNotified) return;
        this.closeNotified = true;
        this.emitCloseHandlers();
    }

    /** Allocates the next unique stream id for either native or wrapper-initiated streams. */
    private nextStreamId(prefix: "n" | "w" = "n"): string {
        this.streamCounter += 1;
        const base = (this.nativeEpoch * 1_000_000 + this.streamCounter) >>> 0;
        if (prefix === "w") return String((2_147_483_648 + base) >>> 0);
        return String(base || 1);
    }

    /** Sends one logical stream frame to runtime after envelope encoding. */
    private emitStreamFrame(frame: Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>): void {
        const postControl = (this.native as any).postStreamControl;
        if (typeof postControl === "function" && frame.t !== "chunk") {
            const kind = frame.t;
            const id = frame.id;
            let aux: string | undefined;
            if (kind === "open") aux = frame.key ?? "";
            else if (kind === "error") aux = frame.error ?? "";
            else if (kind === "cancel") aux = frame.reason ?? "";
            else if (kind === "credit") aux = String(Math.max(0, Math.trunc(frame.credit ?? 0)));
            const ok = postControl(kind, id, aux);
            if (!ok) throw new Error("DenoWorker.postStreamControl failed: worker is closed");
            return;
        }
        this.postMessageRaw(encodeStreamFrameEnvelope(frame));
    }

    /** Sends a batch of logical stream frames using native bulk-post when available. */
    private emitStreamFrames(frames: Array<Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>>): void {
        if (frames.length === 0) return;
        if (frames.length <= 2) {
            for (const frame of frames) this.emitStreamFrame(frame);
            return;
        }
        const postControl = (this.native as any).postStreamControl;
        if (typeof postControl === "function" && frames.every((f) => f.t !== "chunk")) {
            for (const frame of frames) this.emitStreamFrame(frame);
            return;
        }
        const raw = frames.map((f) => encodeStreamFrameEnvelope(f));
        if (typeof (this.native as any).postMessages === "function") {
            const sent = (this.native as any).postMessages(raw);
            if (sent !== raw.length) {
                throw new Error("DenoWorker.postMessages failed: worker is closed");
            }
            return;
        }
        for (const frame of raw) this.postMessageRaw(frame);
    }

    /** Accumulates consumed-byte credits for a stream and schedules credit frame flushes. */
    private queueCreditFrame(id: string, bytes: number): void {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        const prev = this.pendingCreditFrames.get(id) || 0;
        const next = prev + Math.trunc(bytes);
        this.pendingCreditFrames.set(id, next);
        const flushThreshold = Math.max(1, Math.min(this.streamCreditFlushBytes, this.streamWindowBytes));
        if (next >= flushThreshold) {
            this.flushCreditFrames();
            return;
        }
        if (this.creditFlushScheduled) return;
        this.creditFlushScheduled = true;
        const run = () => {
            this.creditFlushScheduled = false;
            this.flushCreditFrames();
        };
        if (typeof setImmediate === "function") {
            setImmediate(run);
        }
        else {
            queueMicrotask(run);
        }
    }

    /** Flushes queued stream credit updates to the remote writer side. */
    private flushCreditFrames(): void {
        if (this.pendingCreditFrames.size === 0 || this.isClosed()) return;
        const frames: Array<Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>> = [];
        for (const [id, credit] of this.pendingCreditFrames.entries()) {
            if (credit > 0) frames.push({ t: "credit", id, credit });
        }
        this.pendingCreditFrames.clear();
        if (frames.length === 0) return;
        this.emitStreamFrames(frames);
    }

    /** Adds writer credit and resolves any waiters now meeting their required minimum. */
    private addWriterCredit(id: string, credit: number): void {
        if (!Number.isFinite(credit) || credit <= 0) return;
        const next = (this.streamWriterCredits.get(id) || 0) + Math.trunc(credit);
        this.streamWriterCredits.set(id, next);
        const waiters = this.streamWriterWaiters.get(id);
        if (!waiters || waiters.length === 0) return;
        const remain: typeof waiters = [];
        for (const w of waiters) {
            if (next >= w.minBytes) w.resolve();
            else remain.push(w);
        }
        if (remain.length > 0) this.streamWriterWaiters.set(id, remain);
        else this.streamWriterWaiters.delete(id);
    }

    /** Deducts consumed writer credit after chunk transmission. */
    private consumeWriterCredit(id: string, amount: number): void {
        const have = this.streamWriterCredits.get(id) || 0;
        const next = have - amount;
        this.streamWriterCredits.set(id, next > 0 ? next : 0);
    }

    /** Waits until a stream has at least `minBytes` of writable credit. */
    private waitForWriterCredit(id: string, minBytes: number): Promise<void> {
        if ((this.streamWriterCredits.get(id) || 0) >= minBytes) return Promise.resolve();
        const pending = new Promise<void>((resolve, reject) => {
            const arr = this.streamWriterWaiters.get(id) || [];
            arr.push({ minBytes, resolve, reject });
            this.streamWriterWaiters.set(id, arr);
        });
        // Prevent teardown-triggered rejections from surfacing as unhandled before callers attach handlers.
        void pending.catch(() => {});
        return pending;
    }

    /** Returns desired free slot pool size based on current in-use stream count. */
    private desiredStreamSlotPoolTarget(): number {
        const scaled = Math.ceil((this.streamSlotsInUse * STREAM_SLOT_POOL_SCALE_NUM) / STREAM_SLOT_POOL_SCALE_DEN);
        const target = scaled + STREAM_SLOT_POOL_HEADROOM;
        if (target < STREAM_SLOT_POOL_MIN) return STREAM_SLOT_POOL_MIN;
        if (target > STREAM_SLOT_POOL_MAX) return STREAM_SLOT_POOL_MAX;
        return target;
    }

    /** Grows or trims the preallocated stream slot pool to a target free-slot count. */
    private resizeStreamSlotPool(target: number): void {
        if (target < 0) target = 0;
        while (this.streamSlotPool.length < target) {
            this.streamSlotPool.push({ name: "", localDiscarded: false, remoteDiscarded: false });
        }
        if (this.streamSlotPool.length > target) {
            this.streamSlotPool.length = target;
        }
    }

    /** Periodically retunes stream slot preallocation with hysteresis to avoid thrash. */
    private tuneStreamSlotPool(force = false): void {
        if (!force) {
            this.streamSlotPoolOps += 1;
            if (this.streamSlotPoolOps < STREAM_SLOT_POOL_TUNE_INTERVAL) return;
            this.streamSlotPoolOps = 0;
        }
        const desired = this.desiredStreamSlotPoolTarget();
        if (!force && Math.abs(desired - this.streamSlotPoolTarget) < STREAM_SLOT_POOL_HYSTERESIS) return;
        this.streamSlotPoolTarget = desired;
        this.resizeStreamSlotPool(this.streamSlotPoolTarget);
    }

    /** Borrows a reusable stream slot from pool (or allocates one) for a newly opened stream. */
    private acquireStreamSlot(name: string): StreamSlotMeta {
        const slot = this.streamSlotPool.pop() || { name: "", localDiscarded: false, remoteDiscarded: false };
        slot.name = name;
        slot.localDiscarded = false;
        slot.remoteDiscarded = false;
        this.streamSlotsInUse += 1;
        this.tuneStreamSlotPool();
        return slot;
    }

    /** Returns a stream slot to pool after resetting mutable fields. */
    private releaseStreamSlot(slot: StreamSlotMeta): void {
        slot.name = "";
        slot.localDiscarded = false;
        slot.remoteDiscarded = false;
        if (this.streamSlotsInUse > 0) this.streamSlotsInUse -= 1;
        this.tuneStreamSlotPool();
        if (this.streamSlotPool.length < this.streamSlotPoolTarget) {
            this.streamSlotPool.push(slot);
        }
    }

    /** Registers a newly opened stream key/id pair and guards against duplicates. */
    private registerStream(name: string, id: string): void {
        if (this.streamById.has(id)) {
            throw new Error(`Duplicate stream id: ${id}`);
        }
        if (this.streamNameToId.has(name)) {
            throw new Error(`Stream key already in use: ${name}`);
        }
        this.streamById.set(id, this.acquireStreamSlot(name));
        this.streamNameToId.set(name, id);
    }

    /** Marks local discard state for a stream and emits discard frame to remote side. */
    private markLocalDiscard(id: string): void {
        const meta = this.streamById.get(id);
        if (!meta || meta.localDiscarded) return;
        meta.localDiscarded = true;
        try {
            this.emitStreamFrame({ t: "discard", id });
        } catch {
            // ignore
        }
        this.tryReleaseStream(id);
    }

    /** Marks that remote side acknowledged discard for a stream. */
    private markRemoteDiscard(id: string): void {
        const meta = this.streamById.get(id);
        if (!meta || meta.remoteDiscarded) return;
        meta.remoteDiscarded = true;
        this.tryReleaseStream(id);
    }

    /** Releases stream bookkeeping once both local and remote discard markers are observed. */
    private tryReleaseStream(id: string): void {
        const meta = this.streamById.get(id);
        if (!meta) return;
        if (!meta.localDiscarded || !meta.remoteDiscarded) return;
        this.streamById.delete(id);
        this.streamIncoming.delete(id);
        this.pendingIncomingStreamFrames.delete(id);
        this.pendingCreditFrames.delete(id);
        this.streamWriterCredits.delete(id);
        const waiters = this.streamWriterWaiters.get(id);
        if (waiters && waiters.length > 0) {
            for (const waiter of waiters) waiter.reject(new Error("stream released"));
        }
        this.streamWriterWaiters.delete(id);
        const current = this.streamNameToId.get(meta.name);
        if (current === id) this.streamNameToId.delete(meta.name);
        this.streamHeaderCache.clear(id);
        this.releaseStreamSlot(meta);
    }

    /** Rejects an incoming stream open request by emitting error+discard control frames. */
    private rejectIncomingOpen(id: string, reason: string): void {
        this.pendingIncomingStreamFrames.delete(id);
        this.emitStreamFrame({ t: "error", id, error: reason });
        this.emitStreamFrame({ t: "discard", id });
    }

    /** Delivers an accepted stream to a pending accept waiter or stores it in backlog. */
    private queueAcceptedStream(name: string, reader: DenoWorkerStreamReader): void {
        const waiter = this.streamPendingAccepts.get(name);
        if (waiter) {
            this.streamPendingAccepts.delete(name);
            waiter.resolve(reader);
            return;
        }
        this.streamBacklog.set(name, reader);
    }

    /** Temporarily buffers out-of-order stream frames until corresponding `open` is processed. */
    private queuePendingIncomingStreamFrame(frame: StreamFrame): void {
        const queued = this.pendingIncomingStreamFrames.get(frame.id) || [];
        if (queued.length >= 256) queued.shift();
        queued.push(frame);
        this.pendingIncomingStreamFrames.set(frame.id, queued);
    }

    /** Handles incoming stream control/data frames and routes them to the appropriate reader state. */
    private handleIncomingStreamFrame(payload: unknown): boolean {
        if (!isStreamFrame(payload)) return false;
        const frame = payload;

        switch (frame.t) {
            case "open": {
                const key = typeof frame.key === "string" && frame.key ? frame.key : frame.id;
                if (this.streamNameToId.has(key) || this.streamBacklog.has(key)) {
                    this.rejectIncomingOpen(frame.id, `Stream key already in use: ${key}`);
                    return true;
                }
                if (!this.streamPendingAccepts.has(key) && this.streamBacklog.size >= this.streamBacklogLimit) {
                    this.rejectIncomingOpen(frame.id, `Stream backlog limit reached (${this.streamBacklogLimit})`);
                    return true;
                }
                this.registerStream(key, frame.id);
                const reader = new StreamReaderImpl(this.streamReaderHighWaterMarkBytes);
                reader.setRemoteCancel((reason?: string) => {
                    this.emitStreamFrame({
                        t: "cancel",
                        id: frame.id,
                        reason,
                    });
                });
                reader.setOnLocalDiscard(() => {
                    this.markLocalDiscard(frame.id);
                });
                reader.setOnChunkConsumed((bytes: number) => {
                    this.queueCreditFrame(frame.id, bytes);
                });
                this.streamIncoming.set(frame.id, reader);
                this.queueAcceptedStream(key, reader);
                const pending = this.pendingIncomingStreamFrames.get(frame.id);
                if (pending && pending.length > 0) {
                    this.pendingIncomingStreamFrames.delete(frame.id);
                    for (const queued of pending) {
                        this.handleIncomingStreamFrame(queued);
                    }
                }
                return true;
            }
            case "chunk": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) {
                    if (!this.streamById.has(frame.id)) this.queuePendingIncomingStreamFrame(frame);
                    return true;
                }
                const chunk = frame.chunk instanceof Uint8Array ? frame.chunk : null;
                if (!(chunk instanceof Uint8Array)) {
                    target.errorRemote(new Error(`Invalid stream chunk for ${frame.id}`));
                    return true;
                }
                target.pushChunk(chunk);
                return true;
            }
            case "close": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) {
                    if (!this.streamById.has(frame.id)) this.queuePendingIncomingStreamFrame(frame);
                    return true;
                }
                target.closeRemote();
                return true;
            }
            case "error": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) {
                    if (!this.streamById.has(frame.id)) this.queuePendingIncomingStreamFrame(frame);
                    return true;
                }
                target.errorRemote(new Error(frame.error || "Remote stream error"));
                return true;
            }
            case "cancel": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) {
                    if (!this.streamById.has(frame.id)) this.queuePendingIncomingStreamFrame(frame);
                    return true;
                }
                target.errorRemote(new Error(frame.reason || "Remote stream cancelled"));
                return true;
            }
            case "discard": {
                this.markRemoteDiscard(frame.id);
                return true;
            }
            case "credit": {
                this.addWriterCredit(frame.id, Number(frame.credit || 0));
                return true;
            }
            default:
                return true;
        }
    }

    /** Fails and clears all tracked stream state, notifying readers/writers/accept waiters. */
    private failAllStreams(reason: string): void {
        for (const reader of this.streamIncoming.values()) {
            reader.errorRemote(new Error(reason));
        }
        this.streamIncoming.clear();
        for (const meta of this.streamById.values()) {
            this.releaseStreamSlot(meta);
        }
        this.streamById.clear();
        this.streamNameToId.clear();
        this.streamBacklog.clear();
        this.pendingIncomingStreamFrames.clear();
        this.pendingCreditFrames.clear();
        this.streamWriterCredits.clear();
        for (const waiters of this.streamWriterWaiters.values()) {
            for (const waiter of waiters) waiter.reject(new Error(reason));
        }
        this.streamWriterWaiters.clear();
        for (const id of this.streamById.keys()) this.streamHeaderCache.clear(id);

        for (const waiter of this.streamPendingAccepts.values()) {
            waiter.reject(new Error(reason));
        }
        this.streamPendingAccepts.clear();
        this.tuneStreamSlotPool(true);
    }

    /** Tracks in-flight async operations so they can be force-rejected during shutdown. */
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

    /** Rejects all currently tracked in-flight wrapper operations with a shared reason. */
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
        const parsedMaxHandle = Number((options as any)?.limits?.maxHandle);
        this.maxHandle =
            Number.isFinite(parsedMaxHandle) && parsedMaxHandle >= 1
                ? Math.trunc(parsedMaxHandle)
                : HANDLE_DEFAULT_MAX;
        const rawBridge: any = options && typeof options === "object" ? (options as any).bridge : undefined;
        const parsedWindow = Number(rawBridge?.streamWindowBytes);
        const parsedFlush = Number(rawBridge?.streamCreditFlushBytes);
        const parsedBacklogLimit = Number(rawBridge?.streamBacklogLimit);
        const parsedHighWaterMark = Number(rawBridge?.streamHighWaterMarkBytes);
        this.streamWindowBytes =
            Number.isFinite(parsedWindow) && parsedWindow >= 1
                ? Math.trunc(parsedWindow)
                : STREAM_DEFAULT_WINDOW_BYTES;
        this.streamCreditFlushBytes =
            Number.isFinite(parsedFlush) && parsedFlush >= 1
                ? Math.trunc(parsedFlush)
                : STREAM_CREDIT_FLUSH_THRESHOLD;
        this.streamBacklogLimit =
            Number.isFinite(parsedBacklogLimit) && parsedBacklogLimit >= 1
                ? Math.trunc(parsedBacklogLimit)
                : STREAM_BACKLOG_DEFAULT_LIMIT;
        this.streamReaderHighWaterMarkBytes =
            Number.isFinite(parsedHighWaterMark) && parsedHighWaterMark >= 1
                ? Math.trunc(parsedHighWaterMark)
                : this.streamWindowBytes;
        this.streamSlotPoolTarget = STREAM_SLOT_POOL_MIN;
        this.resizeStreamSlotPool(this.streamSlotPoolTarget);
        this.invokeHook("beforeStart", { options });
        this.native = this.createNative(false);
        this.nativeEpoch += 1;
        this.bindNativeEvents(this.native, this.nativeEpoch);
        this.initializeStartup(options?.globals, options?.modules);
        this.invokeHook("afterStart");
    }

    /**
     * Subscribe to runtime events.
     *
     * Event semantics:
     * - `message`: receives payloads posted from runtime `postMessage(...)`.
     * - `close`: emitted once runtime closes.
     * - `lifecycle`: emits lifecycle transitions and crash/requested flags.
     * - `runtime`: emits runtime execution/import/handle events.
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
    on(event: "runtime", cb: DenoWorkerRuntimeHandler): void;
    on(
        event: DenoWorkerEvent,
        cb: DenoWorkerMessageHandler | DenoWorkerCloseHandler | DenoWorkerLifecycleHandler | DenoWorkerRuntimeHandler,
    ): void {
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
            return;
        }
        if (event === "runtime" && typeof cb === "function") {
            this.runtimeHandlers.add(cb as DenoWorkerRuntimeHandler);
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
    off(event: "runtime", cb?: DenoWorkerRuntimeHandler): void;
    off(
        event: DenoWorkerEvent,
        cb?: DenoWorkerMessageHandler | DenoWorkerCloseHandler | DenoWorkerLifecycleHandler | DenoWorkerRuntimeHandler,
    ): void {
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
        if (event === "runtime") {
            if (cb) this.runtimeHandlers.delete(cb as DenoWorkerRuntimeHandler);
            else this.runtimeHandlers.clear();
            return;
        }
        if (cb) this.lifecycleHandlers.delete(cb as DenoWorkerLifecycleHandler);
        else this.lifecycleHandlers.clear();
    }

    /**
     * Post a message into the runtime event channel.
     *
     * Throws when runtime is closed.
     */
    postMessage(msg: any): void {
        const typedEnvelope = this.extractTypedMessageEnvelope(msg);
        if (typedEnvelope && typeof this.native.postMessageTyped === "function") {
            if (!this.native.postMessageTyped(typedEnvelope.type, typedEnvelope.id, typedEnvelope.payload)) {
                throw new Error("DenoWorker.postMessage failed: worker is closed");
            }
            return;
        }
        const payload = this.isBinaryLikeValue(msg) ? msg : dehydrateForWire(msg);
        this.postMessageRaw(payload);
    }

    /** Posts a pre-serialized payload directly to native message channel. */
    private postMessageRaw(msg: any): void {
        if (this.isClosed()) {
            throw new Error("DenoWorker.postMessage failed: worker is closed");
        }
        const ok = this.native.postMessage(msg);
        if (!ok) {
            throw new Error("DenoWorker.postMessage failed: worker is closed");
        }
    }

    /**
     * Batch enqueue variant of {@link postMessage}.
     *
     * Returns the number of messages accepted by the native queue.
     * Throws if worker is closed.
     */
    postMessages(msgs: any[]): number {
        if (this.isClosed()) {
            throw new Error("DenoWorker.postMessages failed: worker is closed");
        }
        if (!Array.isArray(msgs) || msgs.length === 0) return 0;

        const payloads = msgs.map((m) => (this.isBinaryLikeValue(m) ? m : dehydrateForWire(m)));
        const sent = (this.native as any).postMessages(payloads) as number;
        if (sent !== payloads.length) {
            throw new Error("DenoWorker.postMessages failed: worker is closed");
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
        const payloads = msgs.map((m) => (this.isBinaryLikeValue(m) ? m : dehydrateForWire(m)));
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
        const typedEnvelope = this.extractTypedMessageEnvelope(msg);
        if (typedEnvelope && typeof this.native.postMessageTyped === "function") {
            return this.native.postMessageTyped(typedEnvelope.type, typedEnvelope.id, typedEnvelope.payload);
        }
        const payload = this.isBinaryLikeValue(msg) ? msg : dehydrateForWire(msg);
        return this.native.postMessage(payload);
    }

    /** Returns stable directional keys for bidirectional `stream.connect(key)` sessions. */
    private connectDirectionalKeys(key: string): { hostToWorker: string; workerToHost: string } {
        const base = String(key || "").trim();
        if (!base) throw new Error("stream.connect(key) requires a non-empty key");
        return {
            hostToWorker: `${base}${STREAM_CONNECT_HOST_TO_WORKER_SUFFIX}`,
            workerToHost: `${base}${STREAM_CONNECT_WORKER_TO_HOST_SUFFIX}`,
        };
    }

    /** Creates a Node.js Duplex over paired stream writer/reader endpoints. */
    private createDuplexBridge(
        writer: DenoWorkerStreamWriter,
        startReader: () => Promise<DenoWorkerStreamReader>,
        name: string,
    ): Duplex {
        let destroyed = false;
        let writableClosed = false;
        let readerRef: DenoWorkerStreamReader | null = null;
        let readStartRequested = false;
        let triggerReadStart: (() => void) | null = null;
        const readStartPromise = new Promise<void>((resolve) => {
            triggerReadStart = resolve;
        });
        let waitingReadableResume: (() => void) | null = null;
        const consumeWait = async (): Promise<void> => {
            if (!waitingReadableResume) return;
            const waiter = waitingReadableResume;
            waitingReadableResume = null;
            waiter();
            await Promise.resolve();
        };
        const normalizeChunk = (chunk: string | Buffer | Uint8Array): Uint8Array => {
            if (typeof chunk === "string") return Buffer.from(chunk);
            if (chunk instanceof Uint8Array) return chunk;
            return Buffer.from(chunk);
        };
        const toError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

        const duplex = new Duplex({
            write: (chunk, _enc, cb) => {
                if (destroyed || writableClosed) {
                    cb(new Error(`Stream already closed: ${name}`));
                    return;
                }
                const payload = normalizeChunk(chunk as string | Buffer | Uint8Array);
                const fastWriter = writer as DenoWorkerStreamWriter & InternalStreamWriterFastPath;
                if (typeof fastWriter.__writeWithCallbacks === "function") {
                    fastWriter.__writeWithCallbacks(
                        payload,
                        () => cb(),
                        (err) => cb(toError(err)),
                    );
                    return;
                }
                writer.write(payload).then(
                    () => cb(),
                    (err) => cb(toError(err)),
                );
            },
            final: (cb) => {
                if (destroyed || writableClosed) {
                    cb();
                    return;
                }
                writableClosed = true;
                writer.close().then(
                    () => cb(),
                    (err) => cb(toError(err)),
                );
            },
            destroy: (err, cb) => {
                destroyed = true;
                const readerCancel = readerRef
                    ? readerRef.cancel(err ? String(err) : "duplex destroyed")
                    : Promise.resolve();
                Promise.allSettled([
                    readerCancel,
                    writer.cancel(err ? String(err) : "duplex destroyed"),
                ]).then(() => cb(err || null));
            },
            read: () => {
                if (!readStartRequested) {
                    readStartRequested = true;
                    const trigger = triggerReadStart;
                    triggerReadStart = null;
                    if (trigger) trigger();
                }
                void consumeWait();
            },
        });

        (async () => {
            try {
                await readStartPromise;
                if (destroyed) return;
                const reader = await startReader();
                readerRef = reader;
                if (destroyed) {
                    await reader.cancel("duplex destroyed");
                    return;
                }
                for await (const chunk of reader) {
                    if (destroyed) break;
                    const canContinue = duplex.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    if (!canContinue && !destroyed) {
                        await new Promise<void>((resolve) => {
                            waitingReadableResume = resolve;
                        });
                    }
                }
                if (!duplex.destroyed) duplex.push(null);
            } catch (err) {
                if (!duplex.destroyed) duplex.destroy(toError(err));
            }
        })();

        duplex.once("close", () => {
            destroyed = true;
            if (waitingReadableResume) {
                const waiter = waitingReadableResume;
                waitingReadableResume = null;
                waiter();
            }
        });
        return duplex;
    }

    /** Connects a bidirectional Node.js duplex stream over paired stream lanes. */
    private async streamConnect(key: string): Promise<Duplex> {
        const { hostToWorker, workerToHost } = this.connectDirectionalKeys(key);
        const writer = this.streamCreate(hostToWorker);
        return this.createDuplexBridge(writer, () => this.streamAccept(workerToHost), key);
    }

    /** Creates an outgoing stream writer and manages writer-side flow-control + lifecycle. */
    private streamCreate(key?: string): DenoWorkerStreamWriter {
        const provided = key != null;
        const streamKey = provided ? String(key || "").trim() : "";
        if (provided && !streamKey) {
            throw new Error("stream.create(key) requires a non-empty key when provided");
        }
        if (this.isClosed()) {
            throw new Error("Cannot create stream on a closed worker");
        }

        let finalKey = streamKey;
        if (!finalKey) {
            for (let i = 0; i < 16; i += 1) {
                const candidate = generateSecureRandomStreamKey();
                if (
                    !this.streamNameToId.has(candidate) &&
                    !this.streamPendingAccepts.has(candidate) &&
                    !this.streamBacklog.has(candidate)
                ) {
                    finalKey = candidate;
                    break;
                }
            }
            if (!finalKey) {
                throw new Error("Failed to generate a unique random stream key");
            }
        }
        if (
            this.streamNameToId.has(finalKey) ||
            this.streamPendingAccepts.has(finalKey) ||
            this.streamBacklog.has(finalKey)
        ) {
            throw new Error(`Stream key already in use: ${finalKey}`);
        }

        const id = this.nextStreamId("n");
        const typedChunkType = `${STREAM_TYPED_CHUNK_PREFIX}${id}`;
        const canPostNativeChunk = typeof (this.native as any).postStreamChunk === "function";
        const canPostNativeChunkRaw = typeof (this.native as any).postStreamChunkRaw === "function";
        const canPostNativeChunkRawBin = typeof (this.native as any).postStreamChunkRawBin === "function";
        const canPostNativeChunksRaw = typeof (this.native as any).postStreamChunksRaw === "function";
        const canPostTypedChunk = typeof this.native.postMessageTyped === "function";
        this.registerStream(finalKey, id);
        const encodeChunkEnvelope = this.streamHeaderCache.chunkEncoder(id);
        const rawStreamId = Number(id);
        const useRawStreamId =
            Number.isFinite(rawStreamId) && rawStreamId >= 1 && rawStreamId <= 0xffffffff
                ? Math.trunc(rawStreamId)
                : null;
        let done = false;
        this.emitStreamFrame({ t: "open", id, key: finalKey });
        this.streamWriterCredits.set(id, this.streamWindowBytes);

        const ensureOpen = () => {
            if (done) throw new Error(`Stream already closed: ${finalKey}`);
            if (this.isClosed()) throw new Error("Worker is closed");
        };
        const rejectWriterWaiters = (reason: string) => {
            const waiters = this.streamWriterWaiters.get(id);
            if (waiters && waiters.length > 0) {
                for (const waiter of waiters) waiter.reject(new Error(reason));
            }
            this.streamWriterWaiters.delete(id);
            this.streamWriterCredits.delete(id);
        };
        const withHandledRejection = <T>(promise: Promise<T>): Promise<T> => {
            void promise.catch(() => {});
            return promise;
        };
        let queuedPayloads: Uint8Array[] = [];
        let flushQueued = false;
        let flushPromise: Promise<void> | null = null;
        let flushResolve: (() => void) | null = null;
        let flushReject: ((e: unknown) => void) | null = null;
        const settleFlush = (err?: unknown): void => {
            if (!flushPromise) return;
            const resolve = flushResolve;
            const reject = flushReject;
            flushPromise = null;
            flushResolve = null;
            flushReject = null;
            if (err !== undefined) {
                if (reject) reject(err);
                return;
            }
            if (resolve) resolve();
        };
        const flushQueuedWrites = (): void => {
            flushQueued = false;
            if (queuedPayloads.length === 0) {
                settleFlush();
                return;
            }
            const payloads = queuedPayloads;
            queuedPayloads = [];
            try {
                postRawBatch(payloads);
                settleFlush();
            } catch (err) {
                settleFlush(err);
            }
        };
        const scheduleFlushQueuedWrites = (): void => {
            if (flushQueued) return;
            flushQueued = true;
            queueMicrotask(() => {
                flushQueuedWrites();
            });
        };
        const queuePayloads = (payloads: Uint8Array[]): Promise<void> => {
            if (payloads.length === 0) return Promise.resolve();
            queuedPayloads.push(...payloads);
            if (!flushPromise) {
                flushPromise = new Promise<void>((resolve, reject) => {
                    flushResolve = resolve;
                    flushReject = reject;
                });
                // Avoid unhandled rejection if stream teardown races before caller awaits.
                void flushPromise.catch(() => {});
            }
            const pendingFlush = flushPromise;
            if (queuedPayloads.length >= 32) flushQueuedWrites();
            else scheduleFlushQueuedWrites();
            return pendingFlush;
        };
        const postRawBatch = (payloads: Uint8Array[]): void => {
            if (payloads.length === 0) return;
            if (this.isClosed()) throw new Error("DenoWorker.postMessages failed: worker is closed");
            if (typeof (this.native as any).postMessages === "function") {
                const sent = (this.native as any).postMessages(payloads);
                if (sent !== payloads.length) {
                    throw new Error("DenoWorker.postMessages failed: worker is closed");
                }
                return;
            }
            for (const payload of payloads) this.postMessageRaw(payload);
        };
        const postChunkFast = (chunk: Uint8Array): void => {
            if (NATIVE_STREAM_DEBUG) {
                try {
                    // eslint-disable-next-line no-console
                    console.log(`[stream-native-send] id=${id} bytes=${chunk.byteLength}`);
                } catch {
                    // ignore
                }
            }
            const piggybackCredit = this.pendingCreditFrames.get(id) || 0;
            if (piggybackCredit > 0) this.pendingCreditFrames.delete(id);
            if (canPostNativeChunkRawBin && useRawStreamId !== null) {
                const ok = (this.native as any).postStreamChunkRawBin(useRawStreamId, chunk, piggybackCredit || undefined);
                if (!ok) throw new Error("DenoWorker.postStreamChunkRawBin failed: worker is closed");
                return;
            }
            if (canPostNativeChunkRaw && useRawStreamId !== null) {
                const ok = (this.native as any).postStreamChunkRaw(useRawStreamId, chunk, piggybackCredit || undefined);
                if (!ok) throw new Error("DenoWorker.postStreamChunkRaw failed: worker is closed");
                return;
            }
            if (canPostNativeChunk) {
                const ok = (this.native as any).postStreamChunk(id, chunk);
                if (!ok) throw new Error("DenoWorker.postStreamChunk failed: worker is closed");
                return;
            }
            if (canPostTypedChunk) {
                if (!this.native.postMessageTyped!(typedChunkType, 0, chunk)) {
                    throw new Error("DenoWorker.postMessageTyped failed: worker is closed");
                }
                return;
            }
            const payload = encodeChunkEnvelope(chunk);
            this.postMessageRaw(payload);
        };
        const encodeVectorizedChunks = (chunks: Uint8Array[]): Uint8Array => {
            let total = 0;
            for (const chunk of chunks) total += 4 + chunk.byteLength;
            const out = new Uint8Array(total);
            let off = 0;
            for (const chunk of chunks) {
                const len = chunk.byteLength >>> 0;
                out[off] = (len >>> 24) & 0xff;
                out[off + 1] = (len >>> 16) & 0xff;
                out[off + 2] = (len >>> 8) & 0xff;
                out[off + 3] = len & 0xff;
                off += 4;
                out.set(chunk, off);
                off += chunk.byteLength;
            }
            if (typeof Buffer !== "undefined") {
                return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
            }
            return out;
        };
        const postChunksFast = (chunks: Uint8Array[]): void => {
            if (chunks.length === 0) return;
            if (chunks.length === 1) {
                postChunkFast(chunks[0]);
                return;
            }
            if (canPostNativeChunksRaw && useRawStreamId !== null) {
                const ok = (this.native as any).postStreamChunksRaw(useRawStreamId, encodeVectorizedChunks(chunks));
                if (!ok) throw new Error("DenoWorker.postStreamChunksRaw failed: worker is closed");
                return;
            }
            // Coalesce when vectorized/raw path is unavailable.
            let total = 0;
            for (const chunk of chunks) total += chunk.byteLength;
            if (typeof Buffer !== "undefined") {
                postChunkFast(Buffer.concat(chunks, total));
                return;
            }
            const merged = new Uint8Array(total);
            let off = 0;
            for (const chunk of chunks) {
                merged.set(chunk, off);
                off += chunk.byteLength;
            }
            postChunkFast(merged);
        };
        const canUseFastChunkPosting =
            canPostNativeChunkRawBin || canPostNativeChunkRaw || canPostNativeChunk || canPostTypedChunk;
        const streamV2 = STREAM_V2_ENABLED && canUseFastChunkPosting;
        let queuedFastChunks: Uint8Array[] = [];
        let queuedFastBytes = 0;
        let fastFlushQueued = false;
        let fastFlushError: unknown = null;
        let fastFlushCount = 0;
        let fastFlushChunks = 0;
        let fastFlushBytes = 0;
        let writerCreditWaits = 0;
        const flushFastChunks = (): void => {
            fastFlushQueued = false;
            if (queuedFastChunks.length === 0) {
                return;
            }
            const chunks = queuedFastChunks;
            queuedFastChunks = [];
            queuedFastBytes = 0;
            try {
                fastFlushCount += 1;
                fastFlushChunks += chunks.length;
                for (const c of chunks) fastFlushBytes += c.byteLength;
                postChunksFast(chunks);
            } catch (err) {
                fastFlushError = err;
            }
        };
        const scheduleFastFlush = (): void => {
            if (fastFlushQueued) return;
            fastFlushQueued = true;
            if (typeof setImmediate === "function") {
                setImmediate(() => {
                    flushFastChunks();
                });
                return;
            }
            queueMicrotask(() => {
                flushFastChunks();
            });
        };
        const queueFastChunk = (chunk: Uint8Array): void => {
            if (!streamV2) {
                postChunkFast(chunk);
                return;
            }
            if (fastFlushError) throw fastFlushError;
            queuedFastChunks.push(chunk);
            queuedFastBytes += chunk.byteLength;
            if (queuedFastChunks.length >= STREAM_V2_MAX_QUEUED_CHUNKS || queuedFastBytes >= STREAM_V2_MAX_QUEUED_BYTES) {
                flushFastChunks();
            }
            else scheduleFastFlush();
        };
        const shouldBatchFastChunk = (byteLength: number): boolean =>
            streamV2 && byteLength > 0 && byteLength <= STREAM_V2_BATCH_MAX_CHUNK_BYTES;
        const writeChunkWithCallbacks = (u8: Uint8Array, onDone: () => void, onError: (err: unknown) => void): void => {
            try {
                ensureOpen();
                const have = this.streamWriterCredits.get(id) || 0;
                const useTypedChunk = canUseFastChunkPosting && u8.byteLength >= STREAM_TYPED_CHUNK_MIN_BYTES;
                if (have >= u8.byteLength) {
                    this.consumeWriterCredit(id, u8.byteLength);
                    if (useTypedChunk) {
                        if (shouldBatchFastChunk(u8.byteLength)) queueFastChunk(u8);
                        else postChunkFast(u8);
                    } else {
                        const payload = encodeChunkEnvelope(u8);
                        this.postMessageRaw(payload);
                    }
                    onDone();
                    return;
                }
                writerCreditWaits += 1;
                this.waitForWriterCredit(id, u8.byteLength).then(
                    () => {
                        try {
                            this.consumeWriterCredit(id, u8.byteLength);
                            if (useTypedChunk) {
                                if (shouldBatchFastChunk(u8.byteLength)) queueFastChunk(u8);
                                else postChunkFast(u8);
                            } else {
                                const payload = encodeChunkEnvelope(u8);
                                this.postMessageRaw(payload);
                            }
                            onDone();
                        } catch (err) {
                            onError(err);
                        }
                    },
                    (err) => onError(err),
                );
            } catch (err) {
                onError(err);
            }
        };

        const writerApi: DenoWorkerStreamWriter & InternalStreamWriterFastPath = {
            __writeWithCallbacks: writeChunkWithCallbacks,
            getKey: () => finalKey,
            ready: (minBytes = 1) => {
                ensureOpen();
                const need = Math.max(1, Math.trunc(minBytes || 1));
                if ((this.streamWriterCredits.get(id) || 0) >= need) return Promise.resolve();
                return withHandledRejection((async () => {
                    await this.waitForWriterCredit(id, need);
                })());
            },
            write: (chunk: Uint8Array | ArrayBuffer) => {
                const u8 = toBinaryChunk(chunk);
                return withHandledRejection(new Promise<void>((resolve, reject) => {
                    writeChunkWithCallbacks(u8, resolve, reject);
                }));
            },
            writeMany: (chunks: Array<Uint8Array | ArrayBuffer>) =>
                withHandledRejection((async () => {
                    ensureOpen();
                    if (!Array.isArray(chunks) || chunks.length === 0) return 0;
                    const prepared: Uint8Array[] = [];
                    let totalBytes = 0;
                    for (const chunk of chunks) {
                        const u8 = toBinaryChunk(chunk);
                        prepared.push(u8);
                        totalBytes += u8.byteLength;
                    }
                    const useTypedForAll =
                        canUseFastChunkPosting &&
                        prepared.every((chunk) => chunk.byteLength >= STREAM_TYPED_CHUNK_MIN_BYTES);
                    if ((this.streamWriterCredits.get(id) || 0) >= totalBytes) {
                        this.consumeWriterCredit(id, totalBytes);
                        if (useTypedForAll) {
                            postChunksFast(prepared);
                        } else {
                            const payloads = prepared.map((chunk) => encodeChunkEnvelope(chunk));
                            await queuePayloads(payloads);
                        }
                        return prepared.length;
                    }
                    let sent = 0;
                    let batchBytes = 0;
                    let batch: Uint8Array[] = [];
                    for (const chunk of prepared) {
                        writerCreditWaits += 1;
                        await this.waitForWriterCredit(id, chunk.byteLength);
                        this.consumeWriterCredit(id, chunk.byteLength);
                        const useTypedChunk =
                            canUseFastChunkPosting && chunk.byteLength >= STREAM_TYPED_CHUNK_MIN_BYTES;
                        if (useTypedChunk) {
                            if (shouldBatchFastChunk(chunk.byteLength)) queueFastChunk(chunk);
                            else postChunkFast(chunk);
                        } else {
                            batch.push(encodeChunkEnvelope(chunk));
                            batchBytes += chunk.byteLength;
                        }
                        sent += 1;
                        if (batch.length >= 64) {
                            postRawBatch(batch);
                            batch = [];
                            batchBytes = 0;
                        }
                    }
                    if (batch.length > 0) {
                        postRawBatch(batch);
                    }
                    return sent;
                })()),
            close: () =>
                withHandledRejection((async () => {
                    if (done) return;
                    done = true;
                    flushQueuedWrites();
                    flushFastChunks();
                    this.flushCreditFrames();
                    if (STREAM_V2_STATS_DEBUG) {
                        try {
                            // eslint-disable-next-line no-console
                            console.log(
                                `[streamV2stats] key=${finalKey} flushes=${fastFlushCount} chunks=${fastFlushChunks} bytes=${fastFlushBytes} creditWaits=${writerCreditWaits}`,
                            );
                        } catch {
                            // ignore
                        }
                    }
                    try {
                        this.emitStreamFrame({ t: "close", id });
                    } catch {
                        // ignore during close race
                    }
                    this.markRemoteDiscard(id);
                    this.markLocalDiscard(id);
                    rejectWriterWaiters(`Stream closed: ${finalKey}`);
                })()),
            error: (message: string) =>
                withHandledRejection((async () => {
                    if (done) return;
                    done = true;
                    flushQueuedWrites();
                    flushFastChunks();
                    this.emitStreamFrame({ t: "error", id, error: String(message || "stream error") });
                    this.markRemoteDiscard(id);
                    this.markLocalDiscard(id);
                    rejectWriterWaiters(`Stream errored: ${finalKey}`);
                })()),
            cancel: (reason?: string) =>
                withHandledRejection((async () => {
                    if (done) return;
                    done = true;
                    flushQueuedWrites();
                    flushFastChunks();
                    this.emitStreamFrame({ t: "cancel", id, reason });
                    this.markRemoteDiscard(id);
                    this.markLocalDiscard(id);
                    rejectWriterWaiters(`Stream cancelled: ${finalKey}`);
                })()),
        };
        return writerApi;
    }

    /** Waits for an incoming stream reader for the provided key (or returns queued backlog immediately). */
    private async streamAccept(key: string): Promise<DenoWorkerStreamReader> {
        const streamName = String(key || "").trim();
        if (!streamName) {
            throw new Error("stream.accept(key) requires a non-empty key");
        }
        if (this.isClosed()) {
            throw new Error("Cannot accept stream on a closed worker");
        }
        if (this.streamPendingAccepts.has(streamName)) {
            throw new Error(`stream.accept already pending for stream key: ${streamName}`);
        }
        const activeId = this.streamNameToId.get(streamName);
        if (activeId && !this.streamBacklog.has(streamName)) {
            throw new Error(`Stream key already in use: ${streamName}`);
        }

        const queued = this.streamBacklog.get(streamName);
        if (queued) {
            this.streamBacklog.delete(streamName);
            return queued;
        }

        return await new Promise<DenoWorkerStreamReader>((resolve, reject) => {
            this.streamPendingAccepts.set(streamName, { resolve, reject });
        });
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
     * Actual inspector port bound by the runtime.
     *
     * Returns `undefined` when inspector is disabled or not bound.
     */
    get inspectPort(): number | undefined {
        const v: any = (this.native as any).inspectPort;
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
            return Math.trunc(v);
        }
        return undefined;
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
            this.invalidateHandles();
        }

        if (force) {
            const oldNative = this.native;
            this.nativeEpoch += 1;
            this.failAllStreams("DenoWorker force-closed");
            this.rejectInFlight(new Error("DenoWorker force-closed"));
            this.closed = true;
            try {
                oldNative.forceDispose?.();
            } catch {
                // ignore
            }

            this.closePromise = Promise.resolve().then(() => {
                this.emitCloseHandlersIfNeeded();
                this.invokeHook("afterStop", { requested: true });
            });

            // Force-close is immediate for wrapper callers, but still wait a bounded
            // amount for native teardown so Neon thread-safe handles do not linger.
            const nativeCloseAttempt = Promise.race([
                oldNative.close().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 1500)),
            ]);
            await Promise.all([this.closePromise, nativeCloseAttempt]);
            try {
                if (oldNative.__isRegistered?.()) oldNative.forceDispose?.();
            } catch {
                // ignore
            }
            return;
        }

        this.closePromise = this.native
            .close()
            .then(() => {
                this.closed = true;
                this.failAllStreams("DenoWorker closed");
                this.emitCloseHandlersIfNeeded();
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
        try {
            if (this.native.__isRegistered?.()) this.native.forceDispose?.();
        } catch {
            // ignore
        }
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
        this.closeNotified = false;
        this.invalidateHandles();

        this.invokeHook("beforeStart", { options: this.creationOptions });
        this.native = this.createNative(true);
        this.nativeEpoch += 1;
        this.bindNativeEvents(this.native, this.nativeEpoch);
        this.initializeStartup(this.creationOptions?.globals, this.creationOptions?.modules);
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

    /** Runs a callback with a temporary handle rooted at `globalThis` and always disposes it. */
    private async withGlobalRootHandle<T>(
        options: DenoWorkerHandleExecOptions | undefined,
        fn: (handle: DenoWorkerHandle) => Promise<T>,
    ): Promise<T> {
        await this.startupPromise;
        const handle = await this.handleGet("globalThis", options);
        try {
            return await fn(handle);
        } finally {
            await handle.dispose(options).catch(() => undefined);
        }
    }

    /** Runs a callback with a temporary handle rooted at `path` and always disposes it. */
    private async withGlobalPathHandle<T>(
        path: string,
        options: DenoWorkerHandleExecOptions | undefined,
        fn: (handle: DenoWorkerHandle) => Promise<T>,
    ): Promise<T> {
        await this.startupPromise;
        const handle = await this.handleGet(path, options);
        try {
            return await fn(handle);
        } finally {
            await handle.dispose(options).catch(() => undefined);
        }
    }

    /** Sets a global value by path rooted at `globalThis` (`a.b.c` dot notation). */
    private async globalSet(path: string, value: any, options?: DenoWorkerHandleExecOptions): Promise<void> {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("global.set(path, value) requires a non-empty path");
        if (!options && !p.includes(".")) {
            await this.startupPromise;
            await this.setGlobalInternal(p, value);
            return;
        }
        await this.withGlobalRootHandle(options, async (handle) => {
            await handle.set(p, value, options);
        });
    }

    /** Reads a global value by path rooted at `globalThis` (`a.b.c` dot notation). */
    private async globalGet<T = any>(path: string, options?: DenoWorkerHandleExecOptions): Promise<T> {
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.get<T>("", options));
    }

    /** Returns true when a global path exists (`a.b.c` dot notation). */
    private async globalHas(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.has(path, options));
    }

    /** Deletes a global path (`a.b.c` dot notation). */
    private async globalDelete(path: string, options?: DenoWorkerHandleExecOptions): Promise<boolean> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.delete(path, options));
    }

    /** Returns keys for `globalThis` root or nested global path. */
    private async globalKeys(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.keys(path ?? "", options));
    }

    /** Returns entries for `globalThis` root or nested global path. */
    private async globalEntries(path?: string, options?: DenoWorkerHandleExecOptions): Promise<any[]> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.entries(path ?? "", options));
    }

    /** Returns an own-property descriptor for a global path (`a.b.c` dot notation). */
    private async globalGetOwnPropertyDescriptor(
        path: string,
        options?: DenoWorkerHandleExecOptions,
    ): Promise<PropertyDescriptor | undefined> {
        return await this.withGlobalRootHandle(
            options,
            async (handle) => await handle.getOwnPropertyDescriptor(path, options),
        );
    }

    /** Defines a global property via descriptor semantics (`a.b.c` dot notation). */
    private async globalDefine(
        path: string,
        descriptor: PropertyDescriptor,
        options?: DenoWorkerHandleExecOptions,
    ): Promise<boolean> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.define(path, descriptor, options));
    }

    /** Returns true when a global path value is callable. */
    private async globalIsCallable(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.isCallable(path ?? "", options));
    }

    /** Returns true when a global path value is promise-like. */
    private async globalIsPromise(path?: string, options?: DenoWorkerHandleExecOptions): Promise<boolean> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.isPromise(path ?? "", options));
    }

    /** Calls a global function by path rooted at `globalThis` (`a.b.c` dot notation). */
    private async globalCall<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T> {
        const callArgs = Array.isArray(args) ? args : [];
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.call<T>(callArgs, options));
    }

    /** Constructs a global constructor by path rooted at `globalThis` (`a.b.c` dot notation). */
    private async globalConstruct<T = any>(path: string, args?: any[], options?: DenoWorkerHandleExecOptions): Promise<T> {
        const ctorArgs = Array.isArray(args) ? args : [];
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.construct<T>(ctorArgs, options));
    }

    /** Awaits a global promise-like value by path rooted at `globalThis` (`a.b.c` dot notation). */
    private async globalAwait<T = any>(
        path: string,
        options?: DenoWorkerHandleAwaitOptions & DenoWorkerHandleExecOptions,
    ): Promise<T> {
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.await<T>(options));
    }

    /** Clones a global value path into a durable runtime handle. */
    private async globalClone(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle> {
        await this.startupPromise;
        return await this.handleGet(path, options);
    }

    /** Returns a JSON snapshot for `globalThis` root or nested global path. */
    private async globalToJSON<T = any>(path?: string, options?: DenoWorkerHandleExecOptions): Promise<T> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.toJSON<T>(path ?? "", options));
    }

    /** Applies a sequence of handle operations against a global path root in one roundtrip. */
    private async globalApply<T = any[]>(
        path: string,
        ops: DenoWorkerHandleApplyOp[],
        options?: DenoWorkerHandleExecOptions,
    ): Promise<T> {
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.apply<T>(ops, options));
    }

    /** Returns type metadata for `globalThis` root or nested global path. */
    private async globalGetType(path?: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandleTypeInfo> {
        return await this.withGlobalRootHandle(options, async (handle) => await handle.getType(path ?? "", options));
    }

    /** Checks whether a global value is `instanceof` a constructor path rooted at `globalThis`. */
    private async globalInstanceOf(
        path: string,
        constructorPath: string,
        options?: DenoWorkerHandleExecOptions,
    ): Promise<boolean> {
        return await this.withGlobalPathHandle(path, options, async (handle) => await handle.instanceOf(constructorPath, options));
    }

    /** Creates a handle rooted at an existing runtime path (throws when path is absent). */
    private async handleGet(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle> {
        const p = String(path ?? "").trim();
        if (!p) throw new Error("handle.get(path) requires a non-empty path");
        this.ensureHandleCapacity();
        const id = this.nextHandleId();
        const opId = `handle.create:${id}`;
        this.emitRuntimeEvent({ kind: "handle.create", opId, handleId: id, source: "path", path: p });
        const defaultExecOptions: Omit<EvalOptions, "args" | "type"> | undefined =
            typeof options?.maxEvalMs === "number" || typeof options?.maxCpuMs === "number"
                ? {
                    ...(typeof options?.maxEvalMs === "number" ? { maxEvalMs: options.maxEvalMs } : {}),
                    ...(typeof options?.maxCpuMs === "number" ? { maxCpuMs: options.maxCpuMs } : {}),
                }
                : undefined;
        try {
            await this.runHandleOp({ op: "createFromPath", id, path: p }, defaultExecOptions);
        } catch (e) {
            this.emitThrownError(opId, "handle.create", e);
            throw e;
        }
        const rootType = (await this.runHandleOp({ op: "getType", id, path: "" }, defaultExecOptions)) as DenoWorkerHandleTypeInfo;
        this.activeHandleIds.add(id);
        return this.createHandle(id, this.handleGeneration, rootType, defaultExecOptions);
    }

    /** Creates a handle for an existing runtime path and returns `undefined` when path is missing. */
    private async handleTryGet(path: string, options?: DenoWorkerHandleExecOptions): Promise<DenoWorkerHandle | undefined> {
        try {
            return await this.handleGet(path, options);
        } catch (e) {
            const code = String((e as any)?.code ?? "");
            if (code === "HANDLE_PATH_NOT_FOUND") return undefined;
            throw e;
        }
    }

    /** Creates a new runtime handle by evaluating source and using its result as handle root. */
    private async handleEval(source: string, options?: Omit<EvalOptions, "args" | "type">): Promise<DenoWorkerHandle> {
        const src = String(source ?? "");
        if (!src.trim()) throw new Error("handle.eval(source) requires non-empty source");
        this.ensureHandleCapacity();
        const id = this.nextHandleId();
        const opId = `handle.create:${id}`;
        this.emitRuntimeEvent({ kind: "handle.create", opId, handleId: id, source: "eval" });
        const defaultExecOptions: Omit<EvalOptions, "args" | "type"> | undefined =
            options &&
            (typeof options.maxEvalMs === "number" ||
                typeof options.maxCpuMs === "number" ||
                typeof options.filename === "string")
                ? {
                    ...(typeof options.maxEvalMs === "number" ? { maxEvalMs: options.maxEvalMs } : {}),
                    ...(typeof options.maxCpuMs === "number" ? { maxCpuMs: options.maxCpuMs } : {}),
                    ...(typeof options.filename === "string" ? { filename: options.filename } : {}),
                }
                : undefined;
        try {
            await this.runHandleOp({ op: "createFromEval", id, source: src }, defaultExecOptions);
        } catch (e) {
            this.emitThrownError(opId, "handle.create", e);
            throw e;
        }
        const rootType = (await this.runHandleOp({ op: "getType", id, path: "" }, defaultExecOptions)) as DenoWorkerHandleTypeInfo;
        this.activeHandleIds.add(id);
        return this.createHandle(id, this.handleGeneration, rootType, defaultExecOptions);
    }

    /**
     * Evaluate script source in the runtime.
     *
     * If evaluated source resolves to a Promise, this method waits until fulfillment/rejection.
     */
    eval<T = any>(src: string, options?: EvalOptions): Promise<T> {
        const opId = `eval:${randomUUID()}`;
        this.emitRuntimeEvent({
            kind: "eval.begin",
            opId,
            args: Array.isArray(options?.args) ? options?.args : [],
        });
        const op = (async () => {
            if (!this.startupReady) {
                await this.startupPromise;
            } else if (this.startupError) {
                this.emitRuntimeEvent({ kind: "eval.end", opId, ok: false });
                throw this.startupError;
            }
            try {
                const raw = await this.trackInFlight(this.native.eval(src, normalizeEvalOptions(options)));
                this.emitRuntimeEvent({ kind: "eval.end", opId, ok: true });
                return hydrateFromWire(raw) as T;
            } catch (e) {
                const hydrated = hydrateFromWire(e);
                this.emitRuntimeEvent({ kind: "eval.end", opId, ok: false });
                this.emitThrownError(opId, "eval", hydrated);
                throw hydrated;
            }
        })();
        // Keep rejection semantics unchanged for callers while preventing
        // transient "unhandled rejection" races when handlers are attached later.
        void op.catch(() => undefined);
        return op;
    }

    /**
     * Synchronous script evaluation in the runtime.
     *
     * Throws while constructor globals are still initializing.
     */
    evalSync<T = any>(src: string, options?: EvalOptions): T {
        const opId = `evalSync:${randomUUID()}`;
        this.emitRuntimeEvent({
            kind: "evalSync.begin",
            opId,
            args: Array.isArray(options?.args) ? options?.args : [],
        });
        if (!this.startupReady) {
            this.emitRuntimeEvent({ kind: "evalSync.end", opId, ok: false });
            throw new Error(
                "DenoWorker.evalSync cannot run while constructor globals are still initializing; use eval(...) or await startup completion",
            );
        }
        if (this.startupError) {
            this.emitRuntimeEvent({ kind: "evalSync.end", opId, ok: false });
            throw this.startupError;
        }
        try {
            const raw = this.native.evalSync(src, normalizeEvalOptions(options));
            this.emitRuntimeEvent({ kind: "evalSync.end", opId, ok: true });
            return hydrateFromWire(raw) as T;
        } catch (e) {
            const hydrated = hydrateFromWire(e);
            this.emitRuntimeEvent({ kind: "evalSync.end", opId, ok: false });
            this.emitThrownError(opId, "evalSync", hydrated);
            throw hydrated;
        }
    }

    private async moduleApiEval<T extends Record<string, any> = Record<string, any>>(
        source: string,
        options?: DenoWorkerModuleEvalOptions,
    ): Promise<T> {
        await this.startupPromise;
        const moduleName = typeof options?.moduleName === "string" ? options.moduleName.trim() : "";
        if (moduleName) {
            await this.registerModuleInternal(moduleName, source);
            return this.moduleApiImport<T>(moduleName);
        }

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

    /** Module API entrypoint: register module source under a stable module name. */
    private async moduleApiRegister(moduleName: string, source: string): Promise<void> {
        await this.startupPromise;
        await this.registerModuleInternal(moduleName, source);
    }

    /** Module API entrypoint: clear a previously registered module by name. */
    private async moduleApiClear(moduleName: string): Promise<boolean> {
        await this.startupPromise;
        return await this.clearModuleInternal(moduleName);
    }

    /**
     * Import a module specifier and return a callable namespace proxy.
     *
     * This routes through the runtime's normal import resolution pipeline
     * (including imports callbacks and permission policy).
     */
    private async moduleApiImport<T extends Record<string, any> = Record<string, any>>(specifier: string): Promise<T> {
        await this.startupPromise;
        const spec = String(specifier);
        const permissions = this.creationOptions?.permissions;
        if (permissions && typeof permissions === "object" && permissions.wasm === false && this.isWasmSpecifier(spec)) {
            throw new Error(`WASM module loading is disabled by permissions.wasm: ${spec}`);
        }

        const source = buildImportModuleSource(spec);

        const raw = await this.eval(source);
        return wrapModuleNamespace<T>(this, raw);
    }

    private isWasmSpecifier(specifier: string): boolean {
        try {
            const parsed = new URL(specifier);
            return parsed.pathname.toLowerCase().endsWith(".wasm");
        } catch {
            const base = specifier.split("#")[0] ?? specifier;
            const pathOnly = base.split("?")[0] ?? base;
            return pathOnly.toLowerCase().endsWith(".wasm");
        }
    }
}

export default DenoWorker;
