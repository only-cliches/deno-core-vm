// index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const native = require("./index.node");

export type DenoWorkerEvent = "message" | "close";
export type DenoWorkerMessageHandler = (msg: any) => void;

export type DenoWorkerOptions = {
    channelSize?: number;
    maxEvalMs?: number;
    maxMemoryBytes?: number;
    maxStackSizeBytes?: number;
};

export type EvalOptions = {
    filename?: string;
    type?: "script" | "module";
    args?: any[];
};

export type ExecStats = {
    cpuTimeMs?: number;
    evalTimeMs?: number;
};

type NativeWorker = {
    postMessage(msg: any): void;
    on(event: string, cb: (...args: any[]) => void): void;
    isClosed(): boolean;

    close(): Promise<void>;
    memory(): Promise<any>;
    setGlobal(key: string, value: any): Promise<void>;

    eval(src: string, options?: EvalOptions): Promise<any>;
    evalSync(src: string, options?: EvalOptions): any;

    // Defined via Object.defineProperty in Rust. May be null/undefined until first eval settles.
    lastExecutionStats: ExecStats;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function normalizeEvalOptions(options?: EvalOptions): EvalOptions | undefined {
    if (!options) return undefined;
    const out: EvalOptions = {};
    if (typeof options.filename === "string") out.filename = options.filename;
    if (options.type === "module") out.type = "module";
    if ("args" in options) out.args = Array.isArray(options.args) ? options.args : [];
    return out;
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

    async memory(): Promise<any> {
        return await this.native.memory();
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