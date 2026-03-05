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
      await expect(dw.importModule("named:math")).resolves.toMatchObject({ n: 9 });

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
});
