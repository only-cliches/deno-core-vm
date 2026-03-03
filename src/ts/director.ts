/* eslint-disable @typescript-eslint/no-explicit-any */

import { DenoWorkerTemplate } from "./template";
import type {
    DenoDirectedRuntime,
    DenoDirectorListOptions,
    DenoDirectorOptions,
    DenoDirectorStartOptions,
    DenoRuntimeMeta,
    DenoRuntimeRecord,
} from "./types";

/** Generates a mostly-unique runtime id when caller does not provide one. */
function randomId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Trims labels and converts blank labels to `undefined`. */
function normalizeLabel(label: string | undefined): string | undefined {
    if (typeof label !== "string") return undefined;
    const v = label.trim();
    return v.length > 0 ? v : undefined;
}

/** Trims tags, drops blanks, and deduplicates while preserving insertion order. */
function normalizeTags(tags: string[] | undefined): string[] {
    if (!Array.isArray(tags)) return [];
    const out = new Set<string>();
    for (const t of tags) {
        if (typeof t !== "string") continue;
        const v = t.trim();
        if (!v) continue;
        out.add(v);
    }
    return [...out];
}

/** Internal guard that ensures a runtime came from this director instance. */
function getRuntimeMeta(runtime: DenoDirectedRuntime): DenoRuntimeMeta {
    const meta = (runtime as any).meta;
    if (!meta || typeof meta !== "object") {
        throw new Error("Runtime is not managed by DenoDirector");
    }
    return meta as DenoRuntimeMeta;
}

/**
 * Runtime orchestration facade built on top of {@link DenoWorkerTemplate}.
 *
 * Each started runtime is tracked with metadata (`runtime.meta`) and can be
 * queried by id, label, or tag.
 *
 * Director responsibilities:
 * - assign and enforce unique runtime ids
 * - maintain label/tag indexes
 * - keep indexes in sync across `close`, `restart`, and explicit stop APIs
 *
 * @example
 * ```ts
 * const dd = new DenoDirector({
 *   template: { workerOptions: { permissions: { env: true } } },
 * });
 * const rt = await dd.start({ label: "tenant-a", tags: ["billing"] });
 * const value = await rt.eval("1 + 1");
 * await dd.stopAll();
 * ```
 */
export class DenoDirector {
    private readonly template: DenoWorkerTemplate;
    private readonly byId = new Map<string, DenoRuntimeRecord>();
    private readonly labelIndex = new Map<string, Set<string>>();
    private readonly runtimeToId = new WeakMap<object, string>();

    constructor(options?: DenoDirectorOptions) {
        this.template = new DenoWorkerTemplate(options?.template);
    }

    /** Adds a runtime id to the label index for quick `getByLabel` lookups. */
    private indexLabel(id: string, label: string | undefined): void {
        if (!label) return;
        let ids = this.labelIndex.get(label);
        if (!ids) {
            ids = new Set<string>();
            this.labelIndex.set(label, ids);
        }
        ids.add(id);
    }

    /** Removes a runtime id from label index and prunes empty label buckets. */
    private unindexLabel(id: string, label: string | undefined): void {
        if (!label) return;
        const ids = this.labelIndex.get(label);
        if (!ids) return;
        ids.delete(id);
        if (ids.size === 0) this.labelIndex.delete(label);
    }

    /** Removes a runtime record and its indexes by id. */
    private unregisterById(id: string): boolean {
        const rec = this.byId.get(id);
        if (!rec) return false;
        this.byId.delete(id);
        this.unindexLabel(id, rec.meta.label);
        return true;
    }

    /** Throws when the candidate runtime id is already registered. */
    private ensureUniqueId(id: string): void {
        if (this.byId.has(id)) {
            throw new Error(`Runtime id already exists: ${id}`);
        }
    }

    /** Resolves either a runtime object or an id into a managed runtime instance. */
    private coerceRuntime(runtimeOrId: DenoDirectedRuntime | string): DenoDirectedRuntime | undefined {
        if (typeof runtimeOrId !== "string") return runtimeOrId;
        return this.byId.get(runtimeOrId)?.runtime;
    }

    /** Attaches immutable orchestration metadata to the runtime instance. */
    private attachMeta(runtime: any, meta: DenoRuntimeMeta): DenoDirectedRuntime {
        Object.defineProperty(runtime, "meta", {
            value: meta,
            writable: false,
            configurable: false,
            enumerable: true,
        });
        return runtime as DenoDirectedRuntime;
    }

