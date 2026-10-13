# Sheetlight — notes for coding agents

Lightweight, fast, local spreadsheet app for Windows. Sister app of Doclight
(`C:\Dev\Proyectos\doclight`, same author and conventions). The product and
engineering plan lives in `docs/PLAN.md`; read it before larger changes.

## Stack

- Tauri 2 (Rust, `src-tauri/`) + React 19 + TypeScript (strict) + Vite
- Tailwind CSS 4, Radix primitives, shadcn-style components in `src/components/ui`, lucide-react icons
- Vitest for unit tests
- Formula engine: IronCalc (under evaluation), always behind the `WorkbookEngine` contract

## Folder responsibilities

| Folder | Responsibility |
| --- | --- |
| `src/grid` | Canvas-based virtualized grid: viewport, rendering, hit-testing, selection, resize, scroll |
| `src/editor` | In-cell editor, formula bar, autocomplete, colored range refs |
| `src/engine` | `WorkbookEngine` contract + engine adapter (worker or native) |
| `src/model` | Commands, undo/redo, selection state, clipboard, `GridModel` |
| `src/files` | Open/save `.xlsx`, `.csv`, `.xls`; native byte I/O and dialogs |
| `src/charts` | Chart model and renderer |
| `src/components` | Toolbar, document and sheet tabs, formula bar shell, status bar, dialogs; `ui/` primitives |
| `src/hooks` | App-level React hooks (workbook tabs, shortcuts) |
| `src/lib` | Number formats, locale, theme, small utilities |
| `src-tauri` | Native window, single instance, file associations (NSIS hooks), local file I/O |
| `tests` | Unit tests (`tests/unit`), workbook corpus, e2e, benchmarks |

Each folder has a `README.md`; keep it current when its responsibility changes.

## Commands

```bash
npm install
npm run tauri dev     # run the desktop app with hot reload
npm run build         # type-check (tsc) + Vite build
npm test              # Vitest (single run)
npm run tauri build   # release build + NSIS installer in src-tauri/target/release/bundle/nsis/
cd src-tauri && cargo test   # Rust unit tests
```

Before finishing a change, `npm run build` and `npm test` must pass.

## Conventions

- **Language:** UI text is in **Spanish** (labels, tooltips, dialogs, error messages,
  including errors returned by Rust commands). Code, identifiers, comments,
  commit messages and docs are in **English**.
- **Formula syntax is en-US:** `=SUM(A1:A5,2)` — `,` separates arguments and `.`
  is the decimal separator inside formulas. Display and entry of cell values
  follow the locale setting (default: Windows regional settings, likely es-ES).
- **TypeScript is strict** (`strict`, `noUnusedLocals`, `noUnusedParameters`).
  No `any` unless unavoidable and commented.
- Import app code through the `@/` alias (`@/files/path`, `@/components/ui/button`).
- Performance matters (targets in `docs/PLAN.md`): no DOM-per-cell rendering,
  avoid per-cell allocations in hot paths, keep large data out of React state.
- Modules talk through contracts (`WorkbookEngine`, `GridModel`, `Command`,
  `SelectionState`); do not reach into another module's internals.
- Keep dependencies lean; check that a new dependency is justified (installer target < 15 MB).

## Versioning

The version must be bumped **together** in all three places:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml` (then let `Cargo.lock` update)

Keep the Tauri npm packages (`@tauri-apps/api`, `@tauri-apps/plugin-*`) on the
same minor version as the matching Rust crates, or `tauri build` fails.

## Native file plumbing (from Doclight)

- `read_file_b64` / `write_file_b64` (`src-tauri/src/files.rs`) move bytes as base64;
  `src/files/native.ts` wraps them.
- Files passed on the command line ("Open with") are queued in Rust and fetched
  once by the frontend with `take_launch_paths`.
- `tauri-plugin-single-instance`: a second launch emits `open-files` to the running
  window instead of opening a new one.
- File associations: `bundle.fileAssociations` in `tauri.conf.json` plus
  `src-tauri/windows/hooks.nsh` (ProgIDs `Sheetlight.Xlsx`, `Sheetlight.Xls`,
  `Sheetlight.Csv`). Keep both in sync when adding a format.
