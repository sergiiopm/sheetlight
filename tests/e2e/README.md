# End-to-end tests

Status (2026-10-14): **not started on purpose**. An app-level e2e needs the
shell (WS4: toolbar, tabs, open/save flows) wired to the grid, the editor and
the native engine, which happens in the Phase 3 integration on `main`.

What already covers the layers end to end, headless:

| Layer pair | Tests |
|---|---|
| Engine actor ⇄ files on disk (open → edit → save → reopen) | `src-tauri/tests/engine_roundtrip.rs` |
| Engine actor ⇄ corpus expectations | `src-tauri/tests/engine_corpus.rs`, `engine_functions.rs`, `excel_behavior.rs` |
| Grid ⇄ real Chromium (mouse, keyboard, pixels) | `tests/grid/browser/*.test.ts` |
| Editor session ⇄ grid handle | `tests/editor/session.test.ts` |

Plan once the shell is on `main`:

1. Serve the app with `MemoryEngine` (or the native engine through
   `tauri-driver` on Windows CI) and drive it with Playwright using the
   runner's Chrome/Edge (`SHEETLIGHT_CHROMIUM`, see
   `tests/grid/browser/browser-env.ts`).
2. Scenarios from `docs/qa/excel-behavior.md`: open a corpus file, type in
   Spanish (`1.234,5`, `14/02/2025`), fill handle, copy/paste between cells,
   undo, save, reopen.
3. Outputs go to `tests/e2e/.output/` (git-ignored).
