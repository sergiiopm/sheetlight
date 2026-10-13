# Sheetlight

A lightweight, fast local spreadsheet app for Windows.

> **Work in progress.** Sheetlight is in its first development phase. The app
> shell, file associations and installer are in place; the grid, formula engine
> and file import/export are not implemented yet. See [`docs/PLAN.md`](docs/PLAN.md).

Open a workbook, browse it instantly, edit cells and formulas, and save it. No accounts, no cloud, no ribbon. Sister app of [Doclight](https://github.com/sergiiopm/doclight).

> The app interface is in Spanish.

## Planned for v0.1

- Opens and saves `.xlsx` and `.csv` (with a fast path for very large CSV files); opens `.xls`
- Smooth canvas-based grid that stays fast with a million rows
- Excel-like keyboard navigation, formula bar, function autocomplete
- Around 150 of the most used functions, using English formula syntax (`=SUM(A1:A5,2)`)
- Number formats, fonts, colors, borders, alignment, merge, format painter
- Sort, autofilter, find and replace, undo and redo
- Clipboard interop with Excel, Google Sheets and LibreOffice
- Basic charts (bar, column, line, pie)
- Light and dark themes
- Registers itself under **Open with** for `.xlsx`, `.xls` and `.csv`

## Requirements (for building)

- Node.js 18 or later
- Rust (stable, MSVC toolchain on Windows)
- Visual Studio Build Tools with C++

## Development

```bash
npm install
npm run tauri dev
```

Run the tests:

```bash
npm test
```

## Building the installer

```bash
npm run tauri build
```

The NSIS installer is written to `src-tauri/target/release/bundle/nsis/`. The executable is named **Sheetlight**.

## Architecture

- `src/grid` — canvas renderer, viewport, hit-testing, selection
- `src/editor` — in-cell editor, formula bar, autocomplete
- `src/engine` — `WorkbookEngine` contract and formula engine adapter
- `src/model` — commands, undo/redo, selection state, clipboard
- `src/files` — opening and saving `.xlsx`, `.csv` and `.xls`
- `src/charts` — chart model and renderer
- `src/components` — toolbar, tabs, status bar, dialogs
- `src/lib` — number formats, locale, theme, utilities
- `src-tauri` — native window, file associations and local file I/O
- `tests` — unit tests, real-world workbook corpus, benchmarks

## License

[MIT](LICENSE) © sergiiopm
