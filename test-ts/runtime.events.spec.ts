import { createTestWorker } from "./helpers.worker-harness";


describe("DenoWorker runtime events", () => {
  test("emits eval begin/end with args and no source text", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.eval(`(a, b) => a + b`, { args: [2, 3] })).resolves.toBe(5);

      const begin = events.find((e) => e.kind === "eval.begin");
      const end = events.find((e) => e.kind === "eval.end");
      expect(begin).toBeTruthy();
      expect(end).toBeTruthy();
      expect(begin.args).toEqual([2, 3]);
      expect(JSON.stringify(begin)).not.toContain("a + b");
    } finally {
      await dw.close();
    }
  });

  test("emits import requested/resolved for named registered modules", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await dw.module.register("named:math", "export const n = 9;");
      await expect(dw.module.import("named:math")).resolves.toMatchObject({ n: 9 });

      const requested = events.find((e) => e.kind === "import.requested");
      const resolved = events.find((e) => e.kind === "import.resolved");
      expect(requested).toBeTruthy();
      expect(resolved).toBeTruthy();
      expect(Boolean(resolved.cacheHit)).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("emits handle create/call/dispose runtime events", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      const h = await dw.handle.eval(`(x) => x + 1`);
      await expect(h.call([7])).resolves.toBe(8);
      await h.dispose();

      expect(events.some((e) => e.kind === "handle.create")).toBe(true);
      expect(events.some((e) => e.kind === "handle.call.begin")).toBe(true);
      expect(events.some((e) => e.kind === "handle.call.end")).toBe(true);
      expect(events.some((e) => e.kind === "handle.dispose")).toBe(true);
    } finally {
      await dw.close();
    }
  });

  test("emits error.thrown for user-visible thrown eval errors", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.eval(`throw new Error(\"boom\")`)).rejects.toBeTruthy();
      const thrown = events.find((e) => e.kind === "error.thrown");
      expect(thrown).toBeTruthy();
      expect(thrown.surface).toBe("eval");
    } finally {
      await dw.close();
    }
  });

  test("emits module.eval begin/end and error.thrown for module eval errors", async () => {
    const dw = createTestWorker();
    const events: any[] = [];
    dw.on("runtime", (e) => events.push(e));

    try {
      await expect(dw.module.eval(`export const x = ;`)).rejects.toBeTruthy();
      const begin = events.find((e) => e.kind === "module.eval.begin");
      const end = events.find((e) => e.kind === "module.eval.end");
      const thrown = events.find((e) => e.kind === "error.thrown" && e.surface === "module.eval");
      expect(begin).toBeTruthy();
      expect(end).toBeTruthy();
      expect(end?.ok).toBe(false);
      expect(thrown).toBeTruthy();
      expect(String(thrown?.error?.message ?? "")).toContain("Code context (");
      expect(String(thrown?.error?.message ?? "")).toContain("^");
    } finally {
      await dw.close();
    }
  });

  test("module.import surfaces code context for registry module syntax errors", async () => {
    const dw = createTestWorker();

    try {
      await dw.module.register("named:broken", "export const bad = ;");
      await expect(dw.module.import("named:broken")).rejects.toThrow(/Code context \(/);
    } finally {
      await dw.close();
    }
  });

  test("module.import errors include code context for multiple stack frames", async () => {
    const dw = createTestWorker();

    try {
      expect.assertions(2);
      await dw.module.register(
        "named:stacked-error",
        `
          function a() { b(); }
          function b() { c(); }
          function c() { throw new Error("boom"); }
          a();
          export const ok = true;
        `,
      );
      try {
        await dw.module.import("named:stacked-error");
      } catch (e) {
        const msg = String((e as any)?.message ?? "");
        expect(msg).toMatch(/Code context \(/);
        const count = (msg.match(/Code context \(/g) || []).length;
        expect(count).toBeGreaterThanOrEqual(2);
      }
    } finally {
      await dw.close();
    }
  });
});
