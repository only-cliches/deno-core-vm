import { DenoWorker } from "../index";
import { assertErrorLike, isDateLike } from "./helpers.assertions";

describe("DenoWorker data and errors", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = new DenoWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("passes primitives and JSON-compatible values", async () => {
    await expect(dw.eval("(x) => x", { args: ["Hello, 🌍!"] })).resolves.toBe("Hello, 🌍!");
    await expect(dw.eval("(x) => x", { args: [42] })).resolves.toBe(42);
    await expect(dw.eval("(x) => x", { args: [true] })).resolves.toBe(true);
    await expect(dw.eval("(x) => x", { args: [null] })).resolves.toBeNull();
    await expect(dw.eval("(x) => x", { args: [undefined] })).resolves.toBeUndefined();

    const obj = { foo: "bar", nested: { val: 123 } };
    await expect(dw.eval("(x) => x", { args: [obj] })).resolves.toEqual(obj);

    const arr = [1, "two", true, null];
    await expect(dw.eval("(x) => x", { args: [arr] })).resolves.toEqual(arr);
  });

  test("dates and bytes behave predictably", async () => {
    const d = new Date("2023-01-01T12:00:00.000Z");
    const result = await dw.eval("(x) => x", { args: [d] });
    expect(isDateLike(result)).toBe(true);
    expect((result as Date).toISOString()).toBe("2023-01-01T12:00:00.000Z");

    const buf = Buffer.from([0x01, 0x02, 0xff]);
    const outBuf = await dw.eval("(x) => x", { args: [buf] });

    expect(Buffer.isBuffer(outBuf) || outBuf instanceof Uint8Array).toBe(true);
    expect(Buffer.compare(buf, outBuf as Buffer)).toBe(0);
  });

  test("eval can call a returned function when args are provided", async () => {
    const script = "(a, b, c) => [a, b, c]";
    const result = await dw.eval(script, { args: [1, "second", true] });
    expect(result).toEqual([1, "second", true]);
  });

  test("rejections preserve raw values when rejecting non-Errors", async () => {
    await expect(dw.eval('Promise.reject("string-reject")')).rejects.toBe("string-reject");

    await expect(dw.eval('Promise.reject({ kind: "E_OBJ", message: "object-reject", code: 123 })'))
      .rejects.toMatchObject({ kind: "E_OBJ", message: "object-reject", code: 123 });
  });

  // test("thrown Errors are Errors on the Node side", async () => {
  //   // let result = await expect(dw.eval('(() => { throw new Error("boom"); })()'));
  //   // assertErrorLike(result);

  //   await expect(dw.eval('(() => { throw new Error("boom"); })()')).rejects.toMatchObject({
  //     name: "Error",
  //     message: "boom",
  //   });
  // });
});