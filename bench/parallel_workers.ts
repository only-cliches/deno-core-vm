import { DenoWorker } from "../src/index";

type Args = {
  workers: number;
  evalSource: string;
  sampleMs: number;
  json: boolean;
};

type Timings = {
  spinUpMs: number;
  evalAllMs: number;
  spinDownMs: number;
  totalMs: number;
};

type MemoryStats = {
  baselineRssBytes: number;
  maxRssBytes: number;
  endRssBytes: number;
};

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function bytesToMiB(bytes: number): number {
  return bytes / (1024 * 1024);
}

function fmtMs(ms: number): string {
  return ms.toFixed(2);
}

function fmtMiB(bytes: number): string {
  return bytesToMiB(bytes).toFixed(2);
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    workers: 50,
    evalSource: "1 + 1",
    sampleMs: 25,
    json: false,
  };

  const take = (key: string): string | undefined => {
    const i = argv.indexOf(key);
    if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
    return undefined;
  };

  const toInt = (v: string | undefined, fallback: number): number => {
    if (!v) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.floor(n);
  };

  const workers = toInt(take("--workers"), out.workers);
  if (workers > 0) out.workers = workers;

  const sampleMs = toInt(take("--sample-ms"), out.sampleMs);
  if (sampleMs > 0) out.sampleMs = sampleMs;

  const evalSource = take("--eval");
  if (typeof evalSource === "string" && evalSource.trim().length > 0) {
    out.evalSource = evalSource;
  }

  out.json = argv.includes("--json");

  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const workers: DenoWorker[] = [];
  const timings: Timings = {
    spinUpMs: 0,
    evalAllMs: 0,
    spinDownMs: 0,
    totalMs: 0,
  };

  const baselineRss = process.memoryUsage().rss;
  let maxRss = baselineRss;
  const sample = () => {
    const rss = process.memoryUsage().rss;
    if (rss > maxRss) maxRss = rss;
  };
  const sampler = setInterval(sample, args.sampleMs);
  sample();

  const totalStart = nowNs();
  let runError: unknown = null;

  try {
    const spinUpStart = nowNs();
    for (let i = 0; i < args.workers; i++) {
      workers.push(new DenoWorker());
      if ((i + 1) % 25 === 0) sample();
    }
    timings.spinUpMs = nsToMs(nowNs() - spinUpStart);
    sample();

    const evalStart = nowNs();
    const results = await Promise.all(workers.map((w) => w.eval(args.evalSource)));
    timings.evalAllMs = nsToMs(nowNs() - evalStart);
    sample();

    if (results.length !== args.workers) {
      throw new Error(`Unexpected eval result count: got ${results.length}, expected ${args.workers}`);
    }
  } catch (err) {
    runError = err;
  } finally {
    const spinDownStart = nowNs();
    await Promise.all(
      workers.map((w) =>
        w.close().catch(() => {
          // ignore per-worker close failures in benchmark cleanup
        })
      )
    );
    timings.spinDownMs = nsToMs(nowNs() - spinDownStart);
    sample();

    clearInterval(sampler);
    timings.totalMs = nsToMs(nowNs() - totalStart);
  }

  const memory: MemoryStats = {
    baselineRssBytes: baselineRss,
    maxRssBytes: maxRss,
    endRssBytes: process.memoryUsage().rss,
  };

  const output = {
    workers: args.workers,
    evalSource: args.evalSource,
    timings,
    memory,
  };

  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(output, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log("=== Parallel Deno Worker Benchmark ===");
    // eslint-disable-next-line no-console
    console.log(`workers: ${args.workers}`);
    // eslint-disable-next-line no-console
    console.log(`eval: ${args.evalSource}`);
    // eslint-disable-next-line no-console
    console.log(`spinUpMs: ${fmtMs(timings.spinUpMs)}`);
    // eslint-disable-next-line no-console
    console.log(`evalAllMs: ${fmtMs(timings.evalAllMs)}`);
    // eslint-disable-next-line no-console
    console.log(`spinDownMs: ${fmtMs(timings.spinDownMs)}`);
    // eslint-disable-next-line no-console
    console.log(`totalMs: ${fmtMs(timings.totalMs)}`);
    // eslint-disable-next-line no-console
    console.log(`baselineRssMiB: ${fmtMiB(memory.baselineRssBytes)}`);
    // eslint-disable-next-line no-console
    console.log(`maxRssMiB: ${fmtMiB(memory.maxRssBytes)}`);
    // eslint-disable-next-line no-console
    console.log(`endRssMiB: ${fmtMiB(memory.endRssBytes)}`);
  }

  if (runError) {
    throw runError;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
