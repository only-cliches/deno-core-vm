# Codex workflow: Jest fix loop (timestamp file + cargo check)

## Goal
Make the targeted Jest test pass by editing files under `/src` only, while keeping `cargo check` clean.

## Allowed commands
Primary workflow:
- `scripts/codex-reset.sh`
- `scripts/codex-jest.sh`
- `LIMIT_SECONDS=600 scripts/codex-loop.sh`
- `cargo check`
- `npm run build-debug`

Utilities (allowed anytime):
- `rg` (ripgrep)
- `cat`
- `sed`

Do not run any other commands unless I explicitly allow it.

## Hard constraints
- Only modify files under `/src`.
- Do not refactor. Make the smallest change that fixes the current failure.
- Fix only the first failing test shown in `codex/jest-output.txt`.
- Use `codex/jest-output.txt` as the source of truth for failures.
- When `cargo check` reports warnings or errors, resolve them before running `npm run build-debug`.
- Stop immediately if:
  - Jest passes (exit code 0), or
  - the time limit has been reached and `scripts/codex-loop.sh` exits.

If the only reasonable fix requires changing files outside `/src`, STOP and report:
- which file(s)
- why it is required
- the minimal proposed diff (do not apply)

## Workflow
1. Start fresh:
   - Run: `scripts/codex-reset.sh`

2. Run Jest and capture output:
   - Run: `scripts/codex-jest.sh`
   - Read only: `codex/jest-output.txt`

3. If Jest passes: STOP.

4. If Jest fails:
   - Update code under `/src` to fix the first failure only.
   - Run: `cargo check`
   - If `cargo check` emits warnings or errors, fix them (within `/src`) and re-run `cargo check` until clean.
   - Run: `npm run build-debug`

5. Repeat steps 2 to 4 until tests pass or time limit is reached.