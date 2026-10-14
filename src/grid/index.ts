/**
 * Public surface of the grid (WS1). Other modules import only from here;
 * everything else in `src/grid` is internal.
 */
export { SpreadsheetGrid, useGridViewport } from "./SpreadsheetGrid";
export type { SpreadsheetGridProps } from "./SpreadsheetGrid";
export type {
  EditRequest,
  GridContextMenuEvent,
  GridHandle,
  GridProps,
  GridViewport,
  RefHighlight,
  ReferencePicker,
} from "./api";
export { MAX_ZOOM, MIN_ZOOM } from "./core/Viewport";
