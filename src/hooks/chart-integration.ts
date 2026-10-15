import type { ComponentType } from "react";
import type { EngineOp, WorkbookEngine } from "@/engine/contract";
import type { DocumentId, SheetId } from "@/engine/types";
import type { GridHandle } from "@/grid/api";
import type { SelectionState } from "@/model/selection";
import { createStore, type Store } from "@/hooks/store";

/**
 * Seam for the charts workstream (WS6, `src/charts`). The shell never imports
 * chart code: the orchestrator plugs it in at start-up with
 *
 * ```ts
 * const controller = await getAppController();
 * controller.charts.setLayer(ChartLayer);               // overlay over the grid
 * controller.charts.setInsertHandler(openChartDialog);  // "Insertar > Gráfico"
 * ```
 *
 * The layer is rendered by `WorkbookView` inside the grid area (the
 * `data-chart-slot` element), once per mounted grid, with `ChartLayerProps`.
 * It may draw in `grid.getOverlayHost()` (portal) and position charts with
 * `grid.getRangeRect`.
 */

/** Applies ops through the shell (one undo step, dirty state, Spanish errors). */
export type ShellApply = (ops: ReadonlyArray<EngineOp>) => Promise<unknown>;

export interface ChartLayerProps {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  /** Null until the grid has mounted. */
  readonly grid: GridHandle | null;
  readonly apply: ShellApply;
}

export interface ChartInsertContext {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly selection: SelectionState;
  readonly grid: GridHandle | null;
  readonly apply: ShellApply;
}

export type ChartInsertHandler = (context: ChartInsertContext) => void | Promise<void>;

export class ChartIntegration {
  readonly layer: Store<ComponentType<ChartLayerProps> | null> = createStore<ComponentType<ChartLayerProps> | null>(null);
  readonly insertHandler: Store<ChartInsertHandler | null> = createStore<ChartInsertHandler | null>(null);

  setLayer(layer: ComponentType<ChartLayerProps> | null): void {
    this.layer.set(layer);
  }

  setInsertHandler(handler: ChartInsertHandler | null): void {
    this.insertHandler.set(handler);
  }
}
