# src/hooks

The shell's logic (WS4), mostly framework independent so it is unit-tested
without a DOM (`tests/shell/`). React components read it through tiny
observable stores (`store.ts`, `useStore`).

| File | Responsibility |
| --- | --- |
| `app-controller.ts` | `AppController`: owns the `SessionManager`, the `CommandRegistry`, dialogs/menus/notices stores, active-cell details for toolbar toggles, keyboard routing, clipboard, format painter, chart insert |
| `app-commands.ts` | Every shell action as a registry command with a stable id and its Excel shortcut |
| `actions/*` | Format, data (insert/delete, sort, filter, sizes), sheet, view and find/replace/go-to actions |
| `session-manager.ts` | Open documents: new/open/save/save as/close, unsaved-changes walk, "Open with", engine event routing, `apply` (one undo step) |
| `workbook-session.ts` | `WorkbookSession`: one document tab (info, selection per sheet, viewport per sheet, CSV load progress, edit mode, mounted grid/editor) |
| `selection-ops.ts` | Pure selection → `EngineOp` helpers (structure, styles, merges, references, sheet names) |
| `selection-stats.ts` | Status bar Promedio/Recuento/Suma tracker and CSV loading labels |
| `format-cells.ts` | "Formato de celdas" draft state and the ops for its OK button |
| `clipboard.ts` | Copy/cut/paste flow with the system clipboard (TSV + HTML) and the internal clip |
| `shortcuts.ts` | Layout-independent shortcut matching, aliases, Spanish key labels |
| `chart-integration.ts` | Injection point for charts (WS6): overlay layer + "Insertar > Gráfico" handler |
| `file-gateway.ts` | File pickers behind an interface (tests stub them) |
| `use-app-controller.ts` | Creates the controller once and wires the window: keys, paste, theme, title, "Open with", second instance, drag & drop, close request |
| `use-commands.ts`, `use-settings.ts`, `store.ts` | React glue |

## Charts (for the orchestrator)

```ts
const controller = await getAppController();
controller.charts.setLayer(ChartLayer);              // rendered in WorkbookView's chart slot
controller.charts.setInsertHandler(openChartDialog); // enables "Insertar > Gráfico" (Alt+F1)
```
