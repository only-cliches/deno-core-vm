import { DenoWorker } from "../src/index";

describe("deno_worker: modules", () => {
  let dw: DenoWorker;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
  });

  it("evaluates ES modules and returns via moduleReturn", async () => {
    dw = new DenoWorker();
    const code = `
      export const x = 10;
      export const y = 10;
      moduleReturn(x + y);
    `;
    await expect(dw.evalModule(code)).resolves.toBe(20);
  });
});