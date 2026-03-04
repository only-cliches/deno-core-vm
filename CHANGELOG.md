# Changelog

All notable changes to this project will be documented in this file.


## [0.9.1] Mar 4, 2026
### Changes
- Moved `wasm` option from `limits` to `permissions` worker config object.
- Added `ray-bench`.

## [0.9.0] Mar 3, 2026

### Added
- Added a new runtime handle API surface under `worker.handle` with rich value operations:
  - `get`, `tryGet`, `eval`, `set`, `has`, `delete`, `keys`, `entries`,
  - `getOwnPropertyDescriptor`, `define`, `instanceOf`, `isCallable`, `isPromise`,
  - `call`, `construct`, `await`, `clone`, `toJSON`, `apply`, `getType`, `dispose`.
- Added `rootType` handle metadata snapshot and root `getType()` cache refresh behavior.
- Added handle-level execution options (`DenoWorkerHandleExecOptions`) with per-call `maxEvalMs`.
- Added handle creation-level timeout defaults (`handle.eval(..., { maxEvalMs })`, `handle.get(..., { maxEvalMs })`) that apply to subsequent handle operations.
- Added `bridge.streamBacklogLimit` option to cap unaccepted worker->Node stream-open backlog (default `256`).
- Added `limits.wasm` (default `true`) to allow disabling `.wasm` module loading when set to `false`.
- Added a new handles usage example: `examples/12-handles.ts`.
- Added new tests:
  - `test-ts/handles.spec.ts` (comprehensive handle API behavior),
  - `test-ts/options.merge.spec.ts` (deep merge semantics),
  - additional hardening/regression coverage in env/module-loader/streams specs.

### Changed
- Breaking API cleanup:
  - consolidated handle entrypoints to `worker.handle.{get,tryGet,eval}`,
  - removed prior alias/legacy-style handle entrypoints and watch/unwatch-style behavior.
- Moved worker limits to `options.limits` and updated docs/examples/tests accordingly:
  - `maxHandle`, `maxEvalMs`, `maxMemoryBytes`.
- Updated `mergeWorkerOptions` to deep-merge `limits` and `moduleLoader` (in addition to existing nested merges).
- Enriched `DenoWorkerHandleApplyOp` typing with explicit operation union values.
- Updated bridge/options/docs comments for clearer defaults and operational guidance.

### Fixed
- Fixed `permissions.import` URL allowlist matching to prevent host-prefix confusion (for example, `example.com` no longer matches `example.com.attacker.tld`).
- Fixed `permissions.import` URL matching to enforce path-boundary semantics.
- Fixed `env`/`envFile` path loading to stay within configured worker `cwd` sandbox.
- Fixed handle option precedence and inheritance edge case where passing `{}` at call-time could accidentally drop handle-level defaults.
- Fixed unbounded inbound stream-open backlog growth by enforcing configurable backlog limits.

### Security
- Hardened remote import permission checks (strict origin/path matching for URL allowlists).
- Hardened environment file loading boundaries to prevent out-of-sandbox path reads through config.
- Hardened handle bridge/runtime behavior and error signaling (structured codes and safer edge-case handling).
- Hardened wire hydration on both host and runtime bootstrap paths by filtering prototype-pollution keys (`__proto__`, `constructor`, `prototype`).
- Hardened Rust wire buffer-view decoding by clamping `byteOffset`/`length` to actual payload bytes to avoid oversized allocation/offset abuse.
- Added startup warning when `permissions.run` is enabled to call out subprocess environment inheritance risk.

### Performance
- Reused a shared `reqwest` HTTP client for remote module fetches (avoids per-fetch client construction).
- Reworked sync Node-dispatch flow to use a dedicated dispatch thread + ack channel, removing queue-polling sleep loops from the runtime thread.
- Kept handle batching path (`handle.apply`) and timeout controls aligned for lower roundtrip overhead under heavy handle usage.


## [0.8.5] Mar 2, 2026

### Added
- Added a stream regression spec in `test-ts/streams.spec.ts`:
  - `Node -> worker stream survives frames arriving before worker accepts`
  - Covers the race where `open/chunk/close` can arrive before `hostStreams.accept(...)` is called.
- Added a new bridge isolation test suite in `test-ts/bridge.isolation.spec.ts` covering:
  - control-plane eval completion while data-plane traffic is saturated,
  - data-plane dispatch under heavy queued eval load,
  - force-close settling of mixed queued work,
  - restart(force) stale-message isolation across runtime epochs,
  - stream ordering under interleaved control/data traffic.
