import { DenoWorker } from "../src/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("deno_worker: globals", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("sets primitive globals", async () => {
    dw = new DenoWorker();
    await dw.setGlobal("myVar", 123);
    await expect(dw.eval("myVar")).resolves.toBe(123);
  });

  it("sets structured globals", async () => {
    dw = new DenoWorker();
    await dw.setGlobal("config", { limits: { max: 100 } });
    await expect(dw.eval("config.limits.max")).resolves.toBe(100);
  });

  it("injects sync functions and can call them", async () => {
    dw = new DenoWorker();

    const double = jest.fn((x: number) => x * 2);
    await dw.setGlobal("double", double);

    await expect(dw.eval("double(5)")).resolves.toBe(10);
    expect(double).toHaveBeenCalledWith(5);
  });

  it("injects async functions and can await them", async () => {
    dw = new DenoWorker();

    const addAsync = jest.fn(async (x: number) => {
      await sleep(25);
      return x + 1;
    });

    await dw.setGlobal("addAsync", addAsync);

    await expect(dw.eval("addAsync(10)")).resolves.toBe(11);
    expect(addAsync).toHaveBeenCalledWith(10);
  });
});