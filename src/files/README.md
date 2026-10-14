# src/files

Opening and saving workbooks, frontend side. Workbooks themselves are opened
and saved **by path inside the engine** (Rust): `.xlsx` through IronCalc plus
the fidelity layer (`src-tauri/src/xlsx_package`), `.csv` through the
typed-column store (`src-tauri/src/csv_store`), `.xls` through calamine. All
saves are atomic (temp file + rename, `src-tauri/src/files.rs`).

- `native.ts` — raw binary IPC for small side files (`read_file_bytes`,
  `write_file_bytes`, atomic), open/save dialogs, browser fallbacks for
  `npm run dev` without Tauri
- `path.ts` — file names, format detection (`.xlsm` opens as xlsx), untitled
  names (`Libro1.xlsx`), default save path for legacy formats
- `types.ts` — supported formats and dialog filters
- `csv.ts` — CSV option choices and labels (delimiter, encoding, decimal
  separator) for the import/save dialogs; save options that keep what was
  detected on open
- `fidelity.ts` — Spanish wording for `FidelityWarning`s (open banner) and
  `SaveResult.lost` (after save)
