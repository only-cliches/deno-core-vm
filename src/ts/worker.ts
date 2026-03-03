/* eslint-disable @typescript-eslint/no-explicit-any */

import { randomBytes, randomUUID } from "node:crypto";
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
    DenoWorkerStreamApi,
    DenoWorkerStreamReader,
    DenoWorkerStreamWriter,
    EvalOptions,
    ExecStats,
    NativeWorker,
} from "./types";

const STREAM_BRIDGE_TAG = "__denojs_worker_stream_v1";
const STREAM_CHUNK_MAGIC = [0x44, 0x44, 0x53, 0x54, 0x52, 0x4d, 0x31, 0x00] as const;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const STREAM_FRAME_TYPE_TO_CODE: Record<StreamFrameType, number> = {
    open: 1,
    chunk: 2,
    close: 3,
    error: 4,
    cancel: 5,
    discard: 6,
    credit: 7,
};
const STREAM_FRAME_CODE_TO_TYPE: Record<number, StreamFrameType> = {
    1: "open",
    2: "chunk",
    3: "close",
    4: "error",
    5: "cancel",
    6: "discard",
    7: "credit",
};

// Default stream flow-control window (16 MiB): balanced for high throughput
// without unbounded in-flight memory per stream.
const STREAM_DEFAULT_WINDOW_BYTES = 16 * 1024 * 1024;
// Default credit flush threshold (256 KiB): avoids chatty credit updates while
// keeping writers responsive under sustained transfer.
const STREAM_CREDIT_FLUSH_THRESHOLD = 256 * 1024;

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

function isStreamFrame(v: unknown): v is StreamFrame {
    if (!v || typeof v !== "object") return false;
    const obj = v as Record<string, unknown>;
    return obj[STREAM_BRIDGE_TAG] === true && typeof obj.id === "string" && typeof obj.t === "string";
}

