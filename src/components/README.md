# src/components

React user interface around the grid (WS4). UI text is in Spanish. Logic
lives in `src/hooks` (the `AppController`); components only render stores
and run registry commands, so toolbar, menus and shortcuts always agree.

- `ui/` — shadcn-style primitives (Radix + Tailwind), shared with Doclight
- `controller-context.tsx` — `useController()`
- `Toolbar.tsx` — ribbon-lite: Archivo menu (`FileMenu.tsx`), quick access
  (guardar, deshacer, rehacer) and the Inicio / Insertar / Formato / Datos /
  Vista tabs; `CommandButton`, `CommandMenuItem`, `SplitButton`,
  `ColorPalette` are its building blocks
- `TabBar.tsx` — open workbooks (document tabs), drag to reorder
- `WorkbookView.tsx` — one document: the editor's formula bar + name box,
  `SpreadsheetGrid`, the in-cell editor, fidelity/CSV banners and the chart
  overlay slot (`data-chart-slot`)
- `SheetTabs.tsx` — sheet tabs: add, rename inline, delete, duplicate,
  reorder by drag, tab color, hide/unhide
- `StatusBar.tsx` — mode, CSV loading progress, Promedio/Recuento/Suma, zoom
- `GridContextMenu.tsx`, `FilterMenu.tsx`, `AnchoredMenu.tsx` — context
  menus for cells and headers, autofilter dropdown
- `dialogs/` — Formato de celdas, Buscar y reemplazar (modeless), Ir a,
  Ordenar, Insertar/Eliminar celdas, Pegado especial, alto/ancho, hojas,
  opciones de importación CSV, Opciones, Acerca de; `DialogHost.tsx`
  lazy-loads them
- `UnsavedDialog.tsx`, `Notices.tsx` — unsaved-changes prompt, toasts
