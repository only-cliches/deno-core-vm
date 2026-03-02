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

  it("evaluates ES modules and returns namespace exports", async () => {
    dw = new DenoWorker();
    const code = `
      export const x = 10;
      export const y = 10;
      export const out = x + y;
    `;
    await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 20 });
  });

  it("supports top-level await in modules", async () => {
    dw = new DenoWorker();
    const code = `
      const v = await Promise.resolve(42);
      export const out = v;
    `;
    await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 42 });
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
          export const out = add(x, 1);
        `;

        await expect(dw.evalModule(code)).resolves.toMatchObject({ out: 4 });
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
          export const out = 1;
        `;

        await expect(dw.evalModule(code)).rejects.toBeDefined();
      });
    },
    20_000
  );

  it("getModule loads through imports callback and returns callable namespace", async () => {
    const seen: string[] = [];
    dw = new DenoWorker({
      imports: (specifier: string) => {
        seen.push(specifier);
        if (specifier === "virtual:math") {
          return {
            js: `
              export const n = 21;
              export function double(x) { return x * 2; }
              export async function plusOneAsync(x) { return x + 1; }
              export default "math-default";
            `,
          };
        }
        return false;
      },
    } as any);

    const mod = await dw.getModule("virtual:math");
    expect(seen).toContain("virtual:math");
    expect(mod.n).toBe(21);
    expect(mod.default).toBe("math-default");
    expect(mod.double(2)).toBe(4);
    await expect(mod.plusOneAsync(41)).resolves.toBe(42);
  });

  it("getModule propagates import rejection", async () => {
    dw = new DenoWorker({ imports: false } as any);
    await expect(dw.getModule("virtual:nope")).rejects.toBeDefined();
  });
});