function toBinaryChunk(chunk: Uint8Array | ArrayBuffer): Uint8Array {
    if (chunk instanceof Uint8Array) {
        if (typeof Buffer !== "undefined" && !Buffer.isBuffer(chunk)) {
            return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
        return chunk;
    }
    const u8 = new Uint8Array(chunk);
    if (typeof Buffer !== "undefined") {
        return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    }
    return u8;
}

function asUint8View(value: unknown): Uint8Array | null {
    if (typeof Uint8Array === "undefined") return null;
    if (value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (
        typeof ArrayBuffer !== "undefined" &&
        typeof ArrayBuffer.isView === "function" &&
        ArrayBuffer.isView(value)
    ) {
        const v = value as ArrayBufferView;
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    return null;
}

function encodeStreamFrameEnvelope(frame: Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>): Uint8Array {
    const typeCode = STREAM_FRAME_TYPE_TO_CODE[frame.t];
    if (!typeCode) {
        throw new Error(`Unknown stream frame type: ${String((frame as any).t)}`);
    }

    const idBytes = textEncoder.encode(frame.id);
    if (idBytes.byteLength === 0 || idBytes.byteLength > 0xffff) {
        throw new Error(`Invalid stream id length: ${idBytes.byteLength}`);
    }

    const auxText =
        frame.t === "open"
            ? (frame.key ?? "")
            : frame.t === "error"
                ? (frame.error ?? "")
                : frame.t === "cancel"
                    ? (frame.reason ?? "")
                    : frame.t === "credit"
                        ? String(Math.max(0, Math.trunc(frame.credit ?? 0)))
                    : "";
    const auxBytes = textEncoder.encode(auxText);
    if (auxBytes.byteLength > 0xffff) {
        throw new Error(`Invalid stream aux length: ${auxBytes.byteLength}`);
    }

    const chunk =
        frame.t === "chunk" && frame.chunk instanceof Uint8Array
            ? frame.chunk
            : new Uint8Array(0);
    const out = new Uint8Array(
        STREAM_CHUNK_MAGIC.length + 1 + 2 + 2 + idBytes.byteLength + auxBytes.byteLength + chunk.byteLength,
    );
    out.set(STREAM_CHUNK_MAGIC, 0);
    let off = STREAM_CHUNK_MAGIC.length;
    out[off] = typeCode & 0xff;
    off += 1;
    out[off] = (idBytes.byteLength >>> 8) & 0xff;
    out[off + 1] = idBytes.byteLength & 0xff;
    off += 2;
    out[off] = (auxBytes.byteLength >>> 8) & 0xff;
    out[off + 1] = auxBytes.byteLength & 0xff;
    off += 2;
    out.set(idBytes, off);
    off += idBytes.byteLength;
    out.set(auxBytes, off);
    off += auxBytes.byteLength;
    out.set(chunk, off);
    if (typeof Buffer !== "undefined") {
        return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    }
    return out;
}

function decodeStreamFrameEnvelope(payload: unknown): StreamFrame | null {
    const u8 = asUint8View(payload);
    if (!u8) return null;
    const minLen = STREAM_CHUNK_MAGIC.length + 1 + 2 + 2 + 1;
    if (u8.byteLength < minLen) return null;

    for (let i = 0; i < STREAM_CHUNK_MAGIC.length; i += 1) {
        if (u8[i] !== STREAM_CHUNK_MAGIC[i]) return null;
    }

    let off = STREAM_CHUNK_MAGIC.length;
    const typeCode = u8[off] >>> 0;
    off += 1;
    const t = STREAM_FRAME_CODE_TO_TYPE[typeCode];
    if (!t) return null;

    const idLen = ((u8[off] << 8) | u8[off + 1]) >>> 0;
    off += 2;
    const auxLen = ((u8[off] << 8) | u8[off + 1]) >>> 0;
    off += 2;
    if (idLen === 0) return null;
    if (off + idLen + auxLen > u8.byteLength) return null;

    const id = textDecoder.decode(u8.subarray(off, off + idLen));
    if (!id) return null;
    off += idLen;
    const auxText = auxLen > 0 ? textDecoder.decode(u8.subarray(off, off + auxLen)) : "";
    off += auxLen;

    const frame: StreamFrame = {
        [STREAM_BRIDGE_TAG]: true,
        t,
        id,
    };
    if (t === "open" && auxText) frame.key = auxText;
    else if (t === "error" && auxText) frame.error = auxText;
    else if (t === "cancel" && auxText) frame.reason = auxText;
    else if (t === "credit") frame.credit = Number(auxText || "0");
    else if (t === "chunk") frame.chunk = u8.subarray(off);
    return frame;
}

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

    setRemoteCancel(fn: (reason?: string) => void): void {
        this.remoteCancel = fn;
    }

    setOnLocalDiscard(fn: () => void): void {
        this.onLocalDiscard = fn;
    }

    setOnChunkConsumed(fn: (bytes: number) => void): void {
        this.onChunkConsumed = fn;
    }

    private markLocalDiscarded(): void {
        if (this.discarded) return;
        this.discarded = true;
        try {
            this.onLocalDiscard?.();
        } catch {
            // ignore
        }
    }

    pushChunk(chunk: Uint8Array): void {
        if (this.closed || this.done) return;
        this.pushEvent({ kind: "chunk", chunk });
    }

    closeRemote(): void {
        if (this.closed) return;
        this.closed = true;
        this.markLocalDiscarded();
        this.pushEvent({ kind: "close" });
    }

    errorRemote(error: unknown): void {
        if (this.closed) return;
        this.closed = true;
        this.markLocalDiscarded();
        this.pushEvent({ kind: "error", error });
    }

    private pushEvent(ev: StreamReadEvent): void {
        if (this.waiting.length > 0) {
            const next = this.waiting.shift()!;
            if (ev.kind === "chunk") {
                next.resolve({ done: false, value: ev.chunk });
                try {
                    this.onChunkConsumed?.(ev.chunk.byteLength);
                } catch {
                    // ignore
                }
            }
            else if (ev.kind === "close") next.resolve({ done: true, value: undefined as any });
            else next.reject(ev.error);
            return;
        }
        this.queue.push(ev);
    }

    async read(): Promise<IteratorResult<Uint8Array>> {
        if (this.done) return { done: true, value: undefined as any };
        if (this.queue.length > 0) {
            const ev = this.queue.shift()!;
            if (ev.kind === "chunk") {
                try {
                    this.onChunkConsumed?.(ev.chunk.byteLength);
                } catch {
                    // ignore
                }
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
    private readonly inFlightRejectors = new Set<(reason: unknown) => void>();
    private nativeEpoch = 0;
    private startupPromise: Promise<void> = Promise.resolve();
    private startupReady = true;
    private startupError: unknown = null;
    private streamCounter = 0;
    private readonly streamIncoming = new Map<string, StreamReaderImpl>();
    private readonly streamById = new Map<
        string,
        { name: string; localDiscarded: boolean; remoteDiscarded: boolean }
    >();
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
    private streamCreditFlushQueued = false;
    private readonly streamWindowBytes: number;
    private readonly streamCreditFlushBytes: number;
    readonly stream: DenoWorkerStreamApi = {
        create: (key?: string) => this.streamCreate(key),
        accept: (key: string) => this.streamAccept(key),
    };

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
            const frame = decodeStreamFrameEnvelope(msg);
            if (frame && this.handleIncomingStreamFrame(frame)) return;
            if (this.handleIncomingStreamFrame(msg)) return;
            const hydrated = hydrateFromWire(msg);
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
            this.failAllStreams("DenoWorker closed unexpectedly");
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

    private nextStreamId(prefix: "n" | "w" = "n"): string {
        this.streamCounter += 1;
        return `${prefix}:${this.nativeEpoch}:${this.streamCounter}`;
    }

    private emitStreamFrame(frame: Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>): void {
        this.postMessageRaw(encodeStreamFrameEnvelope(frame));
    }

    private emitStreamFrames(frames: Array<Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>>): void {
        if (frames.length === 0) return;
        const raw = frames.map((f) => encodeStreamFrameEnvelope(f));
        if (typeof (this.native as any).postMessages === "function") {
            const sent = (this.native as any).postMessages(raw);
            if (sent !== raw.length) {
                throw new Error("DenoWorker.postMessages dropped: worker queue full or closed");
            }
            return;
        }
        for (const frame of raw) this.postMessageRaw(frame);
    }

    private queueCreditFrame(id: string, bytes: number): void {
        if (!Number.isFinite(bytes) || bytes <= 0) return;
        const prev = this.pendingCreditFrames.get(id) || 0;
        this.pendingCreditFrames.set(id, prev + Math.trunc(bytes));
        if (prev + bytes >= this.streamCreditFlushBytes) {
            this.flushCreditFrames();
            return;
        }
        if (this.streamCreditFlushQueued) return;
        this.streamCreditFlushQueued = true;
        queueMicrotask(() => {
            this.streamCreditFlushQueued = false;
            this.flushCreditFrames();
        });
    }

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

    private consumeWriterCredit(id: string, amount: number): void {
        const have = this.streamWriterCredits.get(id) || 0;
        const next = have - amount;
        this.streamWriterCredits.set(id, next > 0 ? next : 0);
    }

    private waitForWriterCredit(id: string, minBytes: number): Promise<void> {
        if ((this.streamWriterCredits.get(id) || 0) >= minBytes) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const arr = this.streamWriterWaiters.get(id) || [];
            arr.push({ minBytes, resolve, reject });
            this.streamWriterWaiters.set(id, arr);
        });
    }

    private registerStream(name: string, id: string): void {
        if (this.streamById.has(id)) {
            throw new Error(`Duplicate stream id: ${id}`);
        }
        if (this.streamNameToId.has(name)) {
            throw new Error(`Stream key already in use: ${name}`);
        }
        this.streamById.set(id, { name, localDiscarded: false, remoteDiscarded: false });
        this.streamNameToId.set(name, id);
    }

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

    private markRemoteDiscard(id: string): void {
        const meta = this.streamById.get(id);
        if (!meta || meta.remoteDiscarded) return;
        meta.remoteDiscarded = true;
        this.tryReleaseStream(id);
    }

    private tryReleaseStream(id: string): void {
        const meta = this.streamById.get(id);
        if (!meta) return;
        if (!meta.localDiscarded || !meta.remoteDiscarded) return;
        this.streamById.delete(id);
        this.streamIncoming.delete(id);
        this.pendingCreditFrames.delete(id);
        this.streamWriterCredits.delete(id);
        const waiters = this.streamWriterWaiters.get(id);
        if (waiters && waiters.length > 0) {
            for (const waiter of waiters) waiter.reject(new Error("stream released"));
        }
        this.streamWriterWaiters.delete(id);
        const current = this.streamNameToId.get(meta.name);
        if (current === id) this.streamNameToId.delete(meta.name);
    }

    private rejectIncomingOpen(id: string, name: string, reason: string): void {
        this.emitStreamFrame({ t: "error", id, error: reason });
        this.emitStreamFrame({ t: "discard", id });
    }

    private queueAcceptedStream(name: string, reader: DenoWorkerStreamReader): void {
        const waiter = this.streamPendingAccepts.get(name);
        if (waiter) {
            this.streamPendingAccepts.delete(name);
            waiter.resolve(reader);
            return;
        }
        this.streamBacklog.set(name, reader);
    }

    private handleIncomingStreamFrame(payload: unknown): boolean {
        if (!isStreamFrame(payload)) return false;
        const frame = payload;

        switch (frame.t) {
            case "open": {
                const key = typeof frame.key === "string" && frame.key ? frame.key : frame.id;
                if (this.streamNameToId.has(key) || this.streamBacklog.has(key)) {
                    this.rejectIncomingOpen(frame.id, key, `Stream key already in use: ${key}`);
                    return true;
                }
                this.registerStream(key, frame.id);
                const reader = new StreamReaderImpl();
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
                return true;
            }
            case "chunk": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) return true;
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
                if (!target) return true;
                target.closeRemote();
                return true;
            }
            case "error": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) return true;
                target.errorRemote(new Error(frame.error || "Remote stream error"));
                return true;
            }
            case "cancel": {
                const target = this.streamIncoming.get(frame.id);
                if (!target) return true;
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

    private failAllStreams(reason: string): void {
        for (const reader of this.streamIncoming.values()) {
            reader.errorRemote(new Error(reason));
        }
        this.streamIncoming.clear();
        this.streamById.clear();
        this.streamNameToId.clear();
        this.streamBacklog.clear();
        this.pendingCreditFrames.clear();
        this.streamWriterCredits.clear();
        for (const waiters of this.streamWriterWaiters.values()) {
            for (const waiter of waiters) waiter.reject(new Error(reason));
        }
        this.streamWriterWaiters.clear();

        for (const waiter of this.streamPendingAccepts.values()) {
            waiter.reject(new Error(reason));
        }
        this.streamPendingAccepts.clear();
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
        const rawBridge: any = options && typeof options === "object" ? (options as any).bridge : undefined;
        const parsedWindow = Number(rawBridge?.streamWindowBytes);
        const parsedFlush = Number(rawBridge?.streamCreditFlushBytes);
        this.streamWindowBytes =
            Number.isFinite(parsedWindow) && parsedWindow >= 1
                ? Math.trunc(parsedWindow)
                : STREAM_DEFAULT_WINDOW_BYTES;
        this.streamCreditFlushBytes =
            Number.isFinite(parsedFlush) && parsedFlush >= 1
                ? Math.trunc(parsedFlush)
                : STREAM_CREDIT_FLUSH_THRESHOLD;
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
        const payload =
            typeof Buffer !== "undefined" && Buffer.isBuffer(msg) ? msg : dehydrateForWire(msg);
        this.postMessageRaw(payload);
    }

    private postMessageRaw(msg: any): void {
        if (this.isClosed()) {
            throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
        }
        const ok = this.native.postMessage(msg);
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
        this.registerStream(finalKey, id);
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

        return {
            getKey: () => finalKey,
            ready: async (minBytes = 1) => {
                ensureOpen();
                const need = Math.max(1, Math.trunc(minBytes || 1));
                await this.waitForWriterCredit(id, need);
            },
            write: async (chunk: Uint8Array | ArrayBuffer) => {
                ensureOpen();
                const u8 = toBinaryChunk(chunk);
                await this.waitForWriterCredit(id, u8.byteLength);
                this.emitStreamFrame({
                    t: "chunk",
                    id,
                    chunk: u8,
                });
                this.consumeWriterCredit(id, u8.byteLength);
            },
            writeMany: async (chunks: Array<Uint8Array | ArrayBuffer>) => {
                ensureOpen();
                if (!Array.isArray(chunks) || chunks.length === 0) return 0;
                const prepared: Uint8Array[] = [];
                for (const chunk of chunks) {
                    const u8 = toBinaryChunk(chunk);
                    prepared.push(u8);
                }
                let sent = 0;
                let batchBytes = 0;
                let batch: Array<Omit<StreamFrame, typeof STREAM_BRIDGE_TAG>> = [];
                for (const chunk of prepared) {
                    await this.waitForWriterCredit(id, chunk.byteLength);
                    batch.push({ t: "chunk", id, chunk });
                    batchBytes += chunk.byteLength;
                    sent += 1;
                    if (batch.length >= 64) {
                        this.emitStreamFrames(batch);
                        this.consumeWriterCredit(id, batchBytes);
                        batch = [];
                        batchBytes = 0;
                    }
                }
                if (batch.length > 0) {
                    this.emitStreamFrames(batch);
                    this.consumeWriterCredit(id, batchBytes);
                }
                return sent;
            },
            close: async () => {
                if (done) return;
                done = true;
                try {
                    this.emitStreamFrame({ t: "close", id });
                } catch {
                    // ignore during close race
                }
                this.markRemoteDiscard(id);
                this.markLocalDiscard(id);
                rejectWriterWaiters(`Stream closed: ${finalKey}`);
            },
            error: async (message: string) => {
                if (done) return;
                done = true;
                this.emitStreamFrame({ t: "error", id, error: String(message || "stream error") });
                this.markRemoteDiscard(id);
                this.markLocalDiscard(id);
                rejectWriterWaiters(`Stream errored: ${finalKey}`);
            },
            cancel: async (reason?: string) => {
                if (done) return;
                done = true;
                this.emitStreamFrame({ t: "cancel", id, reason });
                this.markRemoteDiscard(id);
                this.markLocalDiscard(id);
                rejectWriterWaiters(`Stream cancelled: ${finalKey}`);
            },
        };
    }

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
        }

        if (force) {
            const oldNative = this.native;
            this.nativeEpoch += 1;
            this.failAllStreams("DenoWorker force-closed");
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
                this.failAllStreams("DenoWorker closed");
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

    /**
     * Import a module specifier and return a callable namespace proxy.
     *
     * This routes through the runtime's normal import resolution pipeline
     * (including imports callbacks and permission policy).
     */
    async getModule<T extends Record<string, any> = Record<string, any>>(specifier: string): Promise<T> {
        await this.startupPromise;

        const specJson = JSON.stringify(String(specifier));
        const source = `(async () => {
            const spec = ${specJson};
            const m = await import(spec);
            const o = Object.create(null);
            const moduleFnKeys = [];
            const moduleAsyncFnKeys = [];
            o.__denojs_worker_module_spec = spec;

            for (const k of Object.keys(m)) {
                const v = m[k];
                if (typeof v === "function") {
                    const isAsync = Object.prototype.toString.call(v) === "[object AsyncFunction]";
                    o[k] = { __denojs_worker_type: "module_fn", spec, name: k, async: isAsync };
                    moduleFnKeys.push(k);
                    if (isAsync) moduleAsyncFnKeys.push(k);
                } else {
                    o[k] = v;
                }
            }

            if ("default" in m) {
                const dv = m.default;
                if (typeof dv === "function") {
                    const isDefaultAsync = Object.prototype.toString.call(dv) === "[object AsyncFunction]";
                    o.default = { __denojs_worker_type: "module_fn", spec, name: "default", async: isDefaultAsync };
                    if (!moduleFnKeys.includes("default")) moduleFnKeys.push("default");
                    if (isDefaultAsync && !moduleAsyncFnKeys.includes("default")) moduleAsyncFnKeys.push("default");
                } else {
                    o.default = dv;
                }
            }

            if (moduleFnKeys.length) o.__denojs_worker_module_fns = moduleFnKeys;
            if (moduleAsyncFnKeys.length) o.__denojs_worker_module_async_fns = moduleAsyncFnKeys;
            return o;
        })()`;

        const raw = await this.eval(source);
        return wrapModuleNamespace<T>(this, raw);
    }
}

export default DenoWorker;
