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

function finiteInt(v: unknown, min: number, max = Number.POSITIVE_INFINITY): number | undefined {
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    if (v < min || v > max) return undefined;
    return Math.trunc(v);
}

function finitePositive(v: unknown): number | undefined {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
    return v;
}

function nonEmptyTrimmed(v: unknown): string | undefined {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s ? s : undefined;
}

/**
 * Sanitizes user-provided eval options before crossing the native boundary.
 *
 * This strips invalid fields and preserves binary views as raw payloads so
 * hot data paths avoid avoidable byte expansion.
 */
export function normalizeEvalOptions(options?: EvalOptions): EvalOptions | undefined {
    if (!options) return undefined;
    const out: EvalOptions = {};
    if (typeof options.filename === "string") out.filename = options.filename;
    if (options.type === "module") out.type = "module";
    const srcLoader = (options as any).srcLoader ?? (options as any).loader;
    if (
        srcLoader === "js" ||
        srcLoader === "ts" ||
        srcLoader === "tsx" ||
        srcLoader === "jsx"
    ) {
        out.srcLoader = srcLoader;
    }
    if ("args" in options) {
        out.args = Array.isArray(options.args)
            ? options.args.map((a) => {
                    if (typeof Buffer !== "undefined" && Buffer.isBuffer(a)) return a;
                    if (typeof ArrayBuffer !== "undefined" && a instanceof ArrayBuffer) return a;
                    if (typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer) return a;
                    if (
                        typeof ArrayBuffer !== "undefined" &&
                        typeof ArrayBuffer.isView === "function" &&
                        ArrayBuffer.isView(a)
                    ) {
                        return a;
                    }
                    return dehydrateForWire(a);
                })
            : [];
    }
    if (typeof options.maxEvalMs === "number" && Number.isFinite(options.maxEvalMs) && options.maxEvalMs > 0) {
        out.maxEvalMs = options.maxEvalMs;
    }
    if (typeof options.maxCpuMs === "number" && Number.isFinite(options.maxCpuMs) && options.maxCpuMs > 0) {
        out.maxCpuMs = options.maxCpuMs;
    }
    return out;
}

/** Coerces raw native memory payload into the public memory response shape. */
export function coerceMemoryPayload(raw: unknown): DenoWorkerMemory {
    const hs = (raw as any).heapStatistics;
    const hss = (raw as any).heapSpaceStatistics;
    return { heapStatistics: hs, heapSpaceStatistics: hss };
}

/** Normalizes the `console` option into the wire-safe shape expected by native. */
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

/** Normalizes environment input (`string` path or key/value object). */
function normalizeEnvOption(x: unknown): unknown {
    if (x === undefined) return undefined;

    if (typeof x === "string") return nonEmptyTrimmed(x);

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

/** Normalizes inspector config and bounds-checks numeric port values. */
function normalizeInspectOption(x: unknown): unknown {
    if (x === undefined) return undefined;

    if (x === true || x === false) return x;

    if (x && typeof x === "object") {
        const o: any = x as any;
        const out: any = {};

        if (typeof o.host === "string") out.host = o.host;

        const port = finiteInt(o.port, 0, 65535);
        if (port !== undefined) out.port = port;

        if (typeof o.break === "boolean") out.break = o.break;

        return out;
    }

    return undefined;
}

/** Extracts recognized module-loader flags and drops unsupported keys. */
function normalizeModuleLoaderOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};

    if (typeof o.httpsResolve === "boolean") out.httpsResolve = o.httpsResolve;
    if (typeof o.httpResolve === "boolean") out.httpResolve = o.httpResolve;
    if (typeof o.nodeResolve === "boolean") out.nodeResolve = o.nodeResolve;
    if (typeof o.cjsInterop === "boolean" || o.cjsInterop === "esbuild") out.cjsInterop = o.cjsInterop;
    if (typeof o.jsrResolve === "boolean") out.jsrResolve = o.jsrResolve;
    if (typeof o.reload === "boolean") out.reload = o.reload;
    const maxPayloadBytes = finiteInt(o.maxPayloadBytes, Number.NEGATIVE_INFINITY);
    if (maxPayloadBytes !== undefined) out.maxPayloadBytes = maxPayloadBytes;
    const cacheDir = nonEmptyTrimmed(o.cacheDir);
    if (cacheDir !== undefined) out.cacheDir = cacheDir;

    return Object.keys(out).length ? out : undefined;
}

/** Extracts TS/JSX compiler options used by runtime transpilation paths. */
function normalizeTsCompilerOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};
    const rawJsx = o.jsx;
    if (rawJsx === "react" || rawJsx === "react-jsx" || rawJsx === "react-jsxdev" || rawJsx === "preserve") {
        out.jsx = rawJsx;
    }
    const jsxFactory = nonEmptyTrimmed(o.jsxFactory);
    if (jsxFactory !== undefined) out.jsxFactory = jsxFactory;
    const jsxFragmentFactory = nonEmptyTrimmed(o.jsxFragmentFactory);
    if (jsxFragmentFactory !== undefined) out.jsxFragmentFactory = jsxFragmentFactory;
    const cacheDir = nonEmptyTrimmed(o.cacheDir);
    if (cacheDir !== undefined) out.cacheDir = cacheDir;
    return Object.keys(out).length ? out : undefined;
}

