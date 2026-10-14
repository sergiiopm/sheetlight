# Engine benchmarks

Benchmarks for every performance target in `docs/PLAN.md` that the engine
controls, measured through the engine actor (the same path the Tauri
commands take). Source: `src-tauri/benches/engine.rs`; the big files are
generated deterministically at bench time (`src-tauri/benches/support/data.rs`)
and never committed.

```bash
cd src-tauri
cargo bench --bench engine                      # release (LTO), all benchmarks
cargo bench --bench engine -- open_csv recalc   # name filters
SHEETLIGHT_BENCH_SCALE=0.1 cargo test --bench engine   # quick debug smoke run
```

CI: the **Benchmarks** workflow (`.github/workflows/bench.yml`, manual
`workflow_dispatch`) runs the release build on `windows-latest` and puts the
table in the job summary; every CI run also does a 1 % debug smoke run so the
bench cannot rot.

## Targets

| PLAN metric | Benchmark | Target | How it is measured |
|---|---|---|---|
| Open 1M-row CSV < 5 s, browsable while loading | `open_csv`, `open_csv_es` | < 5000 ms | `openDocument` until `loading` is false; "browsable after" = when `openDocument` returns and blocks can be fetched. `_es`: same rows as a Spanish export (BOM, `;`, decimal comma, dd/mm/yyyy) |
| Open 10 MB .xlsx (~100k x 20) < 2 s | `open_xlsx` | < 2000 ms | `openDocument` on a 15 MB, 100k x 20 workbook with 100k formulas (harder than the target): `inspect` + IronCalc load + full evaluate |
| Recalc 100k chained formulas < 200 ms | `recalc_chain` | < 200 ms | `setCells` A1 on `A2=A1+1 … A100000`, wall time of the apply (full recalc) |
| Scroll / selection 60 fps, also at 1M rows | `fetch_blocks_csv`, `fetch_blocks_xlsx` | < 16 ms per viewport | `fetchBlocks` for a 50 x 20 viewport (4 blocks of 64 x 16) at random rows, the engine half of a scroll jump; the grid's 60 fps is measured by `tests/grid/browser/perf.test.ts` |
| Save (no PLAN number) | `save_csv`, `save_xlsx` | = the open budget | `saveDocument` of the opened big file |
| Edit on a big workbook | `edit_big` | info | `setCells` G2 on the 100k x 20 workbook: one full recalc of 2M cells |
| Cold start < 1 s, idle RAM < 150 MB, installer < 15 MB | — | — | app-level: measured on the release build by the orchestrator (not reachable from the engine bench); the bench reports peak RSS per step for reference |

## Results

### 2026-10-14 — Linux container, **debug build** (not comparable with the targets)

Machine: linux x86_64 · Intel Xeon @ 2.10 GHz (cloud VM) · 4 logical cores ·
profile **debug** · scale 1 · 1 run each. The QA box only allows debug builds,
so these numbers check that every benchmark runs end to end at full size;
unoptimized Rust is often an order of magnitude slower than the release build. The
release numbers that count come from the **Benchmarks** workflow on
`windows-latest` (to be added below by whoever runs it).

| Benchmark | Target | Debug median | Peak RSS | Detail |
|---|---|---|---|---|
| open_csv | < 5000 ms | 7243 ms | 91 MB | 1,000,001 rows x 10, 82 MB; browsable after 5 ms; detected `,` / utf-8 / `.` |
| fetch_blocks_csv | < 16 ms | 1 ms | 91 MB | p95 2.1 ms, <= 29 KB per call |
| save_csv | < 5000 ms | 8854 ms | 247 MB | 82 MB written |
| open_csv_es | < 5000 ms | 7474 ms | 247 MB | 83 MB; browsable after 5 ms; detected `;` / **utf-8-bom** / `,` |
| open_xlsx | < 2000 ms | 25968 ms | 247 MB | 100,001 rows x 20 + 100k formulas, 15.3 MB |
| fetch_blocks_xlsx | < 16 ms | 3 ms | 247 MB | p95 5.5 ms, <= 59 KB per call |
| edit_big | info | 1057 ms | 247 MB | full recalc of 2M cells / 100k formulas |
| save_xlsx | < 2000 ms | 34939 ms | 469 MB | 15.4 MB written |
| recalc_chain | < 200 ms | 245 ms | 469 MB | 100k chained formulas |

What the debug run already shows:

- **Browsable while loading holds**: `openDocument` returns in ~5 ms for a
  1M-row CSV and blocks are served while the loader streams.
- **Block fetches are far inside a frame** even unoptimized (p95 2–6 ms for a
  full viewport jump), on both backends.
- **`recalc_chain` is already ~245 ms in debug**, so the release build should
  be well under 200 ms.
- **CSV save memory**: peak RSS jumps from 91 MB to 247 MB while saving the
  82 MB CSV: `save_document` holds the store's output, a lossy UTF-8 copy and
  the re-encoded bytes at the same time (≈3x the file). It is the same code
  path as the double-encoding bug (known-gaps `roundtrip_csv`); fixing it
  should stream the store's bytes straight to the temp file.
- **`save_xlsx` is the slowest path** (35 s debug, 1.3x the open). Watch it in
  the release run against the 2 s budget.

### Release (Windows) — pending

Run **Actions → Benchmarks → Run workflow** (defaults: all, scale 1, 3 runs)
and paste the job-summary table here with its machine line.
