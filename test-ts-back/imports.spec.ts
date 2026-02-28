// test-ts/imports.spec.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DenoWorker } from "../src/index";

function makeTempDir(prefix = "deno-core-vm-imports-") {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(p: string, content: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
}

describe("deno_worker: imports/module loader combinations", () => {
    let dw: DenoWorker | undefined;

    afterEach(async () => {
        if (dw && !dw.isClosed()) await dw.close();
        dw = undefined;
    });

    it(
        "imports:false blocks static import",
        async () => {
            dw = new DenoWorker({ imports: false });

            const src = `
        import x from "file:///does_not_matter.js";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).rejects.toBeTruthy();
        },
        20_000
    );

    it(
        "imports:false blocks dynamic import()",
        async () => {
            dw = new DenoWorker({ imports: false });

            const src = `
        const m = await import("file:///does_not_matter.js");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).rejects.toBeTruthy();
        },
        20_000
    );

    it(
        "imports:true allows disk static import",
        async () => {
            const dir = makeTempDir();
            const modPath = path.join(dir, "m.js");
            writeFile(
                modPath,
                `
        export default 42;
      `
            );

            dw = new DenoWorker({ imports: true });

            const src = `
        import x from ${JSON.stringify("file://" + modPath)};
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe(42);
        },
        20_000
    );

    it(
        "imports:true allows disk dynamic import()",
        async () => {
            const dir = makeTempDir();
            const modPath = path.join(dir, "m.js");
            writeFile(
                modPath,
                `
        export default 99;
      `
            );

            dw = new DenoWorker({ imports: true });

            const src = `
        const m = await import(${JSON.stringify("file://" + modPath)});
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe(99);
        },
        20_000
    );

    it(
        "imports:sync callback returning string intercepts static import",
        async () => {
            dw = new DenoWorker({
                imports: (specifier: string) => {
                    if (specifier === "virtual:sync-static") {
                        return `export default "OK_SYNC_STATIC";`;
                    }
                    return false;
                },
            });

            const src = `
        import x from "virtual:sync-static";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("OK_SYNC_STATIC");
        },
        20_000
    );

    it(
        "imports:sync callback returning string intercepts dynamic import()",
        async () => {
            dw = new DenoWorker({
                imports: (specifier: string) => {
                    if (specifier === "virtual:sync-dynamic") {
                        return `export default "OK_SYNC_DYNAMIC";`;
                    }
                    return false;
                },
            });

            const src = `
        const m = await import("virtual:sync-dynamic");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("OK_SYNC_DYNAMIC");
        },
        20_000
    );

    it(
        "imports:async callback returning string intercepts static import",
        async () => {
            dw = new DenoWorker({
                imports: async (specifier: string) => {
                    if (specifier === "virtual:async-static") {
                        return `export default "OK_ASYNC_STATIC";`;
                    }
                    return false;
                },
            });

            const src = `
        import x from "virtual:async-static";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("OK_ASYNC_STATIC");
        },
        20_000
    );

    it(
        "imports:async callback returning string intercepts dynamic import()",
        async () => {
            dw = new DenoWorker({
                imports: async (specifier: string) => {
                    if (specifier === "virtual:async-dynamic") {
                        return `export default "OK_ASYNC_DYNAMIC";`;
                    }
                    return false;
                },
            });

            const src = `
        const m = await import("virtual:async-dynamic");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("OK_ASYNC_DYNAMIC");
        },
        20_000
    );

    it(
        "imports:sync callback returning false blocks module load",
        async () => {
            dw = new DenoWorker({
                imports: (specifier: string) => {
                    if (specifier === "virtual:block") return false;
                    return true;
                },
            });

            const src = `
        import x from "virtual:block";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).rejects.toBeTruthy();
        },
        20_000
    );

    it(
        "imports:async callback returning false blocks module load",
        async () => {
            dw = new DenoWorker({
                imports: async (specifier: string) => {
                    if (specifier === "virtual:block-async") return false;
                    return true;
                },
            });

            const src = `
        const m = await import("virtual:block-async");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).rejects.toBeTruthy();
        },
        20_000
    );

    it(
        "imports:sync callback returning true falls back to disk import (static)",
        async () => {
            const dir = makeTempDir();
            const modPath = path.join(dir, "fallback.js");
            writeFile(modPath, `export default "DISK_OK_STATIC";`);

            dw = new DenoWorker({
                imports: () => true,
            });

            const src = `
        import x from ${JSON.stringify("file://" + modPath)};
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("DISK_OK_STATIC");
        },
        20_000
    );

    it(
        "imports:async callback returning true falls back to disk import (dynamic)",
        async () => {
            const dir = makeTempDir();
            const modPath = path.join(dir, "fallback.js");
            writeFile(modPath, `export default "DISK_OK_DYNAMIC";`);

            dw = new DenoWorker({
                imports: async () => true,
            });

            const src = `
        const m = await import(${JSON.stringify("file://" + modPath)});
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("DISK_OK_DYNAMIC");
        },
        20_000
    );

    it(
        "imports:callback receives referrer (best-effort) for static imports",
        async () => {
            const seen: Array<{ specifier: string; referrer?: string }> = [];

            dw = new DenoWorker({
                imports: (specifier: string, referrer?: string) => {
                    seen.push({ specifier, referrer });
                    if (specifier === "virtual:referrer") return `export default 1;`;
                    return false;
                },
            });

            const src = `
        import x from "virtual:referrer";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe(1);
            expect(seen.length).toBeGreaterThanOrEqual(1);
            expect(seen[0].specifier).toBe("virtual:referrer");
            expect(typeof seen[0].referrer).toBe("string");
        },
        20_000
    );

    it(
        "defaults cwd to process.cwd(): relative static import resolves from process.cwd()",
        async () => {
            const dir = makeTempDir();
            process.chdir(dir);

            writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD";`);

            dw = new DenoWorker({ imports: true });

            const src = `
        import x from "./dep.js";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("FROM_CWD");
        },
        20_000
    );

    it(
        "defaults cwd to process.cwd(): relative dynamic import() resolves from process.cwd()",
        async () => {
            const dir = makeTempDir();
            process.chdir(dir);

            writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_DYNAMIC";`);

            dw = new DenoWorker({ imports: true });

            const src = `
        const m = await import("./dep.js");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("FROM_CWD_DYNAMIC");
        },
        20_000
    );

    it(
        "cwd overrides process cwd: relative static import resolves from cwd",
        async () => {
            const dir = makeTempDir();
            writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_OPT";`);

            dw = new DenoWorker({ imports: true, cwd: dir });

            const src = `
        import x from "./dep.js";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("FROM_CWD_OPT");
        },
        20_000
    );

    it(
        "cwd overrides process cwd: relative dynamic import() resolves from cwd",
        async () => {
            const dir = makeTempDir();
            writeFile(path.join(dir, "dep.js"), `export default "FROM_CWD_OPT_DYNAMIC";`);

            dw = new DenoWorker({ imports: true, cwd: dir });

            const src = `
        const m = await import("./dep.js");
        moduleReturn(m.default);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("FROM_CWD_OPT_DYNAMIC");
        },
        20_000
    );

    it(
        "cwd accepts file:// URL (directory): relative import resolves",
        async () => {
            const dir = makeTempDir();
            writeFile(path.join(dir, "dep.js"), `export default "FROM_FILE_URL";`);

            const fileUrl = "file://" + dir + (dir.endsWith("/") ? "" : "/");

            dw = new DenoWorker({ imports: true, cwd: fileUrl });

            const src = `
        import x from "./dep.js";
        moduleReturn(x);
      `;

            await expect(dw.evalModule(src)).resolves.toBe("FROM_FILE_URL");
        },
        20_000
    );
});