- Added heavier contention coverage in `test-ts/contention.spec.ts`:
  - `single runtime: 48 simultaneous stream pairs plus host-call storm`,
  - `ABSURD contention: multi-wave runtime swarm with dense stream and host-call pressure`,
  - environment-tunable stress knobs:
    - `DENO_DIRECTOR_ABSURD_RUNTIMES`
    - `DENO_DIRECTOR_ABSURD_WAVES`
    - `DENO_DIRECTOR_ABSURD_STREAMS`
    - `DENO_DIRECTOR_ABSURD_HOST_CALLS`.
- Added native teardown helpers to the addon bridge API:
  - `forceDispose()` for immediate best-effort native handle disposal,
  - `__isRegistered()` internal registration probe used by teardown hardening.
- Added dedicated contention scripts in `package.json`:
  - `npm run test:contention`
  - `npm run test:contention:absurd`
  (both run with `--runInBand --forceExit` for deterministic CI/CLI completion under native open-handle warnings).
- Added `moduleLoader.jsrResolve` to enable JSR-style specifier resolution (`jsr:@...` and `@std/...` mapping to `https://jsr.io/...`).
- Added resolver tests for JSR mapping and updated TS tests for remote/module-loader behavior.
- Added guard behavior/tests to prevent unresolved bare imports from stalling when Node/JSR resolution is disabled.
- Added cross-runtime byte streaming API:
  - Node side: `stream.create(key?)` / `stream.accept(key)`.
  - Worker side: `hostStreams.create(key?)` / `hostStreams.accept(key)`.
  - Stream writers expose `getKey()`.
- Added secure auto-key generation when `create()` is called without a key on stream.
- Added stream bridge tests in `test-ts/streams.spec.ts`.
- Added `moduleLoader.httpResolve` to explicitly gate `http://` imports.
- Added `moduleLoader.maxPayloadBytes` to cap remote module payload size (`-1` disables cap, default `10 MiB`).
- Added `examples/` directory with runnable usage examples, including `examples/11-streams.ts`.
- Added test harness + cleanup utilities for Jest (`test-ts/helpers.worker-harness.ts`, `test-ts/jest.setup.ts`).
- Added guard script to block new `as any` usage in tests (`codex/check-test-any.sh`).
- Added runtime `inspectPort` surface to expose the actual bound inspector port (including ephemeral assignment when `inspect.port = 0`).
- Added messaging regression coverage to ensure plain-object Node->worker control messages still round-trip with ack responses (prevents `nodeToWorkerReset`-style stalls).

### Changed
- Renamed module-specifier helper API from `getModule(specifier)` to `importModule(specifier)` with no compatibility alias.
- Refactored Node->Deno bridge ingress into two queues:
  - control plane (`eval`, `evalModule`, `evalSync`, `setGlobal`, `memory`, `close`)
  - data plane (`postMessage`, including stream envelopes)
  in `src/worker/state.rs`, `src/lib.rs`, `src/native_api/worker_api.rs`, and `src/worker/runtime.rs`.
- Updated runtime scheduler to service both control/data queues and pre-drain queued data frames before executing a newly dequeued control message, reducing eval-vs-stream deadlock pressure on the single runtime lane.
- Changed bridge enqueue behavior to queue-and-drain semantics under load instead of fail-fast-on-full for queued API surfaces.
- Updated stress/limits/api assertions to reflect queue-and-drain semantics (no queue-full rejection expectation for in-flight overlap cases).
- Enabled `forceExit: true` in Jest config for deterministic process termination while native-handle teardown hardening continues.
- Migrated remote module toggle from `moduleLoader.denoRemote` to `moduleLoader.httpsResolve`.
- Moved `nodeResolve` under `moduleLoader.nodeResolve`.
- Replaced curl-based remote loading with async Tokio-friendly HTTP fetching via `reqwest` (with timeout and redirect limits).
- Moved transpilation configuration to top-level options:
  - `transpileTs` and `tsCompiler` are now top-level.
  - Added `tsCompiler.cacheDir` for on-disk transpile output caching.
- `eval`, `evalSync`, and `evalModule` now honor `transpileTs`.
- Updated README/API docs with node resolution and streaming sections.
- Updated streaming docs/examples to use the `create/accept` API and generated key flow.
- Updated README streaming example to pass generated keys through `eval(..., { args })`.
- Simplified `examples/11-streams.ts` with two clear flows:
  - generated keys
  - static keys
  and removed `globalThis` usage from the example code.
- Changed env permission behavior for configured env maps:
  - if `permissions.env` is missing or `[]`, it is populated with env-map keys,
  - if `permissions.env` is already set, it is left unchanged.
