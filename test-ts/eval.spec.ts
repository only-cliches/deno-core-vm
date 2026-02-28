import { DenoWorker } from "../src/index";
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

  it(
    "per-eval maxEvalMs overrides global maxEvalMs for that call only",
    async () => {
      // Global limit is generous so it would NOT time out on its own.
      dw = new DenoWorker({ maxEvalMs: 5_000 } as any);

      // This call should time out due to per-call override.
      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 } as any).catch((e) => e);
      expect(err1).toBeTruthy();

      // Subsequent call without per-call override should still work (global is large).
      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );

  it(
    "per-eval maxEvalMs can be longer than global (overrides for that call)",
    async () => {
      // Global is small.
      dw = new DenoWorker({ maxEvalMs: 25 } as any);

      // Per-call sets a longer limit, so it should have time to finish.
      await expect(
        dw.eval(
          `
        const start = Date.now();
        while (Date.now() - start < 75) {}
        123;
        `,
          { maxEvalMs: 500 } as any
        )
      ).resolves.toBe(123);

      // Without per-call override, the global limit should still apply.
      const err2 = await dw.eval("while (true) {}").catch((e) => e);
      expect(err2).toBeTruthy();
    },
    20_000
  );

  it(
    "per-eval maxEvalMs overrides global maxEvalMs for that call only (and does not poison subsequent evals)",
    async () => {
      dw = new DenoWorker({ maxEvalMs: 5_000 } as any);

      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 } as any).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );
});