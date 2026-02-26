import { DenoWorker } from "../index";
import fc from "fast-check";
import { isDateLike } from "./helpers.assertions";

describe("deno_worker: data serialization", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  const identityFn = "(x) => x";

  it("round-trips JSON primitives and structures", async () => {
    dw = new DenoWorker();

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

    await expect(dw.eval(identityFn, { args: [{ foo: "bar", nested: { val: 123 } }] })).resolves.toEqual({
      foo: "bar",
      nested: { val: 123 },
    });
  });

  it("round-trips Date instances", async () => {
    dw = new DenoWorker();
    const input = new Date("2020-01-01T00:00:00Z");
    const result = await dw.eval(identityFn, { args: [input] });

    expect(isDateLike(result)).toBe(true);
    expect((result as Date).toISOString()).toBe(input.toISOString());
  });

  it("round-trips Uint8Array / Buffer payloads", async () => {
    dw = new DenoWorker();
    const input = Buffer.from([1, 2, 3, 4]);
    const result = await dw.eval(identityFn, { args: [input] });

    const out = Buffer.isBuffer(result) ? result : Buffer.from(result as Uint8Array);
    expect(Buffer.compare(input, out)).toBe(0);
  });

  it("does not mutate the original arguments (copy semantics)", async () => {
    dw = new DenoWorker();
    const inputObj: any = { val: 1 };

    const script = `(x) => { x.val = 999; return x; }`;
    const result: any = await dw.eval(script, { args: [inputObj] });

    expect(result.val).toBe(999);
    expect(inputObj.val).toBe(1);
  });

  it("property-based: round-trips JSON-serializable values", async () => {
    dw = new DenoWorker();

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (data) => {
        const result = await dw.eval(identityFn, { args: [data] });
        expect(result).toEqual(data);
      }),
      { numRuns: 100 }
    );
  });
});