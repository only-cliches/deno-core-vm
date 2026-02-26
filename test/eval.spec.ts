import { DenoWorker } from "../index";
import { assertErrorLike } from "./helpers.assertions";

describe("deno_worker: eval", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("evaluates simple expressions", async () => {
    dw = new DenoWorker();
    await expect(dw.eval("1 + 1")).resolves.toBe(2);
  });

  it("evaluates and returns objects", async () => {
    dw = new DenoWorker();
    await expect(dw.eval("({ a: 1, b: 'test' })")).resolves.toEqual({ a: 1, b: "test" });
  });

  // it("throws on runtime errors (rejects with Error)", async () => {
  //   dw = new DenoWorker();
  //   const result = await dw.eval('throw new Error("boom")').catch((e) => e);
  //   assertErrorLike(result);
  //   await expect(dw.eval("throw new Error('Boom')")).rejects.toThrow("Boom");
  // });

  it("supports evalSync for basic cases", () => {
    dw = new DenoWorker();
    expect(dw.evalSync("2 + 3")).toBe(5);
  });

  it("supports calling evaluated functions when args are provided", async () => {
    dw = new DenoWorker();
    const fnSrc = "(a, b, c) => [a, b, c]";
    const result = await dw.eval(fnSrc, { args: [1, "second", true] });
    expect(result).toEqual([1, "second", true]);
  });

  it("treats empty args as an intentional call when args are provided", async () => {
    dw = new DenoWorker();
    const fnSrc = "() => 'called'";
    const result = await dw.eval(fnSrc, { args: [] });
    expect(result).toBe("called");
  });

  it("updates lastExecutionStats after eval", async () => {
    dw = new DenoWorker();
    expect(dw.lastExecutionStats).toBeDefined();
    await dw.eval("1 + 1");
    expect(dw.lastExecutionStats).toBeDefined();
    expect(dw.lastExecutionStats?.cpuTimeMs).toEqual(expect.any(Number));
    expect(dw.lastExecutionStats?.evalTimeMs).toEqual(expect.any(Number));
  });
});