export type WorkerCount = 1 | 4 | 8 | 12 | 16 | 32;

export type ScenarioKey =
    | "node-fn"
    | "node-async-fn"
    | "node-postmessage"
    | "node-http"
    | "deno-postmessage"
    | "deno-streams"
    | "deno-streams-reused"
    | "deno-eval"
    | "deno-evalsync"
    | "deno-handle"
    | "deno-postmessage-batched"
    | "deno-handle-apply"
    | "deno-eval-binary";

export type BenchConfig = {
    width: number;
    height: number;
    tileHeight: number;
    workerCounts: WorkerCount[];
    iterations: number;
    warmup: number;
    scenarios: ScenarioKey[];
    format: "plain" | "markdown";
};

export type RenderTask = {
    id: number;
    x0: number;
    y0: number;
    width: number;
    height: number;
    imageWidth: number;
    imageHeight: number;
};

export type RenderResult = {
    id: number;
    checksum: number;
    pixels: number;
};

export type ScenarioDef = {
    key: ScenarioKey;
    label: string;
    main: "Node";
    ipc: string;
    worker: "Node" | "Node Worker" | "Deno";
    setup?: (workerCount: number) => Promise<any>;
    run: (tasks: RenderTask[], workerCount: number, context?: any) => Promise<number>;
    teardown?: (context: any) => Promise<void>;
};

export const scenarioOrder: ScenarioKey[] = [
    "node-fn",
    "node-async-fn",
    "node-postmessage",
    "node-http",
    "deno-postmessage",
    "deno-streams",
    "deno-streams-reused",
    "deno-eval",
    "deno-evalsync",
    "deno-handle",
    "deno-postmessage-batched",
    "deno-handle-apply",
    "deno-eval-binary",
];
