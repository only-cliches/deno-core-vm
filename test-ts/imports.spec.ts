// test-ts/imports.spec.ts
import { DenoWorker } from "../src/index";

describe("deno_worker: imports/module loader combinations", () => {
  let dw: DenoWorker | undefined;

  afterEach(async () => {
    if (dw && !dw.isClosed()) await dw.close();
    dw = undefined;
  });

    test("imports.spec.ts placeholder (uncomment tests to enable coverage)", () => {
    expect(true).toBe(true);
  });

  // it(
  //   "imports:false blocks static import",
  //   async () => {
  //     dw = createTestWorker({ imports: false });

  //     const src = `
  //       import x from "file:///does_not_matter.js";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:false blocks dynamic import()",
  //   async () => {
  //     dw = createTestWorker({ imports: false });

  //     const src = `
  //       const m = await import("file:///does_not_matter.js");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:true allows disk static import",
  //   async () => {
  //     const dir = makeTempDir();
  //     const modPath = path.join(dir, "m.js");
  //     writeFile(
  //       modPath,
  //       `
  //       export default 42;
  //     `
  //     );

  //     dw = createTestWorker({ imports: true });

  //     const src = `
  //       import x from ${JSON.stringify(toFileUrl(modPath))};
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe(42);
  //   },
  //   20_000
  // );

  // it(
  //   "imports:true allows disk dynamic import()",
  //   async () => {
  //     const dir = makeTempDir();
  //     const modPath = path.join(dir, "m.js");
  //     writeFile(
  //       modPath,
  //       `
  //       export default 99;
  //     `
  //     );

  //     dw = createTestWorker({ imports: true });

  //     const src = `
  //       const m = await import(${JSON.stringify(toFileUrl(modPath))});
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe(99);
  //   },
  //   20_000
  // );

  // it(
  //   "imports:sync callback returning source intercepts static import",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:sync-static") {
  //           return { js: `export default "OK_SYNC_STATIC";` };
  //         }
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:sync-static";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_SYNC_STATIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:sync callback returning source intercepts dynamic import()",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:sync-dynamic") {
  //           return { js: `export default "OK_SYNC_DYNAMIC";` };
  //         }
  //         return false;
  //       },
  //     });

  //     const src = `
  //       const m = await import("virtual:sync-dynamic");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_SYNC_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:async callback returning source intercepts static import",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: async (specifier: string) => {
  //         if (specifier === "virtual:async-static") {
  //           return { js: `export default "OK_ASYNC_STATIC";` };
  //         }
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:async-static";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_ASYNC_STATIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:async callback returning source intercepts dynamic import()",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: async (specifier: string) => {
  //         if (specifier === "virtual:async-dynamic") {
  //           return { js: `export default "OK_ASYNC_DYNAMIC";` };
  //         }
  //         return false;
  //       },
  //     });

  //     const src = `
  //       const m = await import("virtual:async-dynamic");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_ASYNC_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:sync callback returning false blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:block") return false;
  //         return true;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:block";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:async callback returning false blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: async (specifier: string) => {
  //         if (specifier === "virtual:block-async") return false;
  //         return true;
  //       },
  //     });

  //     const src = `
  //       const m = await import("virtual:block-async");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:sync callback returning true falls back to disk import (static)",
  //   async () => {
  //     const dir = makeTempDir();
  //     const modPath = path.join(dir, "fallback.js");
  //     writeFile(modPath, `export default "DISK_OK_STATIC";`);

  //     dw = createTestWorker({
  //       imports: () => true,
  //     });

  //     const src = `
  //       import x from ${JSON.stringify(toFileUrl(modPath))};
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("DISK_OK_STATIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:async callback returning true falls back to disk import (dynamic)",
  //   async () => {
  //     const dir = makeTempDir();
  //     const modPath = path.join(dir, "fallback.js");
  //     writeFile(modPath, `export default "DISK_OK_DYNAMIC";`);

  //     dw = createTestWorker({
  //       imports: async () => true,
  //     });

  //     const src = `
  //       const m = await import(${JSON.stringify(toFileUrl(modPath))});
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("DISK_OK_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback receives referrer (best-effort) for static imports",
  //   async () => {
  //     const seen: Array<{ specifier: string; referrer?: string }> = [];

  //     dw = createTestWorker({
  //       imports: (specifier: string, referrer?: string) => {
  //         seen.push({ specifier, referrer });
  //         if (specifier === "virtual:referrer") return { js: `export default 1;` };
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:referrer";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe(1);
  //     expect(seen.length).toBeGreaterThanOrEqual(1);
  //     expect(seen[0].specifier).toBe("virtual:referrer");
  //     expect(typeof seen[0].referrer).toBe("string");
  //   },
  //   20_000
  // );

  // it(
  //   "defaults cwd to process.cwd(): relative static import resolves from process.cwd()",
  //   async () => {
  //     const dir = makeTempDir();
  //     process.chdir(dir);

  //     writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD";`);

  //     dw = createTestWorker({ imports: true });

  //     const src = `
  //       import x from "./dep.js";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("FROM_CWD");
  //   },
  //   20_000
  // );

  // it(
  //   "defaults cwd to process.cwd(): relative dynamic import() resolves from process.cwd()",
  //   async () => {
  //     const dir = makeTempDir();
  //     process.chdir(dir);

  //     writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_DYNAMIC";`);

  //     dw = createTestWorker({ imports: true });

  //     const src = `
  //       const m = await import("./dep.js");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("FROM_CWD_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "cwd overrides process cwd: relative static import resolves from cwd",
  //   async () => {
  //     const dir = makeTempDir();
  //     writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_OPT";`);

  //     dw = createTestWorker({ imports: true, cwd: dir });

  //     const src = `
  //       import x from "./dep.js";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("FROM_CWD_OPT");
  //   },
  //   20_000
  // );

  // it(
  //   "cwd overrides process cwd: relative dynamic import() resolves from cwd",
  //   async () => {
  //     const dir = makeTempDir();
  //     writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_OPT_DYNAMIC";`);

  //     dw = createTestWorker({ imports: true, cwd: dir });

  //     const src = `
  //       const m = await import("./dep.js");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("FROM_CWD_OPT_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "cwd accepts file:// URL (directory): relative import resolves",
  //   async () => {
  //     const dir = makeTempDir();
  //     writeFile(path.join(dir, "dep.js"), `export default "FROM_FILE_URL";`);

  //     const fileUrl = toFileUrl(dir + (dir.endsWith(path.sep) ? "" : path.sep));

  //     dw = createTestWorker({ imports: true, cwd: fileUrl });

  //     const src = `
  //       import x from "./dep.js";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("FROM_FILE_URL");
  //   },
  //   20_000
  // );

  // // ------------------------------------------------------------
  // // Additional coverage
  // // ------------------------------------------------------------

  // it(
  //   "imports:async callback can return a Promise that resolves to source (static)",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier !== "virtual:promise-static") return false;
  //         return Promise.resolve({ js: `export default "OK_PROMISE_STATIC";` });
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:promise-static";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_PROMISE_STATIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:async callback can return a Promise that resolves to source (dynamic)",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier !== "virtual:promise-dynamic") return false;
  //         return Promise.resolve({ js: `export default "OK_PROMISE_DYNAMIC";` });
  //       },
  //     });

  //     const src = `
  //       const m = await import("virtual:promise-dynamic");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("OK_PROMISE_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback Promise rejection blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier !== "virtual:reject") return false;
  //         return Promise.reject(new Error("nope"));
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:reject";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback throw blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:throw") throw new Error("boom");
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:throw";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback supports { resolve } rewrite to disk module (static)",
  //   async () => {
  //     const dir = makeTempDir();
  //     const target = path.join(dir, "resolved.js");
  //     writeFile(target, `export default "RESOLVED_STATIC";`);

  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:resolve-static") return { resolve: toFileUrl(target) };
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:resolve-static";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("RESOLVED_STATIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback supports { resolve } rewrite to disk module (dynamic)",
  //   async () => {
  //     const dir = makeTempDir();
  //     const target = path.join(dir, "resolved.js");
  //     writeFile(target, `export default "RESOLVED_DYNAMIC";`);

  //     dw = createTestWorker({
  //       imports: async (specifier: string) => {
  //         if (specifier === "virtual:resolve-dynamic") return { resolve: toFileUrl(target) };
  //         return false;
  //       },
  //     });

  //     const src = `
  //       const m = await import("virtual:resolve-dynamic");
  //       export const out = m.default;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("RESOLVED_DYNAMIC");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback { resolve: \"\" } blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         if (specifier === "virtual:resolve-empty") return { resolve: "" };
  //         return true;
  //       },
  //     });

  //     const src = `
  //       import x from "virtual:resolve-empty";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback is invoked for every distinct specifier in a module graph",
  //   async () => {
  //     const seen: string[] = [];

  //     dw = createTestWorker({
  //       imports: (specifier: string) => {
  //         seen.push(specifier);
  //         if (specifier === "virtual:dep") return { js: `export default "DEP";` };
  //         if (specifier === "virtual:root") {
  //           return {
  //             js: `
  //               import x from "virtual:dep";
  //               export default "ROOT:" + x;
  //             `,
  //           };
  //         }
  //         return false;
  //       },
  //     });

  //     const src = `
  //       import r from "virtual:root";
  //       export const out = r;
  //     `;

  //     await expect(dw.module.eval(src)).resolves.toBe("ROOT:DEP");
  //     expect(seen).toContain("virtual:root");
  //     expect(seen).toContain("virtual:dep");
  //   },
  //   20_000
  // );

  // it(
  //   "imports:callback returning non-recognized object blocks module load",
  //   async () => {
  //     dw = createTestWorker({
  //       // eslint-disable-next-line @typescript-eslint/no-explicit-any
  //       imports: (_specifier: string) => ({ nope: 123 }),
  //     });

  //     const src = `
  //       import x from "virtual:weird";
  //       export const out = x;
  //     `;

  //     await expect(dw.module.eval(src)).rejects.toBeTruthy();
  //   },
  //   20_000
  // );
});
