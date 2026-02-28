// src/index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const native = require("../index.node");

export type DenoWorkerEvent = "message" | "close";
export type DenoWorkerMessageHandler = (msg: any) => void;

export type ImportsCallbackResult =
  | boolean
  | { js: string }
  | { resolve: string };

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

export type DenoConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";
export type DenoConsoleHandler = false | undefined | ((...args: any[]) => any);
export type DenoWorkerConsoleOption =
  | undefined
  | false
  | Console
  | Partial<Record<DenoConsoleMethod, DenoConsoleHandler>>;

export type DenoWorkerOptions = {
  maxEvalMs?: number;
  maxMemoryBytes?: number;
  maxStackSizeBytes?: number;
  channelSize?: number;

  imports?: boolean | ImportsCallback;

  cwd?: string;

  startup?: string;
  index?: string;

  permissions?: DenoPermissions;

  nodeCompat?: boolean;

  console?: DenoWorkerConsoleOption;
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
  postMessage(msg: any): boolean; // CHANGED: now returns enqueue ok
  on(event: string, cb: (...args: any[]) => void): void;
  isClosed(): boolean;

  close(): Promise<void>;
  memory(): Promise<any>;
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
  if (
    typeof options.maxEvalMs === "number" &&
    Number.isFinite(options.maxEvalMs) &&
    options.maxEvalMs > 0
  ) {
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

  // Route to Node console (best behavior and preserves binding)
  if (x === console) {
    return { __denojs_worker_console_mode: "node" };
  }

  // Per-method config
  if (x && typeof x === "object") {
    const o: any = x as any;

    // Allow explicit marker passthrough
    if (typeof o.__denojs_worker_console_mode === "string") return o;

    const out: any = {};
    const methods: DenoConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

    for (const m of methods) {
      if (!(m in o)) continue;

      const v = o[m];
      if (v === undefined) {
        // Preserve explicit undefined if user set it.
        out[m] = undefined;
      } else if (v === false) {
        out[m] = false;
      } else if (typeof v === "function") {
        out[m] = v;
      }
    }

    return out;
  }

  // Unsupported values treated as default
  return undefined;
}

function normalizeWorkerOptions(options?: DenoWorkerOptions): DenoWorkerOptions {
  const o: DenoWorkerOptions = { ...(options ?? {}) };

  const s = typeof o.startup === "string" ? o.startup : undefined;
  const i = typeof o.index === "string" ? o.index : undefined;
  if (!s && i) o.startup = i;

  o.console = normalizeConsoleOption(o.console) as any;

  return o;
}

export class DenoWorker {
  private readonly native: NativeWorker;

  constructor(options?: DenoWorkerOptions) {
    this.native = (native as any).DenoWorker(normalizeWorkerOptions(options)) as NativeWorker;
  }

  on(event: DenoWorkerEvent, cb: DenoWorkerMessageHandler): void {
    this.native.on(event, cb);
  }

  postMessage(msg: any): void {
    const ok = this.native.postMessage(msg);
    if (!ok) {
      throw new Error("DenoWorker.postMessage dropped: worker queue full or closed");
    }
  }

  tryPostMessage(msg: any): boolean {
    return this.native.postMessage(msg);
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