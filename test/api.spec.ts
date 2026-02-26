import { DenoWorker } from "../index";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("DenoWorker API", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = new DenoWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("eval evaluates basic expressions", async () => {
    await expect(dw.eval("1 + 1")).resolves.toBe(2);
    await expect(dw.eval('"Hello" + " " + "World"')).resolves.toBe("Hello World");
    await expect(dw.eval('({ a: 1, b: "test" })')).resolves.toEqual({ a: 1, b: "test" });
  });

  test("evalSync evaluates synchronously", () => {
    expect(dw.evalSync("1 + 2")).toBe(3);
  });

  test("captures lastExecutionStats when available", async () => {
    await dw.eval("1 + 1");
    expect(dw.lastExecutionStats).toBeDefined();
    expect(dw.lastExecutionStats).toHaveProperty("cpuTimeMs");
    expect(dw.lastExecutionStats).toHaveProperty("evalTimeMs");
  });

  test("module evaluation works (evalModule)", async () => {
    const code = `
      export function add(a, b) { return a + b; }
      moduleReturn(add(10, 10));
    `;
    await expect(dw.evalModule(code)).resolves.toBe(20);
  });

  test("timeout limits: long-running script rejects", async () => {
    jest.setTimeout(15_000);

    // If your native constructor does not yet accept options, instantiate via whatever
    // option path your JS wrapper supports. This assumes you will wire options later.
    const limited = new DenoWorker({ maxEvalMs: 50 } as any);

    try {
      await expect(limited.eval("while (true) {}")).rejects.toBeTruthy();
    } finally {
      if (!limited.isClosed()) await limited.close();
    }
  });

  test("close triggers onClose", async () => {
    const events: string[] = [];
    dw.on("close", () => events.push("close"));

    await dw.close();
    await sleep(25);

    expect(events).toContain("close");
    expect(dw.isClosed()).toBe(true);
  });
});