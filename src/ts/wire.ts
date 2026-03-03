/* eslint-disable @typescript-eslint/no-explicit-any */

type WireJson = any;
const GRAPH_ID_KEY = "__denojs_worker_graph_id";
const GRAPH_REF_KEY = "__denojs_worker_graph_ref";
const GRAPH_KIND_KEY = "__denojs_worker_graph_kind";
const GRAPH_VALUE_KEY = "__denojs_worker_graph_value";
const FORBIDDEN_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Canonical wire sentinel for `undefined` values. */
function wireUndef(): WireJson {
    return { __undef: true };
}

/** Canonical wire sentinel for non-finite numeric markers. */
function wireNum(tag: string): WireJson {
    return { __num: tag };
}

/**
 * Converts host values into a JSON-safe wire representation.
 *
 * Preserves special JS types (Error, Date, typed arrays, Map/Set, bigint) and
 * keeps object graph identity for cyclic/shared references via graph ids.
 */
export function dehydrateForWire(value: any): WireJson {
    const seen = typeof WeakMap !== "undefined" ? new WeakMap<object, number>() : null;
    let nextGraphId = 1;

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
            if (!seen) return wireUndef();

            const existing = seen.get(x);
            if (typeof existing === "number") {
                return { [GRAPH_REF_KEY]: existing };
            }

            const graphId = nextGraphId++;
            seen.set(x, graphId);

            if (Array.isArray(x)) {
                return {
                    [GRAPH_ID_KEY]: graphId,
                    [GRAPH_KIND_KEY]: "array",
                    [GRAPH_VALUE_KEY]: x.map((it) => inner(it, depth + 1)),
                };
            }

            const out: any = {};
            for (const [k, v] of Object.entries(x)) out[k] = inner(v, depth + 1);
            return {
                [GRAPH_ID_KEY]: graphId,
                [GRAPH_KIND_KEY]: "object",
                [GRAPH_VALUE_KEY]: out,
            };
        }

        return wireUndef();
    }

    return inner(value, 0);
}

/** Convenience wrapper for argument lists passed into eval/evalModule calls. */
export function dehydrateArgs(args: any[] | undefined): any[] {
    if (!Array.isArray(args)) return [];
    return args.map((a) => dehydrateForWire(a));
}

/** Downcasts bigint to number only when precision would remain exact. */
function maybeBigIntToNumber(x: bigint): number | bigint {
    const n = Number(x);
    if (Number.isSafeInteger(n) && BigInt(n) === x) return n;
    return x;
}

/** Clones typed-array views into the current realm to avoid cross-realm surprises. */
function cloneViewToRealm(x: any): any {
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
        const bytes = new Uint8Array(src);
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

/** Reconstructs ArrayBuffer/typed-array payloads from wire transport objects. */
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

/**
 * Rehydrates wire values back into host JS values.
 *
 * This is the inverse of `dehydrateForWire` for supported value categories.
 */
export function hydrateFromWire(v: any): any {
    const graph = new Map<number, any>();
    const isForbiddenProtoKey = (k: string): boolean => FORBIDDEN_PROTO_KEYS.has(k);

    function inner(x: any): any {
        if (x == null) return x;

        if (typeof x === "bigint") return maybeBigIntToNumber(x);

        if (typeof x !== "object") return x;

        if (Array.isArray(x)) return x.map(inner);

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

        if (
            typeof (x as any)[GRAPH_REF_KEY] === "number" &&
            Object.keys(x).length === 1
        ) {
            return graph.get((x as any)[GRAPH_REF_KEY]);
        }

        if (
            typeof (x as any)[GRAPH_ID_KEY] === "number" &&
            typeof (x as any)[GRAPH_KIND_KEY] === "string" &&
            GRAPH_VALUE_KEY in (x as any)
        ) {
            const id = (x as any)[GRAPH_ID_KEY] as number;
            const kind = (x as any)[GRAPH_KIND_KEY] as string;
            const raw = (x as any)[GRAPH_VALUE_KEY];
            if (graph.has(id)) return graph.get(id);

            if (kind === "array") {
                if (!Array.isArray(raw)) {
                    const v2 = inner(raw);
                    graph.set(id, v2);
                    return v2;
                }
                const arr: any[] = [];
                graph.set(id, arr);
                for (const item of raw) arr.push(inner(item));
                return arr;
            }

            const isPlainObject =
                !!raw &&
                typeof raw === "object" &&
                !Array.isArray(raw) &&
                Object.prototype.toString.call(raw) === "[object Object]";
            const rawLooksGraph =
                !!raw &&
                typeof raw === "object" &&
                typeof (raw as any)[GRAPH_ID_KEY] === "number" &&
                typeof (raw as any)[GRAPH_KIND_KEY] === "string" &&
                GRAPH_VALUE_KEY in (raw as any);

            if (rawLooksGraph) {
                const v2 = inner(raw);
                graph.set(id, v2);
                return v2;
            }

            if (kind !== "object" || !isPlainObject) {
                const v2 = inner(raw);
                graph.set(id, v2);
                return v2;
            }

            const out: any = {};
            graph.set(id, out);
            for (const [k, v2] of Object.entries(raw)) {
                if (isForbiddenProtoKey(k)) continue;
                out[k] = inner(v2);
            }
            return out;
        }

        const out: any = {};
        for (const [k, v2] of Object.entries(x)) {
            if (isForbiddenProtoKey(k)) continue;
            out[k] = inner(v2);
        }
        return out;
    }

    return inner(v);
}
