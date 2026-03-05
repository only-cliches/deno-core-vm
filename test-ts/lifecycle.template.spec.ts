import { DenoWorkerTemplate } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";

describe("DenoWorker lifecycle hooks + templates", () => {
  test("lifecycle hooks fire in deterministic order for normal start/stop", async () => {
    const phases: string[] = [];
    const dw = createTestWorker({
      lifecycle: {
        beforeStart: () => phases.push("beforeStart"),
        afterStart: () => phases.push("afterStart"),
        beforeStop: () => phases.push("beforeStop"),
        afterStop: () => phases.push("afterStop"),
        onCrash: () => phases.push("onCrash"),
      },
    });

    await dw.eval("1 + 1");
    await dw.close();

    expect(phases).toEqual(["beforeStart", "afterStart", "beforeStop", "afterStop"]);
  });

  test("restart emits stop/start lifecycle sequence without crash", async () => {
    const phases: string[] = [];
    const dw = createTestWorker({
      lifecycle: {
        beforeStart: () => phases.push("beforeStart"),
        afterStart: () => phases.push("afterStart"),
        beforeStop: () => phases.push("beforeStop"),
        afterStop: () => phases.push("afterStop"),
        onCrash: () => phases.push("onCrash"),
      },
    });

    await dw.restart();
    await dw.close();

    expect(phases).toEqual([
      "beforeStart",
      "afterStart",
      "beforeStop",
      "afterStop",
      "beforeStart",
      "afterStart",
      "beforeStop",
      "afterStop",
    ]);
  });

  test("template preloads globals and bootstrap scripts/modules", async () => {
    const template = new DenoWorkerTemplate({
      globals: { BASE_A: 2 },
      bootstrapScripts: `globalThis.BASE_B = 3;`,
      bootstrapModules: `globalThis.BASE_C = 4; export const _ok = true;`,
    });

    const dw = await template.create();
    try {
      await expect(dw.eval("BASE_A + BASE_B + BASE_C")).resolves.toBe(9);
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("template create overrides are isolated per worker", async () => {
    const template = new DenoWorkerTemplate({
      globals: { SHARED: "base" },
      bootstrapScripts: `globalThis.LOCAL_COUNTER = 1;`,
    });

    const dw1 = await template.create({
      globals: { OVERRIDE: "one" },
      bootstrapScripts: `globalThis.LOCAL_COUNTER = 11;`,
    });
    const dw2 = await template.create({
      globals: { OVERRIDE: "two" },
      bootstrapScripts: `globalThis.LOCAL_COUNTER = 22;`,
    });

    try {
      await expect(dw1.eval(`({ shared: SHARED, override: OVERRIDE, counter: LOCAL_COUNTER })`)).resolves.toEqual({
        shared: "base",
        override: "one",
        counter: 11,
      });

      await expect(dw2.eval(`({ shared: SHARED, override: OVERRIDE, counter: LOCAL_COUNTER })`)).resolves.toEqual({
        shared: "base",
        override: "two",
        counter: 22,
      });
    } finally {
      if (!dw1.isClosed()) await dw1.close();
      if (!dw2.isClosed()) await dw2.close();
    }
  });
});
