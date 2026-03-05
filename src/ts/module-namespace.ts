/* eslint-disable @typescript-eslint/no-explicit-any */

import type { EvalOptions } from "./types";
import { buildModuleInvokeSource } from "./module-source";
import { hydrateFromWire } from "./wire";

type ModuleWrapperHost = {
    evalSync(src: string, options?: EvalOptions): any;
    eval(src: string, options?: EvalOptions): Promise<any>;
};

/** Detects encoded module-function descriptors emitted by runtime-side module wrappers. */
function getModuleFnTag(x: any): { spec: string; name: string; isAsync: boolean } | null {
    if (!x || typeof x !== "object") return null;
    const specRaw = (x as any).spec;
    const nameRaw = (x as any).name;
    const asyncRaw = (x as any).async;
    const tag = (x as any).__denojs_worker_type;
    if (specRaw == null || nameRaw == null) return null;

    const spec = String(specRaw);
    const name = String(nameRaw);
    const isAsync = asyncRaw === true;
    if (!spec.startsWith("denojs+")) return null;

    if (tag === "module_fn") return { spec, name, isAsync };
    const keys = Object.keys(x);
    if (
        keys.length <= 4 &&
        keys.every((k) => k === "__denojs_worker_type" || k === "spec" || k === "name" || k === "async")
    ) {
        return { spec, name, isAsync };
    }
    return null;
}

/**
 * Wraps hydrated module namespaces so exported runtime functions become
 * host-callable stubs that dispatch back through `dw.eval`/`dw.evalSync`.
 */
export function wrapModuleNamespace<T extends Record<string, any>>(dw: ModuleWrapperHost, ns: any): T {
    if (!ns || typeof ns !== "object") return ns as T;

    const proto = Object.getPrototypeOf(ns);
    const out: any = proto === null ? Object.create(null) : {};
    const moduleSpec = typeof (ns as any).__denojs_worker_module_spec === "string" ? (ns as any).__denojs_worker_module_spec : undefined;
    const moduleFnKeys = new Set(
        Array.isArray((ns as any).__denojs_worker_module_fns)
            ? (ns as any).__denojs_worker_module_fns.filter((x: any) => typeof x === "string")
            : [],
    );
    const moduleAsyncFnKeys = new Set(
        Array.isArray((ns as any).__denojs_worker_module_async_fns)
            ? (ns as any).__denojs_worker_module_async_fns.filter((x: any) => typeof x === "string")
            : [],
    );

    for (const [k, v] of Object.entries(ns)) {
        if (k === "__denojs_worker_module_spec" || k === "__denojs_worker_module_fns" || k === "__denojs_worker_module_async_fns") continue;
        const modFn = getModuleFnTag(v);
        const shouldWrap = !!modFn || moduleFnKeys.has(k);
        if (shouldWrap) {
            const spec = modFn?.spec ?? moduleSpec;
            const name = modFn?.name ?? k;
            const isAsync = modFn?.isAsync ?? moduleAsyncFnKeys.has(k);
            if (typeof spec !== "string") {
                out[k] = hydrateFromWire(v);
                continue;
            }

            out[k] = (...args: any[]) => {
                const src = buildModuleInvokeSource(spec, name);
                if (isAsync) return dw.eval(src, { args });
                return dw.evalSync(src, { args });
            };
        } else {
            out[k] = hydrateFromWire(v);
        }
    }

    return out as T;
}
