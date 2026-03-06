import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("deno_worker: eval", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = createTestWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("does not auto-call a returned function unless args are provided (returns undefined)", async () => {
    await expect(dw.eval("(x) => x + 1")).resolves.toBeUndefined();
  });

  it("args provided but evaluated value is not a function: returns value (ignores args)", async () => {
    await expect(dw.eval("123", { args: [1, 2, 3] })).resolves.toBe(123);
  });

  it(
    "evalSync honors maxEvalMs and returns promptly on runaway scripts",
    async () => {
      await dw.close();
      dw = createTestWorker({ limits: { maxEvalMs: 5_000 } });

      const started = Date.now();
      expect(() => dw.evalSync("while (true) {}", { maxEvalMs: 25 })).toThrow();
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
      await dw.global.set("hostFn", hostFn);

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
      await dw.global.set("hostAsync", async (x: number) => x + 1);

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

  it("updates stats.lastExecution after eval", async () => {
    expect(dw.stats.lastExecution).toBeDefined();
    await dw.eval("1 + 1");
    expect(dw.stats.lastExecution).toBeDefined();
    expect(dw.stats.lastExecution?.cpuTimeMs).toEqual(expect.any(Number));
    expect(dw.stats.lastExecution?.evalTimeMs).toEqual(expect.any(Number));
  });

  it("transpiles TypeScript for eval and evalSync when srcLoader:'ts' is set", async () => {
    await expect(dw.eval("const n: number = 41; n + 1;", { srcLoader: "ts" })).resolves.toBe(42);
    expect(dw.evalSync("const n: number = 2; n + 3;", { srcLoader: "ts" })).toBe(5);
  });

  it("defaults eval loader to js (TypeScript syntax requires srcLoader:'ts')", async () => {
    await expect(dw.eval("const n: number = 41; n + 1;")).rejects.toBeDefined();
    await expect(dw.eval("const n: number = 41; n + 1;", { srcLoader: "ts" })).resolves.toBe(42);
  });

  it("writes transpile cache entries when tsCompiler.cacheDir is set", async () => {
    await dw.close();
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "deno-director-ts-cache-"));

    dw = createTestWorker({
      tsCompiler: { cacheDir },
    });

    try {
      await expect(dw.eval("const n: number = 7; n + 1;", { srcLoader: "ts" })).resolves.toBe(8);
      const entries = fs.readdirSync(cacheDir);
      expect(entries.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("supports async custom loader chains for eval", async () => {
    await dw.close();
    dw = createTestWorker({
      sourceLoaders: [
        async ({ src, srcLoader }) => {
          if (srcLoader !== "custom-ts") return;
          return { src, srcLoader: "ts" };
        },
      ],
    });

    await expect(
      dw.eval("const n: number = 20; n + 22;", { srcLoader: "custom-ts" as any }),
    ).resolves.toBe(42);
  });

  it("evalSync rejects when a custom loader is async", async () => {
    await dw.close();
    dw = createTestWorker({
      sourceLoaders: [
        async ({ src }) => ({ src, srcLoader: "js" }),
      ],
    });

    expect(() => dw.evalSync("1 + 1")).toThrow(/sync evaluation cannot use async loaders/i);
  });

  it("sourceLoaders:false enforces strict js mode (no built-in ts/tsx/jsx loader)", async () => {
    await dw.close();
    dw = createTestWorker({ sourceLoaders: false });

    await expect(dw.eval("1 + 1")).resolves.toBe(2);
    await expect(dw.eval("const n: number = 1; n;", { srcLoader: "ts" })).rejects.toThrow(/strict js mode|sourceLoaders:\s*false/i);
    expect(() => dw.evalSync("const n: number = 1; n;", { srcLoader: "ts" })).toThrow(/strict js mode|sourceLoaders:\s*false/i);
  });

  it(
    "per-eval maxEvalMs overrides global maxEvalMs for that call only",
    async () => {
      await dw.close();
      dw = createTestWorker({ limits: { maxEvalMs: 5_000 } });

      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 }).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );

  it(
    "per-eval maxCpuMs overrides global maxCpuMs for that call only",
    async () => {
      await dw.close();
      dw = createTestWorker({ limits: { maxCpuMs: 5_000 } });

      const err1 = await dw.eval("while (true) {}", { maxCpuMs: 25 }).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );

  it(
    "per-eval maxEvalMs can be longer than global (overrides for that call)",
    async () => {
      await dw.close();
      dw = createTestWorker({ limits: { maxEvalMs: 25 } });

      await expect(
        dw.eval(
          `
        const start = Date.now();
        while (Date.now() - start < 75) {}
        123;
        `, { maxEvalMs: 500  }
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
      dw = createTestWorker({ limits: { maxEvalMs: 5_000 } });

      const err1 = await dw.eval("while (true) {}", { maxEvalMs: 25 }).catch((e) => e);
      expect(err1).toBeTruthy();

      await expect(dw.eval("1 + 1")).resolves.toBe(2);
    },
    20_000
  );
});
