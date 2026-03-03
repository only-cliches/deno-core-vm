# Changelog

All notable changes to this project will be documented in this file.

## [0.8.5] - 2026-03-02

### Added
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

### Changed
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
- Updated inspect option normalization/parsing to allow `port: 0` for OS-assigned ephemeral debugging ports.

### Fixed
- Fixed promise settlement channel behavior to avoid dropped completions under load (`send` instead of non-blocking `try_send`).
- Fixed synchronous eval request handling to fail fast when queue capacity is exceeded.
- Fixed worker creation to propagate parse/config errors instead of silently continuing.
- Hardened filesystem lexical path normalization to reduce traversal/escape risk.
- Applied `maxMemoryBytes` to V8 runtime create params so memory limits are enforced.
- Tightened callback import handling with timeout and permission checks.
- Fixed timeout helper leaks in tests by clearing timers in `finally`.
- Fixed example scripts and local import paths so examples run from this repository.
- Fixed outdated env permission test expectations to match the new explicit-permissions behavior.
- Fixed potential leaks of never-loaded ephemeral virtual modules by removing eval-module virtual entries when module startup fails.

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
- TypeScript tests: full Jest suite passed (`26 suites`, `205 tests`).
- Stream-focused tests passed (`test-ts/streams.spec.ts`).