/** Normalizes stream/channel bridge tuning values into finite integers. */
function normalizeBridgeOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};

    const channelSize = finiteInt(o.channelSize, 1);
    if (channelSize !== undefined) out.channelSize = channelSize;
    const streamWindowBytes = finiteInt(o.streamWindowBytes, 1);
    if (streamWindowBytes !== undefined) out.streamWindowBytes = streamWindowBytes;
    const streamCreditFlushBytes = finiteInt(o.streamCreditFlushBytes, 1);
    if (streamCreditFlushBytes !== undefined) out.streamCreditFlushBytes = streamCreditFlushBytes;
    const streamBacklogLimit = finiteInt(o.streamBacklogLimit, 1);
    if (streamBacklogLimit !== undefined) out.streamBacklogLimit = streamBacklogLimit;
    const streamHighWaterMarkBytes = finiteInt(o.streamHighWaterMarkBytes, 1);
    if (streamHighWaterMarkBytes !== undefined) out.streamHighWaterMarkBytes = streamHighWaterMarkBytes;

    return Object.keys(out).length ? out : undefined;
}

/** Normalizes top-level `limits` fields into finite integer/number values. */
function normalizeLimitsOption(x: unknown): unknown {
    if (!x || typeof x !== "object") return undefined;
    const o: any = x as any;
    const out: any = {};

    const maxHandle = finiteInt(o.maxHandle, 1);
    if (maxHandle !== undefined) out.maxHandle = maxHandle;
    const maxEvalMs = finitePositive(o.maxEvalMs);
    if (maxEvalMs !== undefined) out.maxEvalMs = maxEvalMs;
    const maxCpuMs = finitePositive(o.maxCpuMs);
    if (maxCpuMs !== undefined) out.maxCpuMs = maxCpuMs;
    const maxMemoryBytes = finiteInt(o.maxMemoryBytes, 1);
    if (maxMemoryBytes !== undefined) out.maxMemoryBytes = maxMemoryBytes;

    return Object.keys(out).length ? out : undefined;
}

/**
 * Produces the worker option payload sent to native worker construction.
 *
 * Fields that are host-only (`lifecycle`, `globals`) are removed here because
 * they are implemented by the TypeScript wrapper layer.
 */
export function normalizeWorkerOptions(options?: DenoWorkerOptions): DenoWorkerWorkerOptions {
    const o: any = { ...(options ?? {}) };
    delete o.lifecycle;
    delete o.globals;
    const limits: any = normalizeLimitsOption(o.limits);
    delete o.limits;
    if (limits) {
        if (typeof limits.maxEvalMs === "number") o.maxEvalMs = limits.maxEvalMs;
        if (typeof limits.maxCpuMs === "number") o.maxCpuMs = limits.maxCpuMs;
        if (typeof limits.maxMemoryBytes === "number") o.maxMemoryBytes = limits.maxMemoryBytes;
    }

    if (typeof o.nodeCompat !== "boolean") delete o.nodeCompat;

    o.console = normalizeConsoleOption(o.console);
    o.env = normalizeEnvOption(o.env);
    o.inspect = normalizeInspectOption(o.inspect);
    o.moduleLoader = normalizeModuleLoaderOption(o.moduleLoader);
    o.bridge = normalizeBridgeOption(o.bridge);
    delete o.channelSize;
    delete o.sourceLoaders;
    delete o.transpileTs;
    o.tsCompiler = normalizeTsCompilerOption(o.tsCompiler);
    delete o.nodeResolve;
    if ((o.moduleLoader?.httpsResolve === true || o.moduleLoader?.httpResolve === true) && o.imports === undefined) {
        o.imports = true;
    }

    if (!(typeof o.envFile === "boolean" || typeof o.envFile === "string")) delete o.envFile;
    if (typeof o.envFile === "string") {
        const s = nonEmptyTrimmed(o.envFile);
        if (!s) delete o.envFile;
        else o.envFile = s;
    }

    return o as any;
}

/** Helper for template/director APIs that accept either string or string array fields. */
export function asStringArray(v: string | string[] | undefined): string[] {
    if (typeof v === "string") return v ? [v] : [];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.length > 0);
    return [];
}

/**
 * Shallow-merges two worker option objects with deep merges for nested
 * `permissions`, `lifecycle`, `bridge`, `limits`, and `moduleLoader` sections.
 */
export function mergeWorkerOptions(base?: DenoWorkerOptions, overrides?: DenoWorkerOptions): DenoWorkerOptions | undefined {
    if (!base && !overrides) return undefined;
    const out: DenoWorkerOptions = { ...(base ?? {}), ...(overrides ?? {}) };

    if (base?.permissions !== undefined || overrides?.permissions !== undefined) {
        const basePerms = base?.permissions;
        const overridePerms = overrides?.permissions;
        if (typeof overridePerms === "boolean") {
            out.permissions = overridePerms;
        }
        else if (typeof basePerms === "boolean") {
            out.permissions = overridePerms ?? basePerms;
        }
        else if (basePerms && overridePerms) {
            out.permissions = { ...basePerms, ...overridePerms };
        }
        else {
            out.permissions = (overridePerms ?? basePerms) as any;
        }
    }

    if (base?.lifecycle || overrides?.lifecycle) {
        out.lifecycle = { ...(base?.lifecycle ?? {}), ...(overrides?.lifecycle ?? {}) };
    }

    if ((base as any)?.bridge || (overrides as any)?.bridge) {
        (out as any).bridge = { ...((base as any)?.bridge ?? {}), ...((overrides as any)?.bridge ?? {}) };
    }
    if ((base as any)?.limits || (overrides as any)?.limits) {
        (out as any).limits = { ...((base as any)?.limits ?? {}), ...((overrides as any)?.limits ?? {}) };
    }
    if ((base as any)?.moduleLoader || (overrides as any)?.moduleLoader) {
        (out as any).moduleLoader = {
            ...((base as any)?.moduleLoader ?? {}),
            ...((overrides as any)?.moduleLoader ?? {}),
        };
    }

    return out;
}
