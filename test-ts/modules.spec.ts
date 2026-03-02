import { DenoWorker } from "../src/index";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

  it("supports top-level await in modules (when returning via moduleReturn)", async () => {
    dw = new DenoWorker();
    const code = `
      const v = await Promise.resolve(42);
      moduleReturn(v);
    `;
    await expect(dw.evalModule(code)).resolves.toBe(42);
  });

  it(
    "module can import relative files from disk when imports are enabled",
    async () => {
      await withTempDir(async (dir) => {
        await fs.writeFile(
          path.join(dir, "dep.js"),
          "export const x = 3; export function add(a,b){ return a+b; }\n",
          "utf8"
        );

        dw = new DenoWorker({ cwd: dir, imports: true } as any);

        const code = `
          import { x, add } from "./dep.js";
          moduleReturn(add(x, 1));
        `;

        await expect(dw.evalModule(code)).resolves.toBe(4);
      });
    },
    20_000
  );

  it(
    "module import failures surface as rejections",
    async () => {
      await withTempDir(async (dir) => {
        dw = new DenoWorker({ cwd: dir, imports: true } as any);

        const code = `
          import "./does_not_exist.js";
          moduleReturn(1);
        `;

        await expect(dw.evalModule(code)).rejects.toBeDefined();
      });
    },
    20_000
  );
});