import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartSpec, SheetMeta, WorkbookEngine } from "@/engine/contract";
import type { CellRange, DocumentId, SheetId } from "@/engine/types";
import type { GridHandle } from "@/grid/api";
import { ChartContextMenu } from "@/charts/ChartContextMenu";
import { ChartDialog, type ChartDialogEdit, type ChartDialogInsert, type ChartDraftFields } from "@/charts/ChartDialog";
import { onChartInsertRequest, type ChartInsertRequest } from "@/charts/commands";
import { ChartLayerController } from "@/charts/controller";
import { anchorNextTo } from "@/charts/geometry";
import { currentRegion, trimEmpty } from "@/charts/infer";

export interface ChartLayerProps {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly grid: GridHandle | null;
  readonly readOnly?: boolean;
  /** Optional sink for user-facing errors (Spanish). */
  readonly onError?: (message: string) => void;
}

type DialogState = { request: ChartDialogInsert | ChartDialogEdit; sheets: ReadonlyArray<SheetMeta> };
type MenuState = { chart: ChartSpec; x: number; y: number };

/** Largest block read to infer series from a selection (whole columns are clamped to the used range first). */
const MAX_INSERT_CELLS = 200_000;

/** Turns the selection into the block of cells to chart (Excel: a single cell expands to its current region). */
async function sourceBlock(engine: WorkbookEngine, doc: DocumentId, sheet: SheetId, req: ChartInsertRequest): Promise<CellRange | null> {
  const range = req.ranges[0];
  if (!range) return null;
  if (range.r0 === range.r1 && range.c0 === range.c1) {
    const region = await currentRegion(engine, doc, sheet, req.active);
    return region.r0 === region.r1 && region.c0 === region.c1 ? null : region;
  }
  const info = await engine.getSheetInfo(doc, sheet);
  const used = info.usedRange;
  if (!used) return null;
  const clamped = {
    r0: Math.max(range.r0, used.r0),
    c0: Math.max(range.c0, used.c0),
    r1: Math.min(range.r1, used.r1),
    c1: Math.min(range.c1, used.c1),
  };
  if (clamped.r0 > clamped.r1 || clamped.c0 > clamped.c1) return null;
  if ((clamped.r1 - clamped.r0 + 1) * (clamped.c1 - clamped.c0 + 1) > MAX_INSERT_CELLS) return clamped;
  return trimEmpty(await engine.getRangeValues(doc, sheet, clamped));
}

/**
 * Charts of one sheet, drawn over the grid. Mount it next to `<SpreadsheetGrid>`
 * with the grid's handle; it renders nothing in React except the chart dialog
 * and context menu (chart elements live in `grid.getOverlayHost()`).
 */
export function ChartLayer({ engine, doc, sheet, grid, readOnly = false, onError }: ChartLayerProps) {
  const controllerRef = useRef<ChartLayerController | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const openEdit = useCallback(async (chart: ChartSpec) => {
    const sheets = controllerRef.current?.getSheets() ?? (await engine.getDocumentInfo(doc)).sheets;
    setDialog({ request: { mode: "edit", chart }, sheets });
  }, [engine, doc]);

  useEffect(() => {
    if (!grid) return;
    const controller = new ChartLayerController({
      engine,
      doc,
      sheet,
      grid,
      readOnly,
      callbacks: {
        onEdit: (chart) => void openEdit(chart),
        onContextMenu: (chart, x, y) => setMenu({ chart, x, y }),
        onError: (message) => onErrorRef.current?.(message),
      },
    });
    controllerRef.current = controller;
    controller.start();
    return () => {
      controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
      setMenu(null);
    };
  }, [engine, doc, sheet, grid, readOnly, openEdit]);

  useEffect(
    () =>
      onChartInsertRequest(doc, (req) => {
        if (req.sheet !== sheet || readOnly) return;
        void (async () => {
          try {
            const [range, info] = await Promise.all([sourceBlock(engine, doc, sheet, req), engine.getDocumentInfo(doc)]);
            if (!range) {
              onErrorRef.current?.("Seleccione un rango con datos para crear el gráfico.");
              return;
            }
            setDialog({ request: { mode: "insert", range }, sheets: info.sheets });
          } catch {
            onErrorRef.current?.("No se pudo leer la selección.");
          }
        })();
      }),
    [engine, doc, sheet, readOnly],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  const closeDialog = useCallback(() => {
    setDialog(null);
    grid?.focus();
  }, [grid]);

  const submit = (fields: ChartDraftFields, source: { sheet: SheetId; range: CellRange } | null) => {
    const controller = controllerRef.current;
    const request = dialog?.request;
    setDialog(null);
    if (!controller || !request) return;
    if (request.mode === "edit") {
      void controller.updateChart({ ...request.chart, ...fields });
      return;
    }
    // Next to the data like Excel; data on another sheet: near the top-left of the view.
    const tl = grid?.getViewport().topLeft ?? { row: 0, col: 0 };
    const near: CellRange =
      source && source.sheet === sheet ? source.range : { r0: tl.row + 1, c0: tl.col, r1: tl.row + 1, c1: Math.max(0, tl.col - 1) };
    const anchor = anchorNextTo(grid, near);
    grid?.scrollIntoView({ row: anchor.from.row, col: anchor.from.col });
    void controller.addChart({ ...fields, sheet, anchor });
  };

  return (
    <>
      {dialog && (
        <ChartDialog
          engine={engine}
          doc={doc}
          sheet={sheet}
          sheets={dialog.sheets}
          request={dialog.request}
          onCancel={closeDialog}
          onSubmit={submit}
        />
      )}
      {menu && (
        <ChartContextMenu
          chart={menu.chart}
          x={menu.x}
          y={menu.y}
          readOnly={readOnly}
          onClose={closeMenu}
          onEdit={() => void openEdit(controllerRef.current?.getChart(menu.chart.id) ?? menu.chart)}
          onChangeType={(v) => void controllerRef.current?.changeType(menu.chart.id, v.type, v.grouping)}
          onCopyImage={() => void controllerRef.current?.copyAsImage(menu.chart.id)}
          onDelete={() => void controllerRef.current?.deleteChart(menu.chart.id)}
        />
      )}
    </>
  );
}
