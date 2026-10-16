# Sheetlight

A lightweight, fast local spreadsheet app for Windows.

Open a workbook, browse it instantly, edit cells and formulas, and save it. No accounts, no cloud, no ribbon. Sister app of [Doclight](https://github.com/sergiiopm/doclight).

> The app interface is in Spanish.

## Download

Grab the installer from the [latest release](https://github.com/sergiiopm/sheetlight/releases/latest). It installs for the current user only, so it doesn't need admin rights.

## Features

- Opens and saves `.xlsx` and `.csv`, including CSVs that use `;` separators and decimal commas
- Formula engine powered by [IronCalc](https://github.com/ironcalc/IronCalc), with instant recalculation
- Fast canvas grid that scrolls smoothly through large sheets
- Ribbon with cell formatting, borders, colours, number formats, filters, sorting, find and replace
- Multiple sheets per workbook, and multiple workbooks open in tabs
- Charts: create them from **Insertar → Gráfico**, and charts in Excel files are kept
- Can be set as the default app for Excel files

Known issues are listed in the [release notes](https://github.com/sergiiopm/sheetlight/releases/latest), and what's next lives in [`docs/PLAN.md`](docs/PLAN.md).

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
