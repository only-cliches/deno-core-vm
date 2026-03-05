import { DenoWorker } from "../src/index";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function setupDemoPackage(root: string) {
    const pkgDir = path.join(root, "node_modules", "demo-pkg");
    await fs.mkdir(pkgDir, { recursive: true });

    await fs.writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify(
            { name: "demo-pkg", version: "1.0.0", type: "module", main: "index.js" },
            null,
            2,
        ),
        "utf8",
    );

    await fs.writeFile(
        path.join(pkgDir, "index.js"),
        'export const value = "from-demo-pkg";\nexport default { value };',
        "utf8",
    );
}

async function main() {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deno-director-node-resolve-"));
    await setupDemoPackage(tmp);

    const resolverOnly = new DenoWorker({
        cwd: tmp,
        imports: true,
        moduleLoader: { nodeResolve: true },
    });

    const compatMode = new DenoWorker({
        cwd: tmp,
        nodeCompat: true,
        imports: true,
        moduleLoader: { nodeResolve: true },
    });

    try {
        const a = await resolverOnly.module.eval(`
            import pkg from "demo-pkg";
            export const out = pkg.value;
        `);

        const b = await compatMode.module.eval(`
            import pkg from "demo-pkg";
            export const out = pkg.value;
        `);

        console.log("nodeResolve out:", a.out);
        console.log("nodeCompat out:", b.out);
    } finally {
        await resolverOnly.close();
        await compatMode.close();
        await fs.rm(tmp, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
