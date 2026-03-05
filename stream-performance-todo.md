# Stream Performance Optimization TODO

This document outlines the architectural and implementation changes required to significantly increase the throughput and reduce the latency of the `worker.stream` API.

## 1. Zero-Copy Binary Fast-Path
**Goal:** Eliminate redundant `Vec<u8>` copies when moving binary chunks between Node.js, Rust, and the Deno runtime.

### Tasks
- [ ] Refactor `JsValueBridge::BufferView` to use `bytes::Bytes` or a similar reference-counted container instead of `Vec<u8>`.
- [ ] Update `src/bridge/v8_codec.rs` to use `v8::ArrayBuffer::with_backing_store` with a custom deleter that decrements the Rust reference count, avoiding a copy into V8.
- [ ] Update `src/bridge/neon_codec.rs` to use `JsBuffer::external` (if supported by the Neon version) or pool large buffers to avoid frequent allocations.

### Validation Requirements
- **Allocation Tracking:** Use a memory profiler (e.g., `heaptrack` or `Valgrind`) to confirm that the number of allocations per 100MB of streamed data is near-zero for the data buffers themselves.
- **Throughput Benchmark:** `bench/bandwidth.ts` should show a >3x increase in throughput for large (1MB+) chunks.

## 2. Optimized JavaScript Framing
**Goal:** Reduce CPU overhead in the TypeScript write loop by avoiding per-chunk string encoding and allocation.

### Tasks
- [ ] Implement a `HeaderCache` in `src/ts/worker.ts` that stores pre-encoded Uint8Array headers (ID + Type) for each active stream.
- [ ] Introduce a `postStreamChunkRaw(id: number, payload: Uint8Array)` native method that takes a numeric ID and a raw buffer, performing the framing on the Rust side or using multi-part transport.
- [ ] Switch stream IDs from high-entropy strings to 32-bit integers to avoid `TextEncoder` overhead in the hot path.

### Validation Requirements
- **CPU Profiling:** Chrome/Node.js DevTools profiler should show `< 1%` time spent in `TextEncoder.encode` and `decodeStreamFrameEnvelope` during a high-speed stream.
- **Small Chunk Performance:** Benchmark `write()` with 1KB chunks; throughput should be at least 50% of the large-chunk throughput.

## 3. Vectorized & Coalesced Dispatching
**Goal:** Amortize the cost of bridge crossings (V8 <-> Rust <-> Node) by batching multiple frames.

### Tasks
- [ ] Modify `PostStreamChunks` to pass a single large `Uint8Array` containing multiple concatenated frames to V8, rather than a V8 Array of objects.
- [ ] Implement a "Gather" write in Rust that accepts multiple buffers and sends them as a single TCP/IPC packet where possible.
- [ ] Update `bootstrap.js` to parse vectorized buffers in a single loop.

### Validation Requirements
- **Bridge Entry Count:** Use a counter in `handle_deno_msg` to verify that sending 1000 chunks results in significantly fewer than 1000 bridge entries when `writeMany` is used.
- **Congestion Test:** Run `bench/parallel_workers.ts` and ensure stream performance remains stable even under high event-loop contention.

## 4. Flow-Control Enhancements
**Goal:** Reduce control-plane overhead and prevent "stop-and-wait" behavior on high-latency links.

### Tasks
- [ ] Increase `STREAM_DEFAULT_WINDOW_BYTES` to 64 MiB and make it configurable via `DenoWorkerOptions`.
- [ ] Implement "Credit Piggybacking": when sending data chunks, include any pending credits in the same frame header.
- [ ] Add a `highWaterMark` option to `StreamReader` to allow more aggressive buffering before applying backpressure.

### Validation Requirements
- **Saturation Test:** Verify that a stream can saturate a 10Gbps local link (or the maximum pipe bandwidth) without the writer frequently hitting "waiting for credit" states.
- **Latency Benchmark:** Measure the time from `write()` to `read()` completion for a small message; it should be within 1.2x of a raw `postMessage`.

## 5. Final Throughput Target
- **Success Metric:** The `bench/bandwidth.ts` benchmark must exceed **2.5 GB/s** (or 80% of raw `postMessage` binary throughput) on modern hardware.
- **Stability:** All existing `test-ts/streams.spec.ts` tests must pass without modification to the public API.
