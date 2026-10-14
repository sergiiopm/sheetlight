# QA (WS5)

| Document | What |
|---|---|
| `excel-behavior.md` | The Excel behaviors Sheetlight must match, each linked to its test, with open bugs and coverage gaps |
| `benchmarks.md` | PLAN performance targets, how each is measured, and results per machine |

Where the tests live:

- `tests/corpus/` — realistic Spanish files (xlsx, xls, csv) with independent
  expectations and `known-gaps.json`; see its README.
- `src-tauri/tests/` — Rust integration tests through the engine actor:
  corpus (`engine_corpus.rs`, `corpus_files.rs`, `ironcalc_baseline.rs`),
  round trips (`engine_roundtrip.rs`), formulas (`engine_functions.rs`),
  Excel behaviors (`excel_behavior.rs`).
- `src-tauri/benches/engine.rs` — benchmarks (`docs/qa/benchmarks.md`).
- `.github/workflows/ci.yml` (every push / PR, Windows) and `bench.yml`
  (manual).

Open bugs: `cd src-tauri && cargo test --tests -- --ignored`.