    /**
     * Start a managed runtime.
     *
     * The returned runtime includes immutable `runtime.meta` for orchestration.
     *
     * ID behavior:
     * - `options.id` provided: must be unique
     * - no `options.id`: auto-generated id is assigned
     */
    async start(options?: DenoDirectorStartOptions): Promise<DenoDirectedRuntime> {
        const id = normalizeLabel(options?.id) ?? randomId();
        this.ensureUniqueId(id);

        const meta: DenoRuntimeMeta = {
            id,
            label: normalizeLabel(options?.label),
            tags: normalizeTags(options?.tags),
            createdAt: Date.now(),
        };

        const runtime = this.attachMeta(await this.template.create(options), meta);
        const record: DenoRuntimeRecord = { meta, runtime };
        this.byId.set(id, record);
        this.runtimeToId.set(runtime as any, id);
        this.indexLabel(id, meta.label);

        let restarting = false;

        const originalClose = runtime.close.bind(runtime);
        (runtime as any).close = async (options?: any) => {
            try {
                return await originalClose(options);
            } finally {
                if (!restarting) {
                    this.unregisterById(id);
                }
            }
        };

        const originalRestart = (runtime as any).restart?.bind(runtime);
        if (typeof originalRestart === "function") {
            (runtime as any).restart = async (options?: any) => {
                restarting = true;
                try {
                    return await originalRestart(options);
                } finally {
                    restarting = false;
                    if ((runtime as any).isClosed?.()) {
                        this.unregisterById(id);
                    }
                }
            };
        }

        runtime.on("close", () => {
            if (restarting) return;
            this.unregisterById(id);
        });

        return runtime;
    }

    /**
     * Lookup runtime by id.
     *
     * Returns `undefined` when id is unknown or runtime has been unregistered.
     */
    get(id: string): DenoDirectedRuntime | undefined {
        return this.byId.get(id)?.runtime;
    }

    /**
     * Lookup runtimes by label.
     *
     * Returns an empty array when label is blank/unknown.
     */
    getByLabel(label: string): DenoDirectedRuntime[] {
        const v = normalizeLabel(label);
        if (!v) return [];
        const ids = this.labelIndex.get(v);
        if (!ids) return [];
        const out: DenoDirectedRuntime[] = [];
        for (const id of ids) {
            const rt = this.byId.get(id)?.runtime;
            if (rt) out.push(rt);
        }
        return out;
    }

    /**
     * List runtimes, optionally filtered by label and/or tag.
     *
     * Filters are AND-combined when both are provided.
     */
    list(filter?: DenoDirectorListOptions): DenoDirectedRuntime[] {
        let runtimes = [...this.byId.values()].map((r) => r.runtime);
        const label = normalizeLabel(filter?.label);
        if (label) {
            runtimes = runtimes.filter((rt) => rt.meta.label === label);
        }
        if (filter?.tag) {
            const tag = filter.tag.trim();
            if (tag) runtimes = runtimes.filter((rt) => rt.meta.tags.includes(tag));
        }
        return runtimes;
    }

    /**
     * Update runtime label.
     *
     * Returns `false` when runtime is unknown.
     */
    setLabel(runtimeOrId: DenoDirectedRuntime | string, label?: string): boolean {
        const runtime = this.coerceRuntime(runtimeOrId);
        if (!runtime) return false;
        const meta = getRuntimeMeta(runtime);
        const next = normalizeLabel(label);
        if (meta.label === next) return true;
        this.unindexLabel(meta.id, meta.label);
        meta.label = next;
        this.indexLabel(meta.id, meta.label);
        return true;
    }

    /**
     * Replace all runtime tags.
     *
     * Returns `false` when runtime is unknown.
     */
    setTags(runtimeOrId: DenoDirectedRuntime | string, tags: string[]): boolean {
        const runtime = this.coerceRuntime(runtimeOrId);
        if (!runtime) return false;
        const meta = getRuntimeMeta(runtime);
        meta.tags = normalizeTags(tags);
        return true;
    }

    /**
     * Add a tag if not present.
     *
     * Returns `false` when runtime is unknown.
     */
    addTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean {
        const runtime = this.coerceRuntime(runtimeOrId);
        if (!runtime) return false;
        const t = normalizeLabel(tag);
        if (!t) return true;
        const meta = getRuntimeMeta(runtime);
        if (!meta.tags.includes(t)) meta.tags.push(t);
        return true;
    }

    /**
     * Remove a tag if present.
     *
     * Returns `false` when runtime is unknown.
     */
    removeTag(runtimeOrId: DenoDirectedRuntime | string, tag: string): boolean {
        const runtime = this.coerceRuntime(runtimeOrId);
        if (!runtime) return false;
        const t = normalizeLabel(tag);
        if (!t) return true;
        const meta = getRuntimeMeta(runtime);
        meta.tags = meta.tags.filter((x) => x !== t);
        return true;
    }

    /**
     * Stop one runtime by id or instance.
     *
     * Returns `false` when runtime is unknown.
     */
    async stop(runtimeOrId: DenoDirectedRuntime | string): Promise<boolean> {
        const runtime = this.coerceRuntime(runtimeOrId);
        if (!runtime) return false;
        const meta = getRuntimeMeta(runtime);
        if (!runtime.isClosed()) {
            await runtime.close();
        }
        this.unregisterById(meta.id);
        return true;
    }

    /**
     * Stop all runtimes matching a label.
     *
     * Returns number of runtimes that were stopped.
     */
    async stopByLabel(label: string): Promise<number> {
        const runtimes = this.getByLabel(label);
        let count = 0;
        for (const rt of runtimes) {
            if (await this.stop(rt)) count += 1;
        }
        return count;
    }

    /**
     * Stop all managed runtimes.
     *
     * Returns number of runtimes that were stopped.
     */
    async stopAll(): Promise<number> {
        const runtimes = this.list();
        let count = 0;
        for (const rt of runtimes) {
            if (await this.stop(rt)) count += 1;
        }
        return count;
    }
}
