import { DenoWorker } from "./src/index"; // adjust if needed

async function main() {
  const w = new DenoWorker();

  try {
    console.log(await w.eval("globalThis.__denojs_worker_debug_ops"));

    await w.setGlobal("add", (a: number, b: number) => a + b);

    console.log("typeof add =", await w.eval("typeof add"));

    const result = await w.eval(`
(async () => {
  try {
    const v = await add(1, 2);
    return { ok: true, value: v };
  } catch (e) {
    return {
      ok: false,
      err: {
        name: e && e.name ? String(e.name) : "",
        message: e && e.message ? String(e.message) : String(e),
        stack: e && e.stack ? String(e.stack) : ""
      }
    };
  }
})()
    `);

    console.log("add(1,2) result =", result);
  } finally {
    try {
      await w.close();
    } catch (e: any) {
      console.error("close failed:", e && (e.stack || e));
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e && (e.stack || e));
  process.exitCode = 1;
});