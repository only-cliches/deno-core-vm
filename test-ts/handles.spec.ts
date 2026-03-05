import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("deno_worker: handles", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = createTestWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("handle.get(path) binds to existing runtime value and supports get/set/call/getType", async () => {
    await dw.eval(`
      globalThis.__handleRepo = {
        value: 1,
        nested: { n: 2 },
        inc(x) { this.value += x; return this.value; }
      };
    `);

    const h = await dw.handle.get("globalThis.__handleRepo");

    expect(h.rootType).toMatchObject({ type: "object", callable: false });
    await expect(h.get("value")).resolves.toBe(1);
    await h.set("nested.n", 9);
    await expect(h.get("nested.n")).resolves.toBe(9);
    await expect(h.call("inc", [5])).resolves.toBe(6);
    await expect(h.get("value")).resolves.toBe(6);

    await expect(h.getType()).resolves.toMatchObject({ type: "object", callable: false });
    await expect(h.getType("inc")).resolves.toMatchObject({ type: "function", callable: true });
  });

  test("handle.eval(source) creates unbound handle value", async () => {
    const h = await dw.handle.eval(`({
      total: 0,
      add(x) { this.total += x; return this.total; }
    })`);

    await expect(h.call("add", [3])).resolves.toBe(3);
    await expect(h.call("add", [7])).resolves.toBe(10);
    await expect(h.get("total")).resolves.toBe(10);
  });

  test("handle.eval supports callable root values", async () => {
    const fn = await dw.handle.eval(`(a, b) => a + b`);
    expect(fn.rootType).toMatchObject({ type: "function", callable: true });
    const refreshed = await fn.getType();
    expect(fn.rootType).toEqual(refreshed);
    await expect(fn.call([20, 22])).resolves.toBe(42);
  });

  test("handle.call preserves binary args without degrading bytes", async () => {
    const fn = await dw.handle.eval(`(u8) => ({ len: u8.length >>> 0, first: u8[0] ?? -1, last: u8[u8.length - 1] ?? -1 })`);
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 255;
    await expect(fn.call([payload])).resolves.toEqual({
      len: payload.length,
      first: payload[0],
      last: payload[payload.length - 1],
    });
  });

  test("dispose is idempotent and prevents further operations", async () => {
    const h = await dw.handle.eval(`({ a: 1 })`);
    await h.dispose();
    await h.dispose();

    expect(h.disposed).toBe(true);
    await expect(h.get()).rejects.toThrow(/disposed|invalidated/i);
  });

  test("handles are invalidated across restart", async () => {
    const h = await dw.handle.eval(`({ a: 1 })`);

    await dw.restart();

    expect(h.disposed).toBe(true);
    await expect(h.get("a")).rejects.toThrow(/disposed|invalidated/i);
  });

  test("handle.get(path) rejects for missing paths", async () => {
    await expect(dw.handle.get("globalThis.__missing_handle_value")).rejects.toThrow(/not found|path/i);
  });

  test("handle.get(path) succeeds for present-but-undefined values", async () => {
    await dw.eval(`globalThis.__present_undefined = undefined;`);
    const h = await dw.handle.get("globalThis.__present_undefined");
    expect(h.rootType).toMatchObject({ type: "undefined", callable: false });
    await expect(h.get()).resolves.toBeUndefined();
  });

  test("handle.tryGet(path) returns undefined when path is missing", async () => {
    await expect(dw.handle.tryGet("globalThis.__missing_handle_value")).resolves.toBeUndefined();
  });

  test("handle.has/delete/keys/entries work on object values", async () => {
    const h = await dw.handle.eval(`({ a: 1, b: 2 })`);
    await expect(h.has("a")).resolves.toBe(true);
    await expect(h.keys()).resolves.toEqual(expect.arrayContaining(["a", "b"]));
    await expect(h.entries()).resolves.toEqual(expect.arrayContaining([["a", 1], ["b", 2]]));
    await expect(h.delete("b")).resolves.toBe(true);
    await expect(h.has("b")).resolves.toBe(false);
  });

  test("handle.define/getOwnPropertyDescriptor updates descriptors", async () => {
    const h = await dw.handle.eval(`({})`);
    await expect(
      h.define("x", { value: 42, enumerable: true, configurable: true, writable: true }),
    ).resolves.toBe(true);
    await expect(h.get("x")).resolves.toBe(42);
    await expect(h.getOwnPropertyDescriptor("x")).resolves.toMatchObject({
      value: 42,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });

  test("handle.instanceOf/isCallable/isPromise/construct/await/clone/toJSON/apply", async () => {
    const obj = await dw.handle.eval(`({ n: 1, add(x){ this.n += x; return this.n; } })`);
    await expect(obj.instanceOf("Object")).resolves.toBe(true);
    await expect(obj.isCallable()).resolves.toBe(false);
    await expect(obj.isCallable("add")).resolves.toBe(true);
    await expect(obj.isPromise()).resolves.toBe(false);
    await expect(obj.apply([{ op: "call", path: "add", args: [2] }, { op: "get", path: "n" }, { op: "isPromise" }])).resolves.toEqual([3, 3, false]);
    await expect(obj.toJSON()).resolves.toMatchObject({ n: 3 });

    const clone = await obj.clone();
    await expect(clone.call("add", [1])).resolves.toBe(4);
    await expect(obj.get("n")).resolves.toBe(4);

    const Ctor = await dw.handle.eval(`(class Thing { constructor(v){ this.value = v; } })`);
    const made = await Ctor.construct([9]);
    expect(made).toMatchObject({ value: 9 });

    const p = await dw.handle.eval(`Promise.resolve(7)`);
    await expect(p.isPromise()).resolves.toBe(true);
    await expect(p.await()).resolves.toBe(7);
    await expect(p.isPromise()).resolves.toBe(false);
    expect(p.rootType.type).toBe("number");

    const pNoReturn = await dw.handle.eval(`Promise.resolve(8)`);
    await expect(pNoReturn.await({ returnValue: false })).resolves.toBeUndefined();
    await expect(pNoReturn.get()).resolves.toBe(8);

    const chain = await dw.handle.eval(`
      ({
        then(resolve) {
          resolve({
            then(resolve2) {
              resolve2(Promise.resolve(9));
            }
          });
        }
      })
    `);
    await expect(chain.await({ untilNonPromise: true })).resolves.toBe(9);
    await expect(chain.get()).resolves.toBe(9);
  });

  test("handle.apply settles async call results", async () => {
    const h = await dw.handle.eval(`({
      async incAsync(x) {
        return Promise.resolve(x + 1);
      }
    })`);
    await expect(h.apply([{ op: "call", path: "incAsync", args: [4] }])).resolves.toEqual([5]);
  });

  test("handle.await with untilNonPromise throws on pathological thenable chains", async () => {
    const looping = await dw.handle.eval(`
      (() => {
        const self = { then(resolve) { resolve(self); } };
        return self;
      })()
    `);
    await expect(looping.await({ untilNonPromise: true })).rejects.toThrow(/max unwrap depth/i);
  });

  test("handle.toJSON handles bigint and cycles without throwing", async () => {
    const h = await dw.handle.eval(`
      (() => {
        const o = { id: 1n };
        o.self = o;
        return o;
      })()
    `);
    const snap = await h.toJSON();
    expect(snap).toEqual(expect.objectContaining({ id: 1, self: "[Circular]" }));
  });

  test("maxHandle enforces active handle limit", async () => {
    const limited = createTestWorker({ limits: { maxHandle: 2 } });
    try {
      const a = await limited.handle.eval("({ a: 1 })");
      const b = await limited.handle.eval("({ b: 2 })");
      await expect(limited.handle.eval("({ c: 3 })")).rejects.toThrow(/handle limit reached/i);
      await a.dispose();
      await expect(limited.handle.eval("({ c: 3 })")).resolves.toBeDefined();
      await b.dispose();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("forbidden prototype-mutation path segments are rejected", async () => {
    const h = await dw.handle.eval(`({ safe: true })`);
    await expect(h.set("__proto__.polluted", 1)).rejects.toThrow(/forbidden/i);
    await expect(h.set("nested.constructor.value", 1)).rejects.toThrow(/forbidden/i);
    await expect(h.set("nested.prototype.value", 1)).rejects.toThrow(/forbidden/i);
  });

  test("handle.call can override worker maxEvalMs per operation", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(`({
        burn(ms) {
          const start = Date.now();
          while (Date.now() - start < ms) {}
          return ms;
        }
      })`);

      await expect(h.call("burn", [80])).rejects.toThrow();
      await expect(h.call("burn", [80], { maxEvalMs: 750 })).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("handle.call can override worker maxCpuMs per operation", async () => {
    const limited = createTestWorker({ limits: { maxCpuMs: 25 } });
    try {
      const h = await limited.handle.eval(`({
        burn(ms) {
          const start = Date.now();
          while (Date.now() - start < ms) {}
          return ms;
        }
      })`);

      await expect(h.call("burn", [80])).rejects.toThrow();
      await expect(h.call("burn", [80], { maxCpuMs: 250 })).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("handle.call supports options in root-call form", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const fn = await limited.handle.eval(`(ms) => {
        const start = Date.now();
        while (Date.now() - start < ms) {}
        return ms;
      }`);

      await expect(fn.call([80])).rejects.toThrow();
      await expect(fn.call([80], { maxEvalMs: 250 })).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("handle creation maxEvalMs overrides worker default for subsequent calls", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          burn(ms) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
            return ms;
          }
        })`,
        { maxEvalMs: 250 },
      );

      await expect(h.call("burn", [80])).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("per-call maxEvalMs overrides handle creation maxEvalMs", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          burn(ms) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
            return ms;
          }
        })`,
        { maxEvalMs: 250 },
      );

      await expect(h.call("burn", [80], { maxEvalMs: 40 })).rejects.toThrow();
      await expect(h.call("burn", [80], { maxEvalMs: 300 })).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("handle.get creation maxEvalMs is used as default for handle calls", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      await limited.eval(`
        globalThis.__slowRepo = {
          burn(ms) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
            return ms;
          }
        };
      `);

      const h = await limited.handle.get("globalThis.__slowRepo", { maxEvalMs: 250 });
      await expect(h.call("burn", [80])).resolves.toBe(80);
      await expect(h.call("burn", [80], { maxEvalMs: 40 })).rejects.toThrow();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("empty per-call options still inherit handle creation maxEvalMs default", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          burn(ms) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
            return ms;
          }
        })`,
        { maxEvalMs: 250 },
      );

      await expect(h.call("burn", [80], {})).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("clone preserves handle creation maxEvalMs default", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          burn(ms) {
            const start = Date.now();
            while (Date.now() - start < ms) {}
            return ms;
          }
        })`,
        { maxEvalMs: 250 },
      );
      const clone = await h.clone();
      await expect(clone.call("burn", [80])).resolves.toBe(80);
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("dispose accepts options and remains idempotent", async () => {
    const h = await dw.handle.eval(`({ a: 1 })`, { maxEvalMs: 250 });
    await expect(h.dispose({ maxEvalMs: 10 })).resolves.toBeUndefined();
    await expect(h.dispose({ maxEvalMs: 10 })).resolves.toBeUndefined();
    expect(h.disposed).toBe(true);
  });

  test("apply failure rejects but handle remains usable", async () => {
    const h = await dw.handle.eval(`({ n: 1 })`);
    await expect(h.apply([{ op: "set", path: "n", value: 2 }, { op: "nope" as unknown as never }])).rejects.toBeTruthy();
    await expect(h.get("n")).resolves.toBe(2);
  });

  test("getType on root refreshes after await(returnValue:false)", async () => {
    const p = await dw.handle.eval(`Promise.resolve(123)`);
    expect(p.rootType.type).toBe("promise");
    await expect(p.await({ returnValue: false })).resolves.toBeUndefined();
    const info = await p.getType("");
    expect(info.type).toBe("number");
    expect(p.rootType.type).toBe("number");
  });

  test("tryGet accepts options and returns undefined for missing path", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      await expect(
        limited.handle.tryGet("globalThis.__definitely_missing__", { maxEvalMs: 200 }),
      ).resolves.toBeUndefined();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("in-flight handle call rejects on force restart and handle invalidates", async () => {
    const h = await dw.handle.eval(`({
      async slow() {
        await new Promise((r) => setTimeout(r, 200));
        return 1;
      }
    })`);

    const pending = h.call("slow").then(
      (value) => ({ status: "resolved" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    );
    await new Promise((r) => setTimeout(r, 20));
    await dw.restart({ force: true });
    const out = await pending;
    expect(out.status).toBe("rejected");
    expect(h.disposed).toBe(true);
    await expect(h.get()).rejects.toThrow(/disposed|invalidated/i);
  });

  test("handle maxEvalMs precedence matrix across methods", async () => {
    const limited = createTestWorker({ limits: { maxEvalMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          get slow() {
            const start = Date.now();
            while (Date.now() - start < 80) {}
            return 7;
          },
          slowFn() {
            const start = Date.now();
            while (Date.now() - start < 80) {}
            return 8;
          }
        })`,
        { maxEvalMs: 200 },
      );

      await expect(h.get("slow")).resolves.toBe(7);
      await expect(h.getType("slowFn")).resolves.toMatchObject({ type: "function" });
      await expect(h.toJSON("slow")).resolves.toBe(7);
      await expect(h.apply([{ op: "get", path: "slow" }, { op: "call", path: "slowFn" }])).resolves.toEqual([7, 8]);

      await expect(h.get("slow", { maxEvalMs: 30 })).rejects.toThrow();
      await expect(h.apply([{ op: "call", path: "slowFn" }], { maxEvalMs: 30 })).rejects.toThrow();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("handle maxCpuMs precedence matrix across methods", async () => {
    const limited = createTestWorker({ limits: { maxCpuMs: 25 } });
    try {
      const h = await limited.handle.eval(
        `({
          get slow() {
            const start = Date.now();
            while (Date.now() - start < 80) {}
            return 7;
          },
          slowFn() {
            const start = Date.now();
            while (Date.now() - start < 80) {}
            return 8;
          }
        })`,
        { maxCpuMs: 200 },
      );

      await expect(h.get("slow")).resolves.toBe(7);
      await expect(h.getType("slowFn")).resolves.toMatchObject({ type: "function" });
      await expect(h.toJSON("slow")).resolves.toBe(7);
      await expect(h.apply([{ op: "get", path: "slow" }, { op: "call", path: "slowFn" }])).resolves.toEqual([7, 8]);

      await expect(h.get("slow", { maxCpuMs: 30 })).rejects.toThrow();
      await expect(h.apply([{ op: "call", path: "slowFn" }], { maxCpuMs: 30 })).rejects.toThrow();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

});
