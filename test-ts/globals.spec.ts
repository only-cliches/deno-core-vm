// test-ts/globals.spec.ts
import { DenoWorker } from "../src/index";
import { sleep } from "./helpers.time";
import { createTestWorker } from "./helpers.worker-harness";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("deno_worker: globals", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("sets primitive globals", async () => {
    dw = createTestWorker();
    await dw.setGlobal("myVar", 123);
    await expect(dw.eval("myVar")).resolves.toBe(123);
  });

  it("sets structured globals", async () => {
    dw = createTestWorker();
    await dw.setGlobal("config", { limits: { max: 100 } });
    await expect(dw.eval("config.limits.max")).resolves.toBe(100);
  });

  it("setGlobal overwrites existing globals", async () => {
    dw = createTestWorker();

    await dw.setGlobal("x", 1);
    await expect(dw.eval("x")).resolves.toBe(1);

    await dw.setGlobal("x", 2);
    await expect(dw.eval("x")).resolves.toBe(2);
  });

  it("setGlobal(undefined) becomes null inside the worker (wire format limitation)", async () => {
    dw = createTestWorker();

    await dw.setGlobal("u", undefined);
    await expect(dw.eval("u === null")).resolves.toBe(true);
  });

  it("injects sync functions and can call them", async () => {
    dw = createTestWorker();

    const double = jest.fn((x: number) => x * 2);
    await dw.setGlobal("double", double);

    await expect(dw.eval("double(5)")).resolves.toBe(10);
    expect(double).toHaveBeenCalledWith(5);
  });

  it("sync host functions that return Promises still work via async fallback", async () => {
    dw = createTestWorker();

    const plusOneLater = jest.fn((x: number) => Promise.resolve(x + 1));
    await dw.setGlobal("plusOneLater", plusOneLater);

    await expect(dw.eval("plusOneLater(41)")).resolves.toBe(42);
    expect(plusOneLater).toHaveBeenCalledWith(41);
  });

  it("host function exceptions are propagated as rejections", async () => {
    dw = createTestWorker();

    const boom = jest.fn(() => {
      throw new Error("boom");
    });

    await dw.setGlobal("boom", boom);

    await expect(dw.eval("boom()")).rejects.toThrow("boom");
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("injects async functions and can await them", async () => {
    dw = createTestWorker();

    const addAsync = jest.fn(async (x: number) => {
      await sleep(25);
      return x + 1;
    });

    await dw.setGlobal("addAsync", addAsync);

    await expect(dw.eval("addAsync(10)")).resolves.toBe(11);
    expect(addAsync).toHaveBeenCalledWith(10);
  });

  it("supports constructor globals for values, objects, and functions", async () => {
    dw = createTestWorker({
      globals: {
        someFn: (x: number) => x + 1,
        anotherFn: async (x: number) => x + 2,
        value: 22,
        nested: { key: true },
      },
    });

    await expect(dw.eval("value")).resolves.toBe(22);
    await expect(dw.eval("nested.key")).resolves.toBe(true);
    await expect(dw.eval("someFn(41)")).resolves.toBe(42);
    await expect(dw.eval("(async () => await anotherFn(40))()")).resolves.toBe(42);
  });

  it("injects Node module objects with callable methods (e.g. fs)", async () => {
    dw = createTestWorker();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-fs-"));
    const filePath = path.join(dir, "hello.txt");

    try {
      await fs.writeFile(filePath, "hello from node fs", "utf8");

      await dw.setGlobal("fs", nodeFs);
      await dw.setGlobal("filePath", filePath);

      await expect(dw.eval(`fs.readFileSync(filePath, "utf8")`)).resolves.toBe("hello from node fs");
      await expect(dw.eval(`(async () => await fs.promises.readFile(filePath, "utf8"))()`)).resolves.toBe(
        "hello from node fs",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
