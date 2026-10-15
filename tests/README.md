# tests

- `unit/` — Vitest unit tests (`npm test`). Tests may also live next to the
  code as `src/**/*.test.ts`.
- `corpus/` — realistic Spanish `.xlsx` / `.xls` / `.csv` files with
  expectations, used by the Vitest guard and the Rust tests in
  `src-tauri/tests` (private files go in `corpus/private/`, git-ignored)
- `grid/`, `editor/` — Vitest tests of those modules; `grid/browser/` runs in
  headless Chromium
- `bench/` — how to run the benchmarks (`src-tauri/benches`) and where results go
- `e2e/` — end-to-end plan (app-level e2e waits for the Phase 3 integration)

QA overview, Excel behavior spec and benchmark results: `docs/qa/`.
