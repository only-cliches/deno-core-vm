/* eslint-disable @typescript-eslint/no-explicit-any */

import { dehydrateForWire } from "./wire";
import type {
    DenoConsoleMethod,
    DenoWorkerOptions,
    DenoWorkerMemory,
    EvalOptions,
} from "./types";

// Alias to preserve existing exported name
export type DenoWorkerWorkerOptions = DenoWorkerOptions;

export function normalizeEvalOptions(options?: EvalOptions): EvalOptions | undefined {
    if (!options) return undefined;
    const out: EvalOptions = {};
    if (typeof options.filename === "string") out.filename = options.filename;
    if (options.type === "module") out.type = "module";
    if ("args" in options) {
        out.args = Array.isArray(options.args)
            ? options.args.map((a) => {
                    if (typeof Buffer !== "undefined" && Buffer.isBuffer(a)) return a;
                    if (typeof ArrayBuffer !== "undefined" && a instanceof ArrayBuffer) return a;
                    if (typeof Uint8Array !== "undefined" && a instanceof Uint8Array) return a;
                    if (
                        typeof ArrayBuffer !== "undefined" &&
                        typeof ArrayBuffer.isView === "function" &&
                        ArrayBuffer.isView(a)
                    ) {
                        return dehydrateForWire(a);
                    }
                    return dehydrateForWire(a);
                })
            : [];
    }
    if (typeof options.maxEvalMs === "number" && Number.isFinite(options.maxEvalMs) && options.maxEvalMs > 0) {
        out.maxEvalMs = options.maxEvalMs;
    }
    return out;
}

export function coerceMemoryPayload(raw: unknown): DenoWorkerMemory {
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

        if (typeof o.port === "number" && Number.isFinite(o.port) && o.port >= 0 && o.port <= 65535) {
            out.port = Math.trunc(o.port);
        }

        if (typeof o.break === "boolean") out.break = o.break;

        return out;
    }

    return undefined;
}

function normalizeModuleLoaderOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};

    if (typeof o.httpsResolve === "boolean") out.httpsResolve = o.httpsResolve;
    if (typeof o.httpResolve === "boolean") out.httpResolve = o.httpResolve;
    if (typeof o.nodeResolve === "boolean") out.nodeResolve = o.nodeResolve;
    if (typeof o.jsrResolve === "boolean") out.jsrResolve = o.jsrResolve;
    if (typeof o.reload === "boolean") out.reload = o.reload;
    if (typeof o.maxPayloadBytes === "number" && Number.isFinite(o.maxPayloadBytes)) {
        out.maxPayloadBytes = Math.trunc(o.maxPayloadBytes);
    }
    if (typeof o.cacheDir === "string") {
        const s = o.cacheDir.trim();
        if (s) out.cacheDir = s;
    }

    return Object.keys(out).length ? out : undefined;
}

function normalizeTsCompilerOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};
    const rawJsx = o.jsx;
    if (rawJsx === "react" || rawJsx === "react-jsx" || rawJsx === "react-jsxdev" || rawJsx === "preserve") {
        out.jsx = rawJsx;
    }
    if (typeof o.jsxFactory === "string") {
        const s = o.jsxFactory.trim();
        if (s) out.jsxFactory = s;
    }
    if (typeof o.jsxFragmentFactory === "string") {
        const s = o.jsxFragmentFactory.trim();
        if (s) out.jsxFragmentFactory = s;
    }
    if (typeof o.cacheDir === "string") {
        const s = o.cacheDir.trim();
        if (s) out.cacheDir = s;
    }
    return Object.keys(out).length ? out : undefined;
}

function normalizeBridgeOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};

    if (typeof o.channelSize === "number" && Number.isFinite(o.channelSize) && o.channelSize >= 1) {
        out.channelSize = Math.trunc(o.channelSize);
    }
    if (typeof o.streamWindowBytes === "number" && Number.isFinite(o.streamWindowBytes) && o.streamWindowBytes >= 1) {
        out.streamWindowBytes = Math.trunc(o.streamWindowBytes);
    }
    if (
        typeof o.streamCreditFlushBytes === "number" &&
        Number.isFinite(o.streamCreditFlushBytes) &&
        o.streamCreditFlushBytes >= 1
    ) {
        out.streamCreditFlushBytes = Math.trunc(o.streamCreditFlushBytes);
    }

    return Object.keys(out).length ? out : undefined;
}

export function normalizeWorkerOptions(options?: DenoWorkerOptions): DenoWorkerWorkerOptions {
    const o: any = { ...(options ?? {}) };
    delete o.lifecycle;
    delete o.globals;

    if (typeof o.nodeCompat !== "boolean") delete o.nodeCompat;

    o.console = normalizeConsoleOption(o.console);
    o.env = normalizeEnvOption(o.env);
    o.inspect = normalizeInspectOption(o.inspect);
    o.moduleLoader = normalizeModuleLoaderOption(o.moduleLoader);
    o.bridge = normalizeBridgeOption(o.bridge);
    delete o.channelSize;
    if (typeof o.transpileTs !== "boolean") delete o.transpileTs;
    o.tsCompiler = normalizeTsCompilerOption(o.tsCompiler);
    delete o.transpliteTs;
    delete o.nodeResolve;
    if ((o.moduleLoader?.httpsResolve === true || o.moduleLoader?.httpResolve === true) && o.imports === undefined) {
        o.imports = true;
    }

    if (!(typeof o.envFile === "boolean" || typeof o.envFile === "string")) delete o.envFile;
    if (typeof o.envFile === "string") {
        const s = o.envFile.trim();
        if (!s) delete o.envFile;
        else o.envFile = s;
    }

    return o as any;
}

export function asStringArray(v: string | string[] | undefined): string[] {
    if (typeof v === "string") return v ? [v] : [];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return [];
}

export function mergeWorkerOptions(base?: DenoWorkerOptions, overrides?: DenoWorkerOptions): DenoWorkerOptions | undefined {
    if (!base && !overrides) return undefined;
    const out: DenoWorkerOptions = { ...(base ?? {}), ...(overrides ?? {}) };

    if (base?.permissions || overrides?.permissions) {
        out.permissions = { ...(base?.permissions ?? {}), ...(overrides?.permissions ?? {}) };
    }

    if (base?.lifecycle || overrides?.lifecycle) {
        out.lifecycle = { ...(base?.lifecycle ?? {}), ...(overrides?.lifecycle ?? {}) };
    }

    if ((base as any)?.bridge || (overrides as any)?.bridge) {
        (out as any).bridge = { ...((base as any)?.bridge ?? {}), ...((overrides as any)?.bridge ?? {}) };
    }

    return out;
}
