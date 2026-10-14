# src/charts

Charts (WS6): chart model on top of the engine contract, a Canvas 2D renderer
with Excel 2013+ default styling, the chart layer drawn over the grid, and the
create/edit dialog. The DrawingML side (parse/write of `xl/charts/chartN.xml`)
lives in `src-tauri/src/charts`.

## Integration (shell)

```tsx
import { ChartLayer, createChartFromSelection } from "@/charts";

// Next to <SpreadsheetGrid ref={setGrid} …/>, once per open document:
<ChartLayer engine={engine} doc={doc} sheet={activeSheet} grid={grid} readOnly={readOnly} onError={toast} />

// "Insertar > Gráfico" handler (or `registerChartCommands(registry, getCtx)` for `chart.insert`):
createChartFromSelection({ engine, doc, sheet: activeSheet, selection });
```

- `ChartLayer` puts one absolutely positioned element per chart in
  `grid.getOverlayHost()` and keeps it on its cell anchor through scroll, zoom
  and geometry changes (`grid.subscribeViewport`, `getRangeRect`). React only
  renders the dialog and the context menu.
- Charts are reloaded on `charts`/`structure` events and redrawn when cells
  they read change (`cells`, `sheetData`, `sheets` events).
- Mouse: click selects, drag moves, handles resize (Shift keeps the aspect
  ratio), double click edits, right click opens the context menu.
  Keyboard on a selected chart: Delete/Backspace deletes, Enter edits, Esc
  returns focus to the grid. Every change is one `apply` (undoable).
- `createChartFromSelection` asks the mounted layer of the document to open
  the "Crear gráfico" dialog (`CreateChartDialog`) for the selection; a single
  cell expands to its current region. Returns false if no layer is mounted.

## Files

| File | Role |
| --- | --- |
| `ChartLayer.tsx` | React host: controller lifecycle, dialog, context menu |
| `controller.ts` | Imperative layer: DOM per chart, selection, drag/resize, mutations |
| `ChartDialog.tsx` | Create/edit dialog with live preview (exported as `CreateChartDialog`) |
| `commands.ts` | `chart.insert` command, `createChartFromSelection`, insert requests |
| `data.ts` | Resolves series refs to values (`getRangeValues`), dependencies |
| `infer.ts` | Excel-like series inference from a block, current region, trimming |
| `refs.ts` | Parse/format `Hoja1!$B$2:$B$13` references |
| `geometry.ts` | Anchor ⇄ pixel box conversions |
| `render.ts`, `scale.ts`, `theme.ts` | Layout, axis scales (es-ES ticks), palette and drawing |
| `chart-canvas.ts`, `ChartPreview.tsx` | HiDPI canvas wrapper, PNG export, preview component |
| `variants.ts` | Chart type gallery (type + grouping) |

Tests: `tests/charts/**` (Vitest) and `src-tauri/src/charts/**` (`cargo test`).
