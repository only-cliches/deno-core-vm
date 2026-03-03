import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";
import fc from "fast-check";
import { isDateLike } from "./helpers.assertions";

describe("deno_worker: data serialization", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  const identityFn = "(x) => x";
  const hasProtoKey = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(hasProtoKey);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, "__proto__")) return true;
      return Object.values(obj).some(hasProtoKey);
    }
    return false;
  };

  it("round-trips JSON primitives and structures", async () => {
    dw = createTestWorker();

    await expect(dw.eval(identityFn, { args: ["Hello, 🌍!"] })).resolves.toBe("Hello, 🌍!");
    await expect(dw.eval(identityFn, { args: [42] })).resolves.toBe(42);
    await expect(dw.eval(identityFn, { args: [true] })).resolves.toBe(true);
    await expect(dw.eval(identityFn, { args: [null] })).resolves.toBeNull();
    await expect(dw.eval(identityFn, { args: [undefined] })).resolves.toBeUndefined();

    await expect(dw.eval(identityFn, { args: [[1, "two", true, null]] })).resolves.toEqual([
      1,
      "two",
      true,
      null,
    ]);

    await expect(dw.eval(identityFn, { args: [{ foo: "bar", nested: { val: 123 } }] })).resolves.toEqual(
      {
        foo: "bar",
        nested: { val: 123 },
      }
    );
  });


  it("round-trips NaN and Infinity as primitive numbers", async () => {
    dw = createTestWorker();

    const nan = await dw.eval("(x) => x", { args: [Number.NaN] });
    expect(Number.isNaN(nan)).toBe(true);

    const inf = await dw.eval("(x) => x", { args: [Number.POSITIVE_INFINITY] });
    expect(inf).toBe(Number.POSITIVE_INFINITY);

    const ninf = await dw.eval("(x) => x", { args: [Number.NEGATIVE_INFINITY] });
    expect(ninf).toBe(Number.NEGATIVE_INFINITY);
  });

  it("preserves -0 as a primitive number and on return", async () => {
    dw = createTestWorker();

    const out = await dw.eval("(x) => x", { args: [-0] });
    expect(Object.is(out, -0)).toBe(true);

    const out2 = await dw.eval("(() => -0)()");
    expect(Object.is(out2, -0)).toBe(true);
  });

  it("round-trips Date instances", async () => {
    dw = createTestWorker();
    const input = new Date("2020-01-01T00:00:00Z");
    const result = await dw.eval(identityFn, { args: [input] });

    expect(isDateLike(result)).toBe(true);
    expect((result as Date).toISOString()).toBe(input.toISOString());
  });

  it("round-trips Uint8Array / Buffer payloads", async () => {
    dw = createTestWorker();
    const input = Buffer.from([1, 2, 3, 4]);
    const result = await dw.eval(identityFn, { args: [input] });

    const out = Buffer.isBuffer(result) ? result : Buffer.from(result as Uint8Array);
    expect(Buffer.compare(input, out)).toBe(0);
  });

  it("preserves -0 across the bridge (args and return)", async () => {
    dw = createTestWorker();

    const out = await dw.eval(identityFn, { args: [-0] });
    expect(Object.is(out, -0)).toBe(true);

    const out2 = await dw.eval("-0");
    expect(Object.is(out2, -0)).toBe(true);

    const check = await dw.eval("(x) => Object.is(x, -0)", { args: [-0] });
    expect(check).toBe(true);
  });

  it("converts small BigInt results to Number when lossless, rejects when too large", async () => {
    dw = createTestWorker();

    await expect(dw.eval("1n")).resolves.toBe(1);

    await expect(dw.eval("2n ** 200n")).rejects.toThrow(/bigint/i);
  });

  it("does not mutate the original arguments (copy semantics)", async () => {
    dw = createTestWorker();
    const inputObj: any = { val: 1 };

    const script = "(x) => { x.val = 999; return x; }";
    const result: any = await dw.eval(script, { args: [inputObj] });

    expect(result.val).toBe(999);
    expect(inputObj.val).toBe(1);
  });

  it("preserves recursive object graphs (Node -> Deno args)", async () => {
    dw = createTestWorker();

    const a: any = { name: "a" };
    const b: any = { name: "b", a };
    a.self = a;
    a.b = b;
    a.same = b;

    const ok = await dw.eval(
      "(x) => x.self === x && x.b.a === x && x.same === x.b",
      { args: [a] },
    );
    expect(ok).toBe(true);
  });

  it("preserves recursive object graphs (Deno -> Node result)", async () => {
    dw = createTestWorker();

    const out: any = await dw.eval(`
      (() => {
        const a = { name: "a" };
        const b = { name: "b", a };
        a.self = a;
        a.b = b;
        a.same = b;
        return a;
      })()
    `);

    expect(out.self).toBe(out);
    expect(out.b.a).toBe(out);
    expect(out.same).toBe(out.b);
  });

  it("property-based: round-trips JSON-serializable values", async () => {
    dw = createTestWorker();

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (data) => {
        fc.pre(!hasProtoKey(data));
        const result = await dw.eval(identityFn, { args: [data] });
        expect(result).toEqual(data);
      }),
      { numRuns: 100 }
    );
  });

  it("does not allow prototype pollution from worker -> host hydration", async () => {
    dw = createTestWorker();

    const out: any = await dw.eval(`(() => JSON.parse('{"__proto__":{"polluted":"yes"},"safe":2}'))()`);
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(false);
  });

  it("does not allow prototype pollution from host -> worker hydration", async () => {
    dw = createTestWorker();

    const payload = JSON.parse('{"__proto__":{"polluted":"yes"},"safe":1}');
    const res: any = await dw.eval(
      `(x) => ({ ownProto: Object.prototype.hasOwnProperty.call(x, "__proto__"), polluted: ({}).polluted, safe: x.safe })`,
      { args: [payload] },
    );
    expect(res.ownProto).toBe(false);
    expect(res.polluted).toBeUndefined();
    expect(res.safe).toBe(1);
  });
});
