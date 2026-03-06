import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker({
        imports: true,
        permissions: { import: true, net: true },
        moduleLoader: {
            httpsResolve: true,
            cacheDir: ".deno_remote_cache",
        },
    });

    try {
        try {
            const mod = await worker.module.eval(`
                import { basename } from "https://deno.land/std@0.224.0/path/mod.ts";
                export const out = basename("/tmp/example.txt");
            `);
            console.log("basename:", mod.out);
        } catch (err) {
            // Some environments (CI/sandboxes) block outbound network access.
            // Keep this example runnable by falling back to an inline equivalent.
            console.warn(
                "remote https import failed; using offline fallback:",
                err instanceof Error ? err.message : String(err),
            );
            const fallback = await worker.module.eval(`
                export const out = "/tmp/example.txt".split("/").pop();
            `);
            console.log("basename (fallback):", fallback.out);
        }
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
