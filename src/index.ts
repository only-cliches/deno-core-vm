// index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const native = require("../index.node");

export type DenoWorkerEvent = "message" | "close";
export type DenoWorkerMessageHandler = (msg: any) => void;

export type ImportsCallbackResult = boolean | string;
/**
 * `referrer` is best-effort and may be empty for some loads.
 * Kept optional so user callbacks can be `(specifier) => ...`.
 */
export type ImportsCallback = (
    specifier: string,
    referrer?: string
) => ImportsCallbackResult | Promise<ImportsCallbackResult>;

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

export type DenoWorkerOptions = {
    maxEvalMs?: number;
    maxMemoryBytes?: number;
    maxStackSizeBytes?: number;
    channelSize?: number;

    /**
     * Controls ES module loading:
     * - false: deny all imports
     * - true: allow disk imports
     * - function: imports callback (virtual modules, allow/deny, pass-through)
     */
    imports?: boolean | ImportsCallback;

    /**
     * Per-worker sandbox root used for:
     * - module resolution base (relative imports)
     * - file system "cwd" (Deno.cwd and relative FS ops via sandbox fs wrapper)
     *
     * Accepts a path or a file:// directory URL.
     * Defaults to process.cwd().
     */
    cwd?: string;

    /**
     * Deno permissions configuration.
     * Defaults to Deno "none" and non-interactive.
     */
    permissions?: DenoPermissions;

    /**
     * Enables Node compatibility behavior in the runtime.
     * Also implies a minimal sandboxed FS read grant to `cwd` when permissions.read is not explicitly provided.
     */
    nodeCompat?: boolean;
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
    postMessage(msg: any): void;
    on(event: string, cb: (...args: any[]) => void): void;
    isClosed(): boolean;

    close(): Promise<void>;
    memory(): Promise<any>;
    pump(): Promise<void>;
    setGlobal(key: string, value: any): Promise<void>;

    eval(src: string, options?: EvalOptions): Promise<any>;
    evalSync(src: string, options?: EvalOptions): any;

    lastExecutionStats: ExecStats;
};

function normalizeEvalOptions(options?: EvalOptions): EvalOptions | undefined {
    if (!options) return undefined;
    const out: EvalOptions = {};
    if (typeof options.filename === "string") out.filename = options.filename;
    if (options.type === "module") out.type = "module";
    if ("args" in options) out.args = Array.isArray(options.args) ? options.args : [];
    if (typeof options.maxEvalMs === "number" && Number.isFinite(options.maxEvalMs) && options.maxEvalMs > 0)
        out.maxEvalMs = options.maxEvalMs;
    return out;
}

function coerceMemoryPayload(raw: unknown): DenoWorkerMemory {
    const hs = (raw as any).heapStatistics;
    const hss = (raw as any).heapSpaceStatistics;
    return { heapStatistics: hs, heapSpaceStatistics: hss };
}

export class DenoWorker {
    private readonly native: NativeWorker;

    constructor(options?: DenoWorkerOptions) {
        this.native = (native as any).DenoWorker(options ?? {}) as NativeWorker;
    }

    on(event: DenoWorkerEvent, cb: DenoWorkerMessageHandler): void {
        this.native.on(event, cb);
    }

    postMessage(msg: any): void {
        this.native.postMessage(msg);
    }

    isClosed(): boolean {
        return this.native.isClosed();
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
        await this.native.close();
    }
    
    async pump(): Promise<void> {
        await this.native.pump();
    }

    async memory(): Promise<DenoWorkerMemory> {
        const raw = await this.native.memory();
        return coerceMemoryPayload(raw);
    }

    async setGlobal(key: string, value: any): Promise<void> {
        await this.native.setGlobal(key, value);
    }

    async eval(src: string, options?: EvalOptions): Promise<any> {
        return await this.native.eval(src, normalizeEvalOptions(options));
    }

    evalSync(src: string, options?: EvalOptions): any {
        return this.native.evalSync(src, normalizeEvalOptions(options));
    }

    async evalModule(source: string, options?: Omit<EvalOptions, "type">): Promise<any> {
        return await this.eval(source, { ...(options ?? {}), type: "module" });
    }
}

export default DenoWorker;