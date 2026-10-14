# Sheetlight — Architecture & contracts

Companion of `docs/PLAN.md`. This file is the rulebook for everyone writing code
(humans and agents): module boundaries, contracts, data flow and how work lands
on `main`.

## 1. Big picture

```
┌──────────────────────────── webview (React, TS) ────────────────────────────┐
│ components/ (shell: toolbar, tabs, dialogs, status bar)                     │
│   │ mounts                                                                  │
│   ├─ grid/  <SpreadsheetGrid>  ── GridHandle ──┐                            │
│   ├─ editor/ formula bar + in-cell editor ─────┤ uses                       │
│   └─ charts/ chart layer over the grid         │                            │
│ model/  SelectionStore · CommandRegistry       │                            │
│ engine/ WorkbookEngine contract ── TauriEngine (prod) / MemoryEngine (fake) │
└──────────────────────────────│ Tauri IPC (JSON + binary blocks) + events ───┘
┌──────────────────────────────▼ Rust (src-tauri) ────────────────────────────┐
│ engine/   actor thread · DocumentBackend trait · IronCalc workbook backend  │
│ csv_store/  typed-column store for big CSVs (implements DocumentBackend)    │
│ xlsx_package/  fidelity layer (inspect / post_process) · .xls import        │
│ charts/   DrawingML chart XML <-> ChartDraft                                │
│ files.rs, lib.rs  window, single instance, "Open with", dialogs             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Key decisions (details in `docs/spikes/`):
- IronCalc runs **natively** in Rust, pinned to git rev `341ec87`. One engine
  thread (actor) owns all documents; Tauri commands send it messages.
- The UI never formats values. The engine returns locale-formatted display
  strings (es) and resolved render styles; formulas are en-US.
- File bytes never cross into the webview: the engine opens/saves by path.
- Grid data moves as **binary blocks** of 64×16 cells (`src/engine/block-codec.ts`).
- Undo/redo lives in the engine. One `apply(ops)` = one undo step.

## 2. Contracts (Phase 1 — change only with the orchestrator)

| Contract | File | Notes |
|---|---|---|
| Cell addressing | `src/engine/types.ts` | 0-based rows/cols, `CellRange {r0,c0,r1,c1}` inclusive, A1 helpers |
| `WorkbookEngine` + all DTOs, ops, events | `src/engine/contract.ts` | async; errors are `EngineError {code, message(es)}` |
| Rust mirror of the above | `src-tauri/src/engine/types.rs` | serde camelCase; tests pin the JSON shape |
| Binary blocks | `src/engine/block-codec.ts` ⇄ `src-tauri/src/engine/blocks.rs` | golden fixture `tests/fixtures/blocks-golden.bin` checked by both |
| Backend seam | `src-tauri/src/engine/backend.rs` | `DocumentBackend` trait, `EventSink`, `ImportedWorkbook` |
| Tauri commands | `src-tauri/src/engine/commands.rs` | `engine_<method>` per `WorkbookEngine` method; event `engine://event` |
| Fidelity / xls | `src-tauri/src/xlsx_package/mod.rs` | `inspect`, `post_process`, `import_xls` |
| Chart XML | `src-tauri/src/charts/mod.rs` | `parse_chart_xml`, `write_chart_xml` |
| Selection | `src/model/selection.ts` | `SelectionState` (Excel semantics) + `SelectionStore` |
| Commands | `src/model/commands.ts` | `CommandRegistry`, stable ids, `Mod+B` shortcut syntax |
| Grid API | `src/grid/api.ts` | `GridProps`, `GridHandle`, `EditRequest`, `RefHighlight`, `ReferencePicker` |
| Test fake | `src/engine/memory-engine.ts` | in-memory `WorkbookEngine` (no formulas) for tests and browser dev |

If a contract is wrong or missing something, **do not work around it**: make
the smallest additive change in both TS and Rust mirrors, note it in the PR
description under "Contract changes", and keep existing fields compatible.

## 3. Workstreams and ownership (Phase 2)

Each workstream works in its own git worktree and branch and only edits the
paths it owns. Shared files (`package.json`, `Cargo.toml`, `src-tauri/src/lib.rs`,
`src/App.tsx`, `CLAUDE.md`) get **small, additive** edits only; the orchestrator
resolves conflicts at merge time.

