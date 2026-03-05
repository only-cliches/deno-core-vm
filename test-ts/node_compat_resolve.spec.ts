// test-ts/node_compat_resolve.spec.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createTestWorker } from "./helpers.worker-harness";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

async function mkTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(p: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text, "utf8");
}

describe("DenoWorker nodeResolve/nodeCompat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkTempDir("denojs-worker-node-resolve-");
    await fs.mkdir(path.join(dir, "node_modules"), { recursive: true });

    await writeFile(path.join(dir, "local.js"), `export const x = 123;\n`);

    await writeFile(
      path.join(dir, "node_modules", "my_pkg", "package.json"),
      JSON.stringify({ name: "my_pkg", version: "1.0.0", main: "main.js" }, null, 2)
    );

    await writeFile(
      path.join(dir, "node_modules", "my_pkg", "main.js"),
      `export const y = 456;\n`
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not resolve bare specifier when nodeResolve is disabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: false },
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).rejects.toBeTruthy();
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("resolves bare specifier from node_modules when nodeResolve enabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 456 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("nodeCompat behaves like nodeResolve (lightweight) for now", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      nodeCompat: true,
    });

    try {
      const code = `
        import { y } from "my_pkg";
        export const out = y;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 456 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  it("resolves relative specifier from cwd when nodeResolve enabled", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      const code = `
        import { x } from "./local.js";
        export const out = x;
      `;
      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: 123 });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: prefers .js over .ts when both exist for extensionless import", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      writeFile(path.join(dir, "dep.js"), `export const v = "from-js";\n`);
      writeFile(path.join(dir, "dep.ts"), `export const v = "from-ts";\n`);

      const code = `
        import { v } from "./dep";
        export const out = v;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "from-js" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: package.json module field is preferred over main", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "pkgm", "package.json"),
        JSON.stringify(
          { name: "pkgm", version: "1.0.0", module: "module.js", main: "main.js" },
          null,
          2
        )
      );
      writeFile(
        path.join(dir, "node_modules", "pkgm", "module.js"),
        `export const which = "module";\n`
      );
      writeFile(
        path.join(dir, "node_modules", "pkgm", "main.js"),
        `export const which = "main";\n`
      );

      const code = `
        import { which } from "pkgm";
        export const out = which;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "module" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test(
    "nodeResolve: supports package.json main without extension (falls back to .mjs/.js/.cjs)",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        moduleLoader: { nodeResolve: true },
      });

      try {
        writeFile(
          path.join(dir, "node_modules", "pkgx", "package.json"),
          JSON.stringify({ name: "pkgx", version: "1.0.0", main: "index" }, null, 2)
        );
        writeFile(
          path.join(dir, "node_modules", "pkgx", "index.mjs"),
          `export const v = "index-mjs";\n`
        );

        const code = `
        import { v } from "pkgx";
        export const out = v;
      `;

        await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "index-mjs" });
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );

  test("nodeResolve: resolves scoped packages from node_modules", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "@scope", "pkg", "package.json"),
        JSON.stringify({ name: "@scope/pkg", version: "1.0.0", main: "main.js" }, null, 2)
      );
      writeFile(
        path.join(dir, "node_modules", "@scope", "pkg", "main.js"),
        `export const scoped = "ok";\n`
      );

      const code = `
        import { scoped } from "@scope/pkg";
        export const out = scoped;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "ok" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test("nodeResolve: resolves bare package subpath with extension fallback", async () => {
    const dw = createTestWorker({
      cwd: dir,
      imports: true,
      moduleLoader: { nodeResolve: true },
    });

    try {
      writeFile(
        path.join(dir, "node_modules", "pkgs", "package.json"),
        JSON.stringify({ name: "pkgs", version: "1.0.0", main: "main.js" }, null, 2)
      );
      writeFile(path.join(dir, "node_modules", "pkgs", "main.js"), `export const base = "base";\n`);
      writeFile(path.join(dir, "node_modules", "pkgs", "sub.ts"), `export default "sub-ts";\n`);

      const code = `
        import sub from "pkgs/sub";
        export const out = sub;
      `;

      await expect(dw.module.eval(code)).resolves.toMatchObject({ out: "sub-ts" });
    } finally {
      if (!dw.isClosed()) await dw.close();
    }
  });

  test(
    "nodeResolve: extensionless directory imports currently do not resolve to index.* (document current behavior)",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        moduleLoader: { nodeResolve: true },
      });

      try {
        writeFile(path.join(dir, "dir", "index.js"), `export const v = "index";\n`);

        const code = `
        import { v } from "./dir";
        export const out = v;
      `;

        await expect(dw.module.eval(code)).rejects.toBeTruthy();
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );

  test(
    "nodeResolve: bare package directory subpath imports currently do not resolve to index.* (document current behavior)",
    async () => {
      const dw = createTestWorker({
        cwd: dir,
        imports: true,
        moduleLoader: { nodeResolve: true },
      });

      try {
        writeFile(
          path.join(dir, "node_modules", "pkgdir", "package.json"),
          JSON.stringify({ name: "pkgdir", version: "1.0.0", main: "main.js" }, null, 2)
        );
        writeFile(path.join(dir, "node_modules", "pkgdir", "main.js"), `export const ok = true;\n`);
        writeFile(
          path.join(dir, "node_modules", "pkgdir", "dir", "index.js"),
          `export const z = "dir-index";\n`
        );

        const code = `
        import { z } from "pkgdir/dir";
        export const out = z;
      `;

        await expect(dw.module.eval(code)).rejects.toBeTruthy();
      } finally {
        if (!dw.isClosed()) await dw.close();
      }
    }
  );
});
