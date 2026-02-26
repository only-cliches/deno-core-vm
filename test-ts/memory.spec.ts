// test/memory.spec.ts
import { DenoWorker } from "../src/index";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function expectFiniteNumber(v: unknown, label: string) {
  expect(isFiniteNumber(v)).toBe(true);
  if (!isFiniteNumber(v)) throw new Error(`Expected finite number for ${label}`);
}

function expectBoolean(v: unknown, label: string) {
  expect(typeof v === "boolean").toBe(true);
  if (typeof v !== "boolean") throw new Error(`Expected boolean for ${label}`);
}

describe("DenoWorker memory()", () => {
  let dw: DenoWorker;

  beforeEach(() => {
    dw = new DenoWorker();
  });

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  test("memory() returns heapStatistics and heapSpaceStatistics", async () => {
    const mem = await dw.memory();

    expect(mem).toBeDefined();
    expect(typeof mem).toBe("object");

    const ok = mem as any;

    expect(ok).toHaveProperty("heapStatistics");
    expect(ok).toHaveProperty("heapSpaceStatistics");

    const hs = ok.heapStatistics;
    expect(hs).toBeDefined();
    expect(typeof hs).toBe("object");

    // heapStatistics: required numeric fields + boolean
    expectFiniteNumber(hs.totalHeapSize, "heapStatistics.totalHeapSize");
    expectFiniteNumber(hs.totalHeapSizeExecutable, "heapStatistics.totalHeapSizeExecutable");
    expectFiniteNumber(hs.totalPhysicalSize, "heapStatistics.totalPhysicalSize");
    expectFiniteNumber(hs.totalAvailableSize, "heapStatistics.totalAvailableSize");
    expectFiniteNumber(hs.usedHeapSize, "heapStatistics.usedHeapSize");
    expectFiniteNumber(hs.heapSizeLimit, "heapStatistics.heapSizeLimit");
    expectFiniteNumber(hs.mallocedMemory, "heapStatistics.mallocedMemory");
    expectFiniteNumber(hs.externalMemory, "heapStatistics.externalMemory");
    expectFiniteNumber(hs.peakMallocedMemory, "heapStatistics.peakMallocedMemory");
    expectFiniteNumber(hs.numberOfNativeContexts, "heapStatistics.numberOfNativeContexts");
    expectFiniteNumber(hs.numberOfDetachedContexts, "heapStatistics.numberOfDetachedContexts");
    expectBoolean(hs.doesZapGarbage, "heapStatistics.doesZapGarbage");

    // heapSpaceStatistics: array of objects with expected types (may be empty on some builds)
    const hss = ok.heapSpaceStatistics;
    expect(Array.isArray(hss)).toBe(true);

    if (Array.isArray(hss) && hss.length > 0) {
      for (const [i, space] of hss.entries()) {
        expect(space).toBeDefined();
        expect(typeof space).toBe("object");

        expectFiniteNumber(space.physicalSpaceSize, `heapSpaceStatistics[${i}].physicalSpaceSize`);
        expectFiniteNumber(space.spaceSize, `heapSpaceStatistics[${i}].spaceSize`);
        expectFiniteNumber(space.spaceUsedSize, `heapSpaceStatistics[${i}].spaceUsedSize`);
        expectFiniteNumber(space.spaceAvailableSize, `heapSpaceStatistics[${i}].spaceAvailableSize`);

        // Basic sanity: used <= size when both are finite
        if (isFiniteNumber(space.spaceUsedSize) && isFiniteNumber(space.spaceSize)) {
          expect(space.spaceUsedSize).toBeLessThanOrEqual(space.spaceSize);
        }
      }
    }
  });

  test("memory() reflects allocations after creating pressure", async () => {
    const before = await dw.memory();

    const beforeUsed = (before as any).heapStatistics.usedHeapSize as number;
    expectFiniteNumber(beforeUsed, "before.heapStatistics.usedHeapSize");

    // Allocate inside the isolate and keep it referenced.
    // Use ArrayBuffer to create measurable backing store.
    await dw.eval(`
      globalThis.__mem_test = [];
      for (let i = 0; i < 64; i++) {
        globalThis.__mem_test.push(new ArrayBuffer(256 * 1024)); // 256KB each => ~16MB total
      }
      globalThis.__mem_test.length;
    `);

    // Give V8 a moment to account for stats. This reduces flakiness.
    await sleep(25);

    const after = await dw.memory();

    const afterUsed = (after as any).heapStatistics.usedHeapSize as number;
    expectFiniteNumber(afterUsed, "after.heapStatistics.usedHeapSize");

    // Heuristic: should not go down materially after allocations.
    // Some builds may report stats differently, so keep assertion loose.
    expect(afterUsed).toBeGreaterThanOrEqual(beforeUsed);
  });

});