globalThis.__nodeMessageListeners = [];
globalThis.on = (name, fn) => { if (name === "message" && typeof fn === "function") globalThis.__nodeMessageListeners.push(fn); };
globalThis.addEventListener = (name, fn) => { if (name === "message" && typeof fn === "function") globalThis.__nodeMessageListeners.push((e) => fn(e)); };
globalThis.postMessage = (msg) => Deno.core.ops.op_post_message(msg);

globalThis.__dispatchNodeMessage = (payload) => {
    for (const fn of globalThis.__nodeMessageListeners) {
        try { fn(payload); } catch (_) { }
    }
};

globalThis.__hydrate = function (v) {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(globalThis.__hydrate);
    if (typeof v !== "object") return v;

    if (v.__date !== undefined) return new Date(v.__date);
    if (v.__bytes !== undefined) return new Uint8Array(v.__bytes);

    if (v.__denojs_worker_num === "-0") return -0;

    if (v.__denojs_worker_type === "error") {
        const e = new Error(String(v.message ?? ""));
        if (typeof v.name === "string") e.name = v.name;
        if (typeof v.stack === "string") e.stack = v.stack;
        if ("code" in v) e.code = v.code;
        return e;
    }

    if (v.__denojs_worker_type === "function" && typeof v.id === "number") {
        const id = v.id;
        const isAsync = !!v.async;

        const callAsync = async (...args) => {
            const res = await Deno.core.ops.op_host_call_async(id, args);
            if (res?.ok) return globalThis.__hydrate(res.value);
            throw globalThis.__hydrate(res?.error);
        };

        if (isAsync) {
            return async (...args) => callAsync(...args);
        }

        // Sync wrapper with automatic fallback when host returns a Promise.
        return (...args) => {
            const res = Deno.core.ops.op_host_call_sync(id, args);

            if (res?.ok) return globalThis.__hydrate(res.value);

            const err = res?.error;
            const msg = String(err?.message ?? "");

            // If the "sync" host function actually returned a Promise, fall back to async.
            if (msg.includes("returned a Promise")) {
                return callAsync(...args);
            }

            throw globalThis.__hydrate(err);
        };
    }

    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = globalThis.__hydrate(val);
    return out;
};

globalThis.__globals = Object.create(null);
globalThis.__applyGlobals = () => {
    for (const [k, v] of Object.entries(globalThis.__globals)) {
        globalThis[k] = globalThis.__hydrate(v);
    }
};

globalThis.moduleReturn = (v) => { globalThis.__moduleReturn = v; };