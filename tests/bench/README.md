# Benchmarks

The engine benchmarks live in `src-tauri/benches/engine.rs` (Rust, through
the engine actor) and generate their own big files at bench time; results and
targets are in `docs/qa/benchmarks.md`.

```bash
cd src-tauri && cargo bench --bench engine          # release, all
cd src-tauri && cargo test --bench engine           # debug smoke run
```

`results/` (git-ignored) receives one `engine-<unix time>.json` per run with
the machine line, profile and every row of the table.

The grid's frame-time checks (60 fps scroll at 1M rows) are browser tests:
`tests/grid/browser/perf.test.ts`.
