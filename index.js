"use strict";
// index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DenoWorker = void 0;
const native = require("./index.node");
function isPlainObject(v) {
    return !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}
function normalizeEvalOptions(options) {
    if (!options)
        return undefined;
    const out = {};
    if (typeof options.filename === "string")
        out.filename = options.filename;
    if (options.type === "module")
        out.type = "module";
    if ("args" in options)
        out.args = Array.isArray(options.args) ? options.args : [];
    return out;
}
class DenoWorker {
    constructor(options) {
        this.native = native.DenoWorker(options ?? {});
    }
    on(event, cb) {
        this.native.on(event, cb);
    }
    postMessage(msg) {
        this.native.postMessage(msg);
    }
    isClosed() {
        return this.native.isClosed();
    }
    get lastExecutionStats() {
        const v = this.native.lastExecutionStats;
        if (!v || typeof v !== "object")
            return {};
        const cpu = v.cpuTimeMs;
        const evalt = v.evalTimeMs;
        if (typeof cpu === "number" && typeof evalt === "number") {
            return { cpuTimeMs: cpu, evalTimeMs: evalt };
        }
        return {};
    }
    async close() {
        await this.native.close();
    }
    async memory() {
        return await this.native.memory();
    }
    async setGlobal(key, value) {
        await this.native.setGlobal(key, value);
    }
    async eval(src, options) {
        return await this.native.eval(src, normalizeEvalOptions(options));
    }
    evalSync(src, options) {
        return this.native.evalSync(src, normalizeEvalOptions(options));
    }
    async evalModule(source, options) {
        return await this.eval(source, { ...(options ?? {}), type: "module" });
    }
}
exports.DenoWorker = DenoWorker;
exports.default = DenoWorker;
//# sourceMappingURL=index.js.map