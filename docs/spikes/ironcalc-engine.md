# Sheetlight Phase 0 / Spike A: IronCalc evaluation
Date 2026-10-13 · Windows 11, 20 cores · Rust 1.98 MSVC · Node 22 · Edge 155. Raw outputs are in `results/`; how to rerun is at the end.

## TL;DR: conditional GO
Use **IronCalc natively in the Tauri Rust backend**, with four conditions.

1. **Pin to IronCalc git `main`** (rev `341ec87`) or to 0.9 once it is released, not the 0.8.3 crate.
   - 0.8.3 aborts the whole process on a downward formula chain about 300 deep with a 1 MB stack.
   - 0.8.3 also needs about 1 GB peak RAM to open a 15 MB xlsx.
   - Both are fixed on `main`.
2. **Sheetlight owns a fidelity layer.** Charts, images, comments, data validation and autofilter are dropped on save, so the app must detect them, warn, and re-insert them.
3. **Sheetlight owns a typed-column fast path for big CSVs.** A 1M-row CSV loads into the engine in 1.2 s but takes about 930 MB.
4. **Sheetlight owns a thin locale layer.** The model runs with locale `en` for English formulas; the app formats and parses es values with IronCalc's public formatter.

Coverage and correctness are excellent: 256/258 common-function test cases pass on `main`, all 52 finance checks are correct, and dynamic arrays, LET and LAMBDA work.

