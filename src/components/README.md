# src/components

React user interface around the grid. UI text is in Spanish.

- `ui/` — shadcn-style primitives (Radix + Tailwind), shared with Doclight
- `Toolbar.tsx`, `ToolbarButton.tsx` — top toolbar (groups: Archivo, Edición,
  Formato, Insertar)
- `TabBar.tsx` — open workbooks (document tabs), ported from Doclight
- `FormulaBar.tsx` — name box + formula input (placeholder)
- `SheetTabs.tsx` — sheet tabs of the active workbook (placeholder)
- `StatusBar.tsx` — status line; will show sum / average / count of the selection
- `UnsavedDialog.tsx` — "unsaved changes" prompt, ported from Doclight, to be
  wired when workbooks can be edited
