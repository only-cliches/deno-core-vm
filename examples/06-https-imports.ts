import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        imports: true,
        transpileTs: true,
        permissions: { import: true, net: true },
        moduleLoader: {
            httpsResolve: true,
            cacheDir: ".deno_remote_cache",
        },
    });

    try {
        const mod = await worker.module.eval(`
            import { basename } from "https://deno.land/std@0.224.0/path/mod.ts";
            export const out = basename("/tmp/example.txt");
        `);

        console.log("basename:", mod.out);
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
