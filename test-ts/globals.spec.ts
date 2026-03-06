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
    await dw.global.set("myVar", 123);
    await expect(dw.eval("myVar")).resolves.toBe(123);
  });

  it("sets structured globals", async () => {
    dw = createTestWorker();
    await dw.global.set("config", { limits: { max: 100 } });
    await expect(dw.eval("config.limits.max")).resolves.toBe(100);
  });

  it("global.set overwrites existing globals", async () => {
    dw = createTestWorker();

    await dw.global.set("x", 1);
    await expect(dw.eval("x")).resolves.toBe(1);

    await dw.global.set("x", 2);
    await expect(dw.eval("x")).resolves.toBe(2);
  });

  it("global.set(undefined) becomes null inside the worker (wire format limitation)", async () => {
    dw = createTestWorker();

    await dw.global.set("u", undefined);
    await expect(dw.eval("u === null")).resolves.toBe(true);
  });

  it("injects sync functions and can call them", async () => {
    dw = createTestWorker();

    const double = jest.fn((x: number) => x * 2);
    await dw.global.set("double", double);

    await expect(dw.eval("double(5)")).resolves.toBe(10);
    expect(double).toHaveBeenCalledWith(5);
  });

  it("global.get reads values from globalThis paths", async () => {
    dw = createTestWorker();
    await dw.global.set("cfg", { nested: { answer: 42 } });
    await expect(dw.global.get("cfg.nested.answer")).resolves.toBe(42);
  });

  it("global.call invokes global functions by path", async () => {
    dw = createTestWorker();
    await dw.global.set("mathTools", { add: (a: number, b: number) => a + b });
    await expect(dw.global.call("mathTools.add", [20, 22])).resolves.toBe(42);
  });

  it("mirrors handle APIs on worker.global", async () => {
    dw = createTestWorker();
    await dw.global.set("cfg", { nested: { answer: 41 } });

    await expect(dw.global.has("cfg.nested.answer")).resolves.toBe(true);
    await expect(dw.global.getType("cfg.nested.answer")).resolves.toMatchObject({ type: "number" });

    await expect(dw.global.set("cfg.nested.answer", 42)).resolves.toBeUndefined();
    await expect(
      dw.global.define("cfg.nested.answerDefined", { value: 77, configurable: true, enumerable: true, writable: true }),
    ).resolves.toBe(true);
    await expect(dw.global.get<number>("cfg.nested.answer")).resolves.toBe(42);
    await expect(dw.global.get<number>("cfg.nested.answerDefined")).resolves.toBe(77);
    await expect(dw.global.getOwnPropertyDescriptor("cfg.nested.answer")).resolves.toMatchObject({ value: 42 });

    await expect(dw.global.keys("cfg.nested")).resolves.toEqual(["answer", "answerDefined"]);
    await expect(dw.global.entries("cfg.nested")).resolves.toEqual([
      ["answer", 42],
      ["answerDefined", 77],
    ]);
    await expect(dw.global.toJSON<{ answer: number; answerDefined: number }>("cfg.nested")).resolves.toEqual({
      answer: 42,
      answerDefined: 77,
    });

    await expect(dw.global.set("mathTools", { add: (a: number, b: number) => a + b })).resolves.toBeUndefined();
    await expect(dw.global.isCallable("mathTools.add")).resolves.toBe(true);
    await expect(dw.global.call<number>("mathTools.add", [1, 2])).resolves.toBe(3);
    await expect(dw.global.apply<any[]>("mathTools", [{ op: "call", path: "add", args: [20, 22] }])).resolves.toEqual([42]);

    await expect(dw.global.construct<Date>("Date", [])).resolves.toBeInstanceOf(Date);

    await expect(dw.eval("globalThis.pending = Promise.resolve(99)")).resolves.toBe(99);
    await expect(dw.global.isPromise("pending")).resolves.toBe(true);
    await expect(dw.global.await<number>("pending")).resolves.toBe(99);

    await expect(dw.eval("globalThis.now = new Date()")).resolves.toBeDefined();
    await expect(dw.global.instanceOf("now", "Date")).resolves.toBe(true);

    const cloned = await dw.global.clone("cfg.nested");
    await expect(cloned.get("answer")).resolves.toEqual(expect.any(Number));
    await cloned.dispose();

    await expect(dw.global.delete("cfg.nested.answer")).resolves.toBe(true);
    await expect(dw.global.has("cfg.nested.answer")).resolves.toBe(false);
  });

  it("sync host functions that return Promises still work via async fallback", async () => {
    dw = createTestWorker();

    const plusOneLater = jest.fn((x: number) => Promise.resolve(x + 1));
    await dw.global.set("plusOneLater", plusOneLater);

    await expect(dw.eval("plusOneLater(41)")).resolves.toBe(42);
    expect(plusOneLater).toHaveBeenCalledWith(41);
  });

  it("host function exceptions are propagated as rejections", async () => {
    dw = createTestWorker();

    const boom = jest.fn(() => {
      throw new Error("boom");
    });

    await dw.global.set("boom", boom);

    await expect(dw.eval("boom()")).rejects.toThrow("boom");
    expect(boom).toHaveBeenCalledTimes(1);
  });

  it("injects async functions and can await them", async () => {
    dw = createTestWorker();

    const addAsync = jest.fn(async (x: number) => {
      await sleep(25);
      return x + 1;
    });

    await dw.global.set("addAsync", addAsync);

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

      await dw.global.set("fs", nodeFs);
      await dw.global.set("filePath", filePath);

      await expect(dw.eval(`fs.readFileSync(filePath, "utf8")`)).resolves.toBe("hello from node fs");
      await expect(dw.eval(`(async () => await fs.promises.readFile(filePath, "utf8"))()`)).resolves.toBe(
        "hello from node fs",
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
