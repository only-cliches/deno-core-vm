import { DenoWorker } from "../src/index";
import { createTestWorker } from "./helpers.worker-harness";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";

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
    dw = createTestWorker();
    const code = `
      export const x = 10;
      export const y = 10;
      export const out = x + y;
    `;
    await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 20 });
  });

  it("supports top-level await in modules", async () => {
    dw = createTestWorker();
    const code = `
      const v = await Promise.resolve(42);
      export const out = v;
    `;
    await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 42 });
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

        dw = createTestWorker({ cwd: dir, imports: true });

        const code = `
          import { x, add } from "./dep.js";
          export const out = add(x, 1);
        `;

        await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 4 });
      });
    },
    20_000
  );

  it(
    "module import failures surface as rejections",
    async () => {
      await withTempDir(async (dir) => {
        dw = createTestWorker({ cwd: dir, imports: true });

        const code = `
          import "./does_not_exist.js";
          export const out = 1;
        `;

        await expect(dw.module.eval(code)).rejects.toBeDefined();
      });
    },
    20_000
  );

  it("importModule loads through imports callback and returns callable namespace", async () => {
    const seen: string[] = [];
    dw = createTestWorker({
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
    });

    const mod = await dw.importModule("virtual:math");
    expect(seen).toContain("virtual:math");
    expect(mod.n).toBe(21);
    expect(mod.default).toBe("math-default");
    expect(mod.double(2)).toBe(4);
    await expect(mod.plusOneAsync(41)).resolves.toBe(42);
  });

  it("importModule propagates import rejection", async () => {
    dw = createTestWorker({ imports: false });
    await expect(dw.importModule("virtual:nope")).rejects.toBeDefined();
  });

  it("worker.module.register and worker.module.clear manage named modules", async () => {
    dw = createTestWorker();
    await dw.module.register("named:api", "export const v = 123;");
    await expect(dw.importModule("named:api")).resolves.toMatchObject({ v: 123 });
    await expect(dw.module.clear("named:api")).resolves.toBe(true);
    await expect(dw.importModule("named:api")).rejects.toBeDefined();
  });

  it("worker.module.eval can pin moduleName for future imports", async () => {
    dw = createTestWorker();
    const mod = await dw.module.eval("export const out = 77;", { moduleName: "named:pin" });
    expect(mod.out).toBe(77);
    await expect(dw.importModule("named:pin")).resolves.toMatchObject({ out: 77 });
  });

  it("constructor modules are registered during startup", async () => {
    dw = createTestWorker({
      modules: {
        "named:startup": "export const boot = 1;",
      },
    });
    await expect(dw.importModule("named:startup")).resolves.toMatchObject({ boot: 1 });
  });

  it("constructor modules are re-applied on restart", async () => {
    dw = createTestWorker({
      modules: {
        "named:restart": "export const v = 55;",
      },
    });
    await expect(dw.importModule("named:restart")).resolves.toMatchObject({ v: 55 });
    await expect(dw.module.clear("named:restart")).resolves.toBe(true);
    await expect(dw.importModule("named:restart")).rejects.toBeDefined();
    await dw.restart();
    await expect(dw.importModule("named:restart")).resolves.toMatchObject({ v: 55 });
  });

  test(
    "permissions.wasm=false blocks .wasm module loading",
    async () => {
      await withTempDir(async (dir) => {
        const wasmPath = path.join(dir, "mod.wasm");
        // Minimal valid wasm binary (magic + version).
        await fs.writeFile(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

        dw = createTestWorker({ cwd: dir, imports: true, permissions: { wasm: false } });
        const spec = pathToFileURL(wasmPath).href;
        await expect(dw.importModule(spec)).rejects.toThrow(
          /WASM module loading is disabled by permissions\.wasm/i
        );
      });
    },
    20_000
  );
});