The main weakness is that **every edit triggers a full recalculation**: about 150 ms on a sheet with 2M cells and 100k formulas (upstream issue #849).

## 1. Versions, license, maintenance
- **Crates:** `ironcalc` and `ironcalc_base` 0.8.3 (2026-07-31).
- **npm:** `@ironcalc/wasm` 0.8.4 is the engine only, with **no xlsx import/export**. `@ironcalc/wasm-xlsx` exists in the repo but is not published.
- **License:** MIT OR Apache-2.0.
- **Releases:** about every 3–6 months: 0.5 (Feb 2025), 0.6 (Oct 2025), 0.7 (Jan 2026), 0.8 (Jul/Aug 2026).
- **Activity:** 100+ commits in the last 3 months, 4.2k stars, 273 open issues, two main maintainers.
- **Unreleased on `main`:**
  - new evaluation algorithm with bounded recursion
  - only formula cells are evaluated
  - chunked cell storage
  - merge API
  - hyperlinks
  - an optional WASM `xlsx` feature
- **API churn:** `merge_cells` became `merged_cells`, `SheetData` changed type, and `from_bytes` became `fromBytes`. The saved-model (bitcode) format is version-locked: crate 0.8.3 output does not load in npm 0.8.4.

## 2. Corpus (`gen_corpus.py`)
- **big_100k.xlsx:** 100k × 20 plus a formula column, 2.0M cells, 100k formulas, 14.9 MB.
- **finance.xlsx:** 3 sheets.
  - Formulas: SUMIFS, COUNTIFS, VLOOKUP, XLOOKUP, INDEX/MATCH, IFERROR, EOMONTH, DATEDIF, YEARFRAC, NETWORKDAYS, TEXT, ROUND, PMT, NPV, IRR, FV.
  - Formatting: € / % / date formats, styles, merged title, frozen panes, column widths, autofilter.
  - `expected.json` holds 52 Python-computed values.
- **features.xlsx:** bar+line chart, image, 2 conditional-format rules, list validation, autofilter, comment, hyperlink, named range.
- **chain_100k.xlsx:** A1=1, A2=A1+1, … down to row 100,000.
- **big_1M.csv:** 1M × 10, 79 MB.

## 3. Results vs PLAN targets
"WASM" is `main` built to wasm32 with the `xlsx` feature, run in a module Web Worker in headless Edge (Chromium, like WebView2) and in Node.

| Metric (target) | Native 0.8.3 | **Native main** | WASM main, Edge | WASM main, Node |
|---|---|---|---|---|
| Open big_100k (< 2 s) | 2.29 s | **1.70 s** | 2.70 s | 3.83 s |
| Peak RAM while opening | **985 MB** | 154 MB | 155 MB wasm memory | |
| Full recalc | 376 ms | 174 ms | 279 ms | 268 ms |
| Single edit (always a full recalc) | 338 ms | **152 ms** | 202 ms | 252 ms |
| Undo | 347 ms | 151 ms | 186 ms | 235 ms |
| 100k chain recalc (< 200 ms) | 89–98 ms | **14–16 ms** | 22–25 ms | 31–36 ms |
| Reverse (downward) chain | **process abort** at ~300 levels (1 MB stack) or ~700 (2 MB) | 100k levels OK on a 1 MB stack | 10k OK | 10k OK |
| Set 10k values + one recalc | 10 + 341 ms | 9 + 149 ms | 14 + 191 ms | 17 + 241 ms |
| Viewport 50×20, formatted values | 482 µs | 496 µs | 1.2 ms | 1.5 ms |
| Viewport 50×20, styles | | | 4.0 ms | 3.3 ms |
| 60×30 viewport built as JSON (77 KB) | 750 µs | 758 µs | | |
| Save big_100k as xlsx | 3.05 s | 3.18 s | 4.90 s | 6.19 s |
| 1M CSV into model (< 5 s) | 2.13 s / 1.59 GB | **1.23 s / 938 MB** | not run | not run |
| Engine cold start | | 11–23 ms (process + small file) | 5–19 ms wasm startup | |
| Size added | | 5.2 MB exe, 1.65 MB gzip | 3.2 MB wasm (no wasm-opt), 0.93 MB gzip | |

Other measurements:
- **npm 0.8.4 in Node:** 100k chain recalc takes 203 ms, and it traps at a reverse-chain depth of 1000, leaving the model unusable.
- **CSV on 0.8.3:** every edit costs 1.9 s of full recalc. On `main` it costs 0 ms with no formulas and 437 ms once a formula sums a whole column.
- **Naive per-column CSV baseline:** 0.54 s and 453 MB.
- **WASM memory** never shrinks: 545 MB stays as the high-water mark.

## 4. Round-trip fidelity (`fidelity.py`; `results/fidelity.md`)
**Kept in both versions:**
- values and formulas, with cached values (1570 of 1570)
- shared and inline strings
- number formats (€, %, dd/mm/yyyy)
- fonts, fills, borders, alignment (checked cell by cell)
- merges
- frozen panes
- column widths and custom row heights
- defined names
- conditional formatting (color scale and cell rule; one block is split into two)

**Hyperlinks:** lost in 0.8.3, kept on `main`.

**Lost in both versions:**
- charts (chart and drawing files removed)
- images (media removed)
- comments/notes: imported read-only, not exported
- data validation
- autofilter: the `_FilterDatabase` name stays but the `<autoFilter>` element is dropped

IronCalc writes a completely fresh package on save, so any unknown part of the original file is lost.

## 5. Function coverage (evaluated, `bench-native/src/funcs.rs`)
There are 258 test cases across about 250 functions. IronCalc knows 494 function names (0.8.3) / 497 (`main`).

Passing per category (0.8.3 / main):
- math 52 / 52 of 54
- statistical 52 / 52
- lookup 29 / 30 of 30
- logical 15 / 15
- text 36 / 36
- date 25 / 25
- financial 20 / 20
- information 19 / 19
- engineering + database 7 / 7
- **Total: 255 / 256 of 258**

**Failing:**
- AGGREGATE: missing (#NAME?) in both versions.
- HYPERLINK: missing in 0.8.3; works on `main`.
- `COUNT(RANDARRAY(3))` returns 0, a minor bug.
- 0.8.3 only: `ROWS()`/`COLUMNS()` of a dynamic-array result gives #VALUE!; fixed on `main`.

**Spill:**
- `=SEQUENCE(4)` fills A1:A4.
- `A1#` references work.
- A blocked spill gives `#SPILL!`.
- FILTER, UNIQUE, SORT, SORTBY, TAKE, DROP, VSTACK, HSTACK, CHOOSECOLS, TOCOL, TEXTSPLIT, LET, LAMBDA, MAP, BYROW all work.

**Correctness:** PMT, NPV, IRR, FV, RATE, NPER, XNPV, XIRR, the depreciation functions, and the date and statistics functions match Python. finance.xlsx gives 52/52, and Excel's `_xlfn.` prefixes are handled.

## 6. API capabilities (`UserModel`)
**Present:**
- sheet operations
- raw content vs formatted value
- styles through `update_range_style`, borders, named styles, themes
- row heights, column widths, hiding
- frozen panes
- insert/delete/move rows and columns, with formula references adjusted
- undo/redo (each undo also recalculates everything)
- clipboard and CSV paste
- autofill: number series and shifting formulas work; "Jan" does not extend as a month series, and a typed date was copied rather than incremented (it may have been stored as text)
- formula completion, F4 reference cycling, token coloring
- conditional formatting
- defined names
- serialized diffs (`flush_send_queue`); there is no list of changed cells after a recalc, so the UI re-fetches the viewport

**Merge API:** `main` only.

**Missing:**
- sort
- autofilter
- data validation
- find/replace
- comment editing

**Locale:**
- Formula separators follow the model locale: with `es` you type `=SUM(1,5;2)`.
- Available locales are `en, en-GB, es, fr, de, it`; there is no `es-ES`.
- The fix is to run the model as `en` and format with `ironcalc_base::formatter::format::format_number(v, fmt, get_locale("es"))`. Verified output: `1.234,56 €`, `14/02/2025`, `14 febrero 2025`, about 1 µs per cell. This is native only.
- Spanish-style typed input and ISO dates in CSVs need Sheetlight's own parser.

## 7. Native vs WASM: recommendation is native
**Why native:**
- 1.3–2× faster for open, edit and save.
- Memory goes back to the OS when a workbook closes, with no 4 GB cap.
- The xlsx crate is available today; npm WASM has no xlsx.
- No version-locked bitcode handoff between native and WASM.
- The es formatter is accessible.
- The app can post-process the saved zip for fidelity, and engine work can run on background threads.

**IPC cost:** about 0.5 ms engine time plus 0.75 ms JSON, plus about 1.4 ms transport. The transport figure is a proxy (localhost fetch in Edge); real Tauri IPC was not measured. That gives about 2–3 ms per viewport fetch, which is fine with block prefetch and caching. For comparison, WASM needs a batch binding: 1000 single-cell calls take 1.2 ms, and styles 4 ms.

**Proposed design:**
- One engine thread (actor) holding a `UserModel` per open document.
- An async `getViewport(block)` returning compact rows plus a style table.
- Commands return "recalc done, refresh viewport".
- Keep the TS `WorkbookEngine` contract async so a WASM worker backend remains possible.

## 8. Large CSV
The engine path meets the time target but uses about 6× the RAM budget.

Proposed fast path:
- Load CSVs into a native typed-column store: f64 and date columns plus dictionary-encoded strings. Expect roughly 100–150 MB for this file.
- Parse in the background and publish rows in chunks, so the grid can scroll while loading.
- The grid reads the store directly.
- Build an IronCalc model only on the first formula or formatting edit, or for files under about 1–2M cells.
- Save to CSV straight from the store.

## 9. Risks
1. **Full recalculation on every edit, undo and paste.** Mitigations: engine thread, pausing evaluation during batches, and upstream issue #849 (prioritized by the maintainer; we could contribute).
2. **Depending on unreleased `main`.** Mitigations: pin a commit and run this corpus/bench in CI.
3. **API churn.** Mitigations: keep IronCalc behind an adapter and never store bitcode across versions.
4. **Save fidelity.** Detect and warn on open, re-insert the original drawing, chart, media and comment parts on save, and model autofilter and validation ourselves.
5. **Charts are not parsed at all.** The charts workstream needs its own chart XML parser.
6. **xlsx loading is single-threaded** at about 45 MB/s of XML, so files over ~20 MB will exceed 2 s; saving is slow and must run in the background.
7. **Missing UI features:** sort, find/replace, autofilter, month fill series, notes.
8. **Bus factor:** two main maintainers. The permissive license makes a fork viable.

## 10. Fallback
Fork IronCalc (vendor `base` + `xlsx` and patch what we need) rather than building a TS parser + formulajs. The plan's TS approach would take months to reach this coverage.

## What could not be measured
- **Real Tauri IPC:** proxy only.
- **WebView2 itself:** headless Edge was the stand-in; browser memory was not measured.
- **Real Excel-made files:** the corpus comes from xlsxwriter, and no Excel or LibreOffice was available to cross-check.
- **1M-row CSV in WASM:** not run; about 15 s is an extrapolation.
- **Function edge cases:** one happy-path case per function.
- **wasm-opt:** not applied to the `main` WASM build.
- **Scroll / fps:** that is Spike B.

## How to run
Run `./run_all.sh` in Git Bash from `C:/Dev/Proyectos/sheetlight-spikes/ironcalc`. It:
- creates `.venv` and the corpus
- clones IronCalc `main` into `upstream/`
- builds `bench-native` (0.8.3) and `bench-native-main` (same source with feature `main`)
- runs `load`, `chain`, `revchain`, `csv`, `funcs`, `api` and `roundtrip`
- runs `fidelity.py`
- runs the WASM benches: `bench-wasm/node-bench.mjs` and `bench-wasm/browser-bench.mjs` (Edge Web Worker)

`size-probe/` is the minimal exe used for the binary-size number. The self-built WASM needs `rustup target add wasm32-unknown-unknown` and `cargo install wasm-bindgen-cli --version 0.2.126`; both are already installed on this machine.
