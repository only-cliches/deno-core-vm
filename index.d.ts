export type DenoWorkerEvent = "message" | "close";
export type DenoWorkerMessageHandler = (msg: any) => void;
export type DenoWorkerOptions = {
    channelSize?: number;
    maxEvalMs?: number;
    maxMemoryBytes?: number;
    maxStackSizeBytes?: number;
};
export type EvalOptions = {
    filename?: string;
    type?: "script" | "module";
    args?: any[];
};
export type ExecStats = {
    cpuTimeMs?: number;
    evalTimeMs?: number;
};
export declare class DenoWorker {
    private readonly native;
    constructor(options?: DenoWorkerOptions);
    on(event: DenoWorkerEvent, cb: DenoWorkerMessageHandler): void;
    postMessage(msg: any): void;
    isClosed(): boolean;
    get lastExecutionStats(): ExecStats;
    close(): Promise<void>;
    memory(): Promise<any>;
    setGlobal(key: string, value: any): Promise<void>;
    eval(src: string, options?: EvalOptions): Promise<any>;
    evalSync(src: string, options?: EvalOptions): any;
    evalModule(source: string, options?: Omit<EvalOptions, "type">): Promise<any>;
}
export default DenoWorker;
