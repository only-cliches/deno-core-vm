export function buildModuleInvokeSource(spec: string, name: string): string {
    const specJson = JSON.stringify(spec);
    const nameJson = JSON.stringify(name);
    return `(...args) => import(${specJson}).then(m => m[${nameJson}](...args))`;
}

export function buildImportModuleSource(spec: string): string {
    const specJson = JSON.stringify(spec);
    return `(async () => {
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
}