| WS | Branch | Owns | Delivers |
|---|---|---|---|
| WS1 Grid | `ws1/grid` | `src/grid/**`, `tests/grid/**` | spike grid promoted & refactored; `SpreadsheetGrid` + `GridHandle`; engine data source with `BlockCache`; selection on `SelectionStore`; fill-handle drag; ref highlights; reference picker; copy marquee; a11y layer; blit pixel test in CI |
| WS2 Engine | `ws2/engine` | `src-tauri/src/engine/**`, `src/engine/tauri-engine.ts` | actor; IronCalc workbook backend (all ops incl. sort/find/replace/fill series/autofilter model/clipboard); es display formatting; render style table; binary blocks; undo/redo; promotion from CSV; save via `xlsx_package::post_process`; `TauriEngine` TS adapter |
| WS3 Files | `ws3/files` | `src-tauri/src/csv_store/**`, `src-tauri/src/xlsx_package/**`, `src-tauri/src/files.rs`, `src/files/**` | CSV store (streaming, typed, detect encoding/delimiter/decimal); fidelity inspect + post_process; `.xls` import; atomic writes |
| WS4 Shell | `ws4/shell` | `src/components/**`, `src/hooks/**`, `src/App.tsx`, `src/lib/theme.ts`, `src/lib/settings.ts` | app layout; ribbon-lite toolbar; document tabs & sheet tabs (rename/reorder/color…); status bar stats; context menus; dialogs (unsaved, fidelity warnings, format cells, CSV import options, find/replace UI); command registration & shortcuts; settings; recent files; open/save flows |
| WS5 QA | `ws5/qa` | `tests/corpus/**`, `tests/e2e/**`, `tests/bench/**`, `.github/**`, `docs/qa/**` | corpus generator + real-world-like files; Excel behavior spec; GitHub Actions CI (Windows: tsc, vitest, cargo test, clippy); engine benchmarks vs PLAN targets; e2e harness |
| WS6 Charts | `ws6/charts` | `src/charts/**`, `src-tauri/src/charts/**` | chart XML parse/write; chart renderer (canvas) anchored over the grid; create-chart dialog from selection; move/resize/delete |
| WS7 Editor | `ws7/editor` | `src/editor/**`, `src/lib/locale.ts`, `src/lib/number-formats.ts` | in-cell editor + formula bar (shared edit session); locale input parsing (es) & edit text; function catalog (~150, Spanish descriptions); autocomplete + signature help; colored refs + reference picking; F4 cycling; IME-safe |

Integration (Phase 3) is done by the orchestrator on `main`.

### Who calls whom

- Shell builds one `WorkbookSession` per open document: `{ engine, doc, sheets, activeSheet, selection: SelectionStore, grid: GridHandle | null }`.
- Grid → engine: only reads (`getSheetInfo`, `fetchBlocks`, `getStyles`, `findDataEdge`, `getColumnTextSamples`) + `subscribe`. Mutations go out through `GridProps.onApply(ops)`.
- Editor → engine: `getCell` (to start editing), `apply([{type:"setCells"…}])` on commit, `listFunctions`.
- Editor ↔ grid: `GridHandle.getCellRect`, `setRefHighlights`, `setReferencePicker`, `focus`.
- Commands (shell) → engine `apply` / `undo` / `redo` / `copy`; they read `SelectionStore`.
- After `apply`/`undo`/`redo`, if `ApplyResult.selection` is set, the caller applies it to the `SelectionStore`.
- Charts → engine: `getCharts`, `getRangeValues`, `apply([{type:"addChart"…}])`; draws in a layer positioned with `GridHandle`.

## 4. Data flows

**Open:** shell `engine.openDocument(path)` → Rust actor: by extension → xlsx:
read bytes, `xlsx_package::inspect`, IronCalc load → workbook backend; csv:
`csv_store::open` (streams, emits `loadProgress`); xls: `import_xls` → workbook.
Returns `DocumentInfo` with `warnings`; shell shows the fidelity banner.

**Render:** grid computes visible block keys → `fetchBlocks` (binary) →
`BlockCache` → canvas. Unknown style ids → `getStyles`. On `engine://event`
`cells`/`sheetData` the grid marks blocks stale and refetches what is visible
(using `knownVersions` to skip unchanged ones).

**Edit:** editor commits → `apply([setCells])` → actor: backend applies,
IronCalc recalculates (full recalc, ~150 ms worst case on 2M cells) → events
→ grid refetch. `ApplyResult` updates dirty/undo state.

**Save:** `saveDocument(path, {format})` → xlsx: IronCalc writes fresh bytes →
`xlsx_package::post_process` re-inserts preserved parts + charts → atomic
write (temp file + rename). csv: `backend.write_csv`.

## 5. Conventions for all workstreams

- **Commits: Conventional Commits** with the workstream scope, small and focused:
  `feat(grid): …`, `fix(engine): …`, `test(files): …`, `refactor(editor): …`,
  `perf(grid): …`, `docs: …`, `build: …`, `ci: …`, `chore: …`.
  Body explains *why* when it is not obvious. Every commit ends with the
  co-author trailer used in this repo.
- Commit early and often on your branch; push it (`git push -u origin <branch>`).
  When done, open a PR to `main` with `gh pr create` (title in Conventional
  Commit form; body: summary, contract changes, how it was tested, known gaps).
  Do not merge it yourself.
- `npm run build`, `npm test` and `cargo test` (in `src-tauri`) must pass before
  every push. `cargo clippy` should be clean for new Rust code.
- **Do not open GUI windows** (`tauri dev`, headed browsers) — the user is
  working on this PC. Headless Playwright/Chromium is fine. Visual checks in
  the real app are done by the orchestrator.
- **Disk is limited** (~25 GB free): debug builds only, never `tauri build` or
  `cargo build --release` in a worktree; don't copy corpora > 20 MB into git
  (generate them in `tests/corpus/generated/`, git-ignored).
- UI text in Spanish; code, comments, docs, commits in English. TS strict, no `any`.
- Hot paths: no per-cell allocations, no React state for cell data.
