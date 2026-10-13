# Sheetlight — Product & Engineering Plan

A lightweight, fast, local spreadsheet app for Windows. Sister app of Doclight
(`C:\Dev\Proyectos\doclight`). Goal: replace LibreOffice Calc for day-to-day use.
Public GitHub repo, MIT license, author `sergiiopm`. App UI in Spanish (like Doclight).

## Use cases (priority order)
1. Opening and reading reports, finance sheets, budgets, lists (.xlsx from Excel/others)
2. Large CSV files opened and browsed instantly
3. Editing with formulas and formatting, saving back to .xlsx
4. Reports with charts (view charts from .xlsx; create basic charts)

## Decisions
- Name: **Sheetlight**. Identifier `com.sheetlight.app`.
- Formula syntax: **English (en-US)** — `=SUM(A1:A5,2)`, `,` argument separator, `.` decimal in formulas.
  Cell value entry/display: number/date display follows a locale setting (default: Windows regional settings, likely es-ES).
- .ods: low priority (import only, after v0.1). .xls (legacy): import only.
- Stack: Tauri 2 + React 19 + TypeScript + Vite + Tailwind 4 + Radix + lucide (same as Doclight).
- Grid: custom **canvas-based virtualized renderer** (no DOM-per-cell grids).
- Formula engine: **IronCalc** (Rust, MIT/Apache) — to be validated in Phase 0.
  Fallback: own TS parser + dependency graph + `formulajs`.
- Engine is hidden behind a `WorkbookEngine` TypeScript contract so it is swappable.

## Performance targets (acceptance criteria)
| Metric | Target |
|---|---|
| Cold start | < 1 s |
| Open 10 MB .xlsx (~100k rows x 20 cols) | < 2 s |
| Open 1M-row CSV | < 5 s, browsable while/after loading |
| Scroll / selection | 60 fps, also at 1M rows |
| Recalc 100k chained formulas | < 200 ms |
| Idle RAM | < 150 MB |
| Installer | < 15 MB |

## Scope

### v0.1 (MVP)
- Grid: smooth scroll, resize/hide/insert/delete rows & cols, freeze panes, zoom
- Excel-like keyboard nav: Ctrl+arrows, Shift-select, Ctrl/Shift+Space, Tab/Enter, F2, Ctrl+Home/End, Ctrl multi-select
- In-cell editor + formula bar, function autocomplete with signature help, colored range refs, click-to-reference
- ~150 most-used functions, absolute refs, cross-sheet refs, error values
- Fill handle (copy + series: numbers, dates, months)
- Formatting: number formats (general, number, currency, %, date, custom), bold/italic/underline, font & fill color, borders, alignment, wrap, merge, format painter
- Sheet tabs: add/rename/delete/duplicate/reorder
- Clipboard interop with Excel / Google Sheets / LibreOffice (TSV + HTML), paste values
- Undo/redo, find & replace, sort, **autofilter**
- Status bar: sum / average / count of selection
- **Basic charts**: bar, column, line, pie — create from selection; display charts embedded in .xlsx
- Files: open/save .xlsx and .csv (fast path for big CSV); open .xls (save as .xlsx)
- Multi-document tabs, "Open with" file associations, recent files, light/dark theme
- Warn when an opened file contains features that would be lost on save

### v0.2
Conditional formatting, data validation (dropdowns), print / export PDF, notes, hyperlinks, named ranges, more chart types, .ods import.

### v0.3+
Simple pivot tables, images, formatted tables, .ods save.

### Out of scope
Macros/VBA, Power Query, real-time collaboration, cloud, accounts.

## Architecture
```
sheetlight/
  src/
    grid/        canvas renderer, viewport, hit-testing, selection, scroll, resize
    editor/      in-cell editor, formula bar, autocomplete, ref highlighting
    engine/      WorkbookEngine contract + IronCalc adapter (worker or native)
    model/       commands, undo/redo, selection state, clipboard
    files/       open/save xlsx, csv, xls
    charts/      chart model + renderer
    components/  toolbar, sheet & document tabs, status bar, dialogs
    lib/         number formats, locale, theme, utils
  src-tauri/     native I/O, file associations, dialogs (and possibly native engine)
  tests/         real-world .xlsx corpus, e2e, benchmarks
```

## Phases
0. **Spikes (parallel)**: A) IronCalc evaluation; B) canvas grid prototype; C) project scaffold from Doclight. Gate: user reviews numbers.
1. **Foundations** (orchestrator): contracts (`WorkbookEngine`, `GridModel`, `Command`, `SelectionState`), command/undo system, test corpus.
2. **Parallel build** (worktrees): WS1 Grid, WS2 Engine, WS3 Files, WS4 UI shell, WS5 QA/benchmarks, WS6 Charts.
3. **Integration** (orchestrator) — MVP passes benchmarks.
4. **Polish (parallel)**: clipboard, sort/filter, find/replace, advanced formatting, shortcuts.
5. **Cross review**: code review agents, perf audit, user's real files.
6. **Release**: NSIS installer, versioning, README, public GitHub repo, v0.1.0.

## Risks
- IronCalc is 0.x: gaps / API churn → Phase 0 validation, swappable contract, fallback ready.
- .xlsx save fidelity (charts, images, pivots, cond. formats may be dropped) → detect & warn; consider preserving unknown parts of the original package.
- Large CSV memory use in engine → possible columnar fast path for CSV.
- Excel-like interaction details (IME, selection, clipboard) → dedicated QA workstream with Excel behavior spec.