- Replaced per-eval timeout thread spawning with a dedicated timer watchdog thread and channel-based scheduling.
- Switched global worker registry locking from `Mutex<HashMap<...>>` to `RwLock<HashMap<...>>` to reduce read-path contention.
- Reordered V8 object serialization fallback to prefer structured clone (`ValueSerializer`) before JSON stringification.
- Updated Node->Deno Neon codec structured-value fallback:
  - plain objects/arrays remain on JSON wire for transport compatibility,
  - non-plain structured values prefer native `__v8.serialize` before JSON stringify/replacer fallback.
- Updated inspect option normalization/parsing to allow `port: 0` for OS-assigned ephemeral debugging ports.
- Reduced bridge conversion overhead for plain Deno objects/arrays by short-circuiting `serde_v8` output directly to `JsValueBridge::Json` when no wire markers are present (avoids an extra `wire::from_wire_json` pass).

### Fixed
- Fixed stream frame ordering race on both sides of the bridge (`src/ts/worker.ts`, `src/worker/bootstrap.js`):
  - `chunk/close/error/cancel` frames arriving before `open` are now queued per stream id and replayed after `open`.
  - Prevents Node->worker stream hangs when producer closes quickly before consumer attaches.
- Fixed runtime panic path introduced by blocking channel sends inside Tokio-driven runtime contexts by switching worker op send paths to bounded wait/retry semantics that avoid `blocking_send` panics on runtime threads.
- Fixed stream and stream-edge test regressions caused by control-priority queueing by draining pending data-plane frames before running queued control work.
- Hardened close/force-close teardown behavior in the TypeScript wrapper:
  - bounded native close wait in force-close path,
  - post-close native registration probe + best-effort hard-dispose fallback.
- Fixed close cleanup fallback in `src/worker/dispatch/deno_commands.rs` so worker registry entries are removed even when close callback enqueue fails.
- Fixed README examples that were not directly runnable as written:
  - corrected invalid/placeholder snippets (`importModule`, node-resolve example, console snippet variable naming, args section typo),
  - updated streaming section to safer key/import usage and explicit worker task completion.
- Fixed promise settlement channel behavior to avoid dropped completions under load (`send` instead of non-blocking `try_send`).
- Fixed synchronous eval request handling under queue pressure (superseded by current queue-and-drain overlap behavior).
- Fixed worker creation to propagate parse/config errors instead of silently continuing.
- Hardened filesystem lexical path normalization to reduce traversal/escape risk.
- Applied `maxMemoryBytes` to V8 runtime create params so memory limits are enforced.
- Tightened callback import handling with timeout and permission checks.
- Fixed timeout helper leaks in tests by clearing timers in `finally`.
- Fixed example scripts and local import paths so examples run from this repository.
- Fixed outdated env permission test expectations to match the new explicit-permissions behavior.
- Fixed potential leaks of never-loaded ephemeral virtual modules by removing eval-module virtual entries when module startup fails.
- Fixed a deadlock path where `evalSync` could stall forever when dynamic imports required the host `imports` callback; import-callback loads are now rejected while sync eval is active.

### Security
- Improved module loading safety by enforcing clearer permission boundaries for HTTPS/remote loads.
- Added stricter path normalization and remote load gating to reduce path traversal and unintended network resolution exposure.
- Hardened stream key semantics:
  - keys are single-use while active,
  - duplicate `create/accept` for the same key are rejected,
  - keys are only reusable after both sides discard/release the stream.
- Added startup warning when `moduleLoader.httpResolve` is enabled.
- Added startup warning when env-map keys are configured but not readable by current `permissions.env`.
- Removed non-cryptographic stream-key fallback in worker bootstrap; secure crypto-based key generation is now required.
- Split remote import gating:
  - `https://` requires `moduleLoader.httpsResolve`,
  - `http://` requires `moduleLoader.httpResolve`.
- Added remote payload size enforcement during fetch/load via `moduleLoader.maxPayloadBytes`.

### Removed
- Removed backward-compatibility aliases for old option shapes:
  - `moduleLoader.denoRemote`
  - top-level `nodeResolve`
  - `moduleLoader.transpileTs` / `moduleLoader.tsCompiler`
  - typo alias `transpliteTs`
- Removed unpublished stream API compatibility aliases and old naming:
  - `openStream` / `acceptStream`
  - `stream.open(...)` and `hostStreams.open(...)`

### Validation
- Rust unit tests: `cargo test --lib` passed.
- TypeScript tests: full Jest suite currently passes locally (`29 suites`, `224 tests`).
- Stream-focused tests passed (`test-ts/streams.spec.ts`).
- Focused high-contention/stream suites pass with the new queueing and scheduler behavior.
