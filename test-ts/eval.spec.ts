import { DenoWorker } from "../src/index";

describe("deno_worker: eval", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = new DenoWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("does not auto-call a returned function unless args are provided (returns undefined)", async () => {
    await expect(dw.eval("(x) => x + 1")).resolves.toBeUndefined();
  });

  it("args provided but evaluated value is not a function: returns value (ignores args)", async () => {
    await expect(dw.eval("123", { args: [1, 2, 3] } as any)).resolves.toBe(123);
  });

  it(
    "evalSync honors maxEvalMs and returns promptly on runaway scripts",
    async () => {
      await dw.close();
      dw = new DenoWorker({ maxEvalMs: 5_000 } as any);

      const started = Date.now();
      expect(() => dw.evalSync("while (true) {}", { maxEvalMs: 25 } as any)).toThrow();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2_000);

      expect(dw.evalSync("40 + 2")).toBe(42);
    },
    20_000
  );

  it("returning a function value from eval becomes undefined", async () => {
    await expect(dw.eval("(() => function foo() {})()")).resolves.toBeUndefined();
  });

  it("evaluates simple expressions", async () => {
    await expect(dw.eval("1 + 1")).resolves.toBe(2);
  });

  it("evaluates and returns objects", async () => {
    await expect(dw.eval("({ a: 1, b: 'test' })")).resolves.toEqual({ a: 1, b: "test" });
  });

  it("supports evalSync for basic cases", () => {
    expect(dw.evalSync("2 + 3")).toBe(5);
  });

  it(
    "evalSync calling an injected host function fails fast with an explicit error",
    async () => {
      const hostFn = jest.fn((x: number) => x + 1);
      await dw.setGlobal("hostFn", hostFn);

      const started = Date.now();
      expect(() => dw.evalSync("hostFn(1)")).toThrow(/evalsync|cross-runtime/i);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1_500);
    },
    20_000,
  );

  it(
    "evalSync calling an injected async host function fails fast with an explicit error",
    async () => {
      await dw.setGlobal("hostAsync", async (x: number) => x + 1);

      const started = Date.now();
      expect(() => dw.evalSync("hostAsync(1)")).toThrow(/evalsync|cross-runtime/i);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1_500);
    },
    20_000,
  );

  it("supports calling evaluated functions when args are provided", async () => {
    const fnSrc = "(a, b, c) => [a, b, c]";
    const result = await dw.eval(fnSrc, { args: [1, "second", true] });
    expect(result).toEqual([1, "second", true]);
  });

  it("treats empty args as an intentional call when args are provided", async () => {
    const fnSrc = "() => 'called'";
    const result = await dw.eval(fnSrc, { args: [] });
    expect(result).toBe("called");
  });

  it("updates lastExecutionStats after eval", async () => {
    expect(dw.lastExecutionStats).toBeDefined();
    await dw.eval("1 + 1");
    expect(dw.lastExecutionStats).toBeDefined();
    expect(dw.lastExecutionStats?.cpuTimeMs).toEqual(expect.any(Number));
    expect(dw.lastExecutionStats?.evalTimeMs).toEqual(expect.any(Number));
  });

  it(
    "per-eval maxEvalMs overrides global maxEvalMs for that call only",
    async () => {
      await dw.close();
      dw = new DenoWorker({ maxEvalMs: 5_000 } as any);

      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 } as any).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );

  it(
    "per-eval maxEvalMs can be longer than global (overrides for that call)",
    async () => {
      await dw.close();
      dw = new DenoWorker({ maxEvalMs: 25 } as any);

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

      const err2 = await dw.eval("while (true) {}").catch((e) => e);
      expect(err2).toBeTruthy();
    },
    20_000
  );

  it(
    "per-eval maxEvalMs overrides global maxEvalMs for that call only (and does not poison subsequent evals)",
    async () => {
      await dw.close();
      dw = new DenoWorker({ maxEvalMs: 5_000 } as any);

      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 } as any).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );
});
