# src/files

Opening and saving workbooks.

Current contents (ported from Doclight):

- `native.ts` — read/write file bytes through Tauri commands, open/save dialogs,
  browser fallbacks for `npm run dev` without Tauri
- `path.ts` — file names, format detection, untitled names (`Libro1.xlsx`)
- `types.ts` — supported formats and dialog filters

Planned:

- `.xlsx` read/write (warn when a file contains features that would be lost on save)
- `.csv` fast path for very large files (streaming / columnar)
- `.xls` import only (saved back as `.xlsx`)

Note: bytes currently cross the IPC boundary as base64, as in Doclight. For
large files switch to raw binary IPC (`tauri::ipc::Response` / raw request
bodies) or let Rust parse the file directly.
