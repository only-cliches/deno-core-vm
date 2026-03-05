import { DenoWorker } from "../src/index";

async function main() {
    const worker = new DenoWorker();
    try {
        const mod = await worker.module.eval(`
            export const version = "1.0.0";
            export function add(a, b) { return a + b; }
        `);

        console.log("version:", mod.version);
        console.log("add(2, 3):", mod.add(2, 3));
    } finally {
        await worker.close();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
