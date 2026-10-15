import type { ApplyResult, EngineOp, SheetInfo, SortKey } from "@/engine/contract";
import { colName, rangeContains, type CellRange } from "@/engine/types";
import type { AppController, MenuAnchor } from "@/hooks/app-controller";
import {
  activeRangeOf,
  axisIndices,
  dataRangeFor,
  deleteColsOps,
  deleteRowsOps,
  guessHasHeader,
  insertColsOps,
  insertRowsOps,
  rangeSelection,
  shiftCellsOps,
  smartStructureOps,
  type CellShift,
} from "@/hooks/selection-ops";

/** Structure (insert/delete), sort, filter, row/column size and visibility actions. */

// ----- insert / delete ---------------------------------------------------------

export function insertRows(c: AppController): Promise<ApplyResult | null> {
  const s = c.selection;
  return s ? c.apply(insertRowsOps(s.sheet, s.ranges)) : Promise.resolve(null);
}

export function insertCols(c: AppController): Promise<ApplyResult | null> {
  const s = c.selection;
  return s ? c.apply(insertColsOps(s.sheet, s.ranges)) : Promise.resolve(null);
}

export function deleteRows(c: AppController): Promise<ApplyResult | null> {
  const s = c.selection;
  return s ? c.apply(deleteRowsOps(s.sheet, s.ranges)) : Promise.resolve(null);
}

export function deleteCols(c: AppController): Promise<ApplyResult | null> {
  const s = c.selection;
  return s ? c.apply(deleteColsOps(s.sheet, s.ranges)) : Promise.resolve(null);
}

/** Ctrl++ / Ctrl+-: whole rows/cols directly, otherwise Excel's shift dialog. */
export async function insertOrDeleteSmart(c: AppController, insert: boolean): Promise<void> {
  const s = c.selection;
  if (!s) return;
  const ops = smartStructureOps(s, insert);
  if (ops === null) {
    c.openDialog({ kind: insert ? "insertCells" : "deleteCells" });
    return;
  }
  if (ops.length === 0) {
    c.notify(insert ? "No se pueden insertar celdas con toda la hoja seleccionada." : "No se puede eliminar toda la hoja.", "info");
    return;
  }
  await c.apply(ops);
}

export function shiftCells(c: AppController, insert: boolean, shift: CellShift): Promise<ApplyResult | null> {
  const s = c.selection;
  return s ? c.apply(shiftCellsOps(s, insert, shift)) : Promise.resolve(null);
}

// ----- sort ------------------------------------------------------------------------

async function sheetInfo(c: AppController): Promise<SheetInfo | null> {
  const session = c.session;
  if (!session) return null;
  try {
    return await c.engine.getSheetInfo(session.doc, session.activeSheet);
  } catch {
    return null;
  }
}

export interface SortSetup {
  readonly range: CellRange;
  readonly hasHeader: boolean;
  /** Column choices for the levels: absolute index + label ("Columna B" or the header text). */
  readonly columns: ReadonlyArray<{ readonly col: number; readonly label: string }>;
  readonly headerLabels: ReadonlyArray<string>;
  readonly activeCol: number;
}

/** Range, header guess and column labels for sorting the current selection. */
export async function prepareSort(c: AppController): Promise<SortSetup | null> {
  const session = c.session;
  const s = c.selection;
  if (!session || !s) return null;
  const info = await sheetInfo(c);
  const range = dataRangeFor(activeRangeOf(s), info?.usedRange ?? null);
  if (!range) {
    c.notify("Selecciona una celda de un rango con datos para ordenar.", "info");
    return null;
  }
  let hasHeader = false;
  let headerLabels: string[] = [];
  try {
    const top = await c.engine.getRangeValues(session.doc, s.sheet, { ...range, r1: Math.min(range.r1, range.r0 + 1) });
    hasHeader = guessHasHeader(top);
    headerLabels = [...(top.display[0] ?? [])];
  } catch {
    hasHeader = false;
  }
  const columns = [];
  for (let col = range.c0; col <= range.c1 && columns.length < 500; col += 1) {
    columns.push({ col, label: `Columna ${colName(col)}` });
  }
  const activeCol = Math.min(Math.max(s.active.col, range.c0), range.c1);
  return { range, hasHeader, columns, headerLabels, activeCol };
}

export async function sortRange(c: AppController, range: CellRange, keys: ReadonlyArray<SortKey>, hasHeader: boolean): Promise<ApplyResult | null> {
  const s = c.selection;
  if (!s || keys.length === 0) return null;
  const result = await c.apply([{ type: "sort", sheet: s.sheet, range, keys, hasHeader }]);
  if (result && !result.selection) {
    const active = rangeContains(range, s.active.row, s.active.col) ? s.active : { row: range.r0, col: range.c0 };
    c.session?.selection.set(rangeSelection(s.sheet, range, active));
  }
  return result;
}

/** "Ordenar de A a Z" / "de Z a A" on the active column. */
export async function sortQuick(c: AppController, ascending: boolean): Promise<void> {
  const setup = await prepareSort(c);
  if (!setup) return;
  await sortRange(c, setup.range, [{ col: setup.activeCol, ascending }], setup.hasHeader);
}

// ----- autofilter --------------------------------------------------------------------

export async function toggleAutoFilter(c: AppController): Promise<void> {
  const s = c.selection;
  if (!s) return;
  const info = await sheetInfo(c);
  if (info?.autoFilter) {
    await c.apply([{ type: "setAutoFilter", sheet: s.sheet, range: null }]);
    return;
  }
  const range = dataRangeFor(activeRangeOf(s), info?.usedRange ?? null);
  if (!range) {
    c.notify("Selecciona una celda de un rango con datos para filtrar.", "info");
    return;
  }
  await c.apply([{ type: "setAutoFilter", sheet: s.sheet, range }]);
}

export async function clearAllFilters(c: AppController): Promise<void> {
  const s = c.selection;
  const info = await sheetInfo(c);
  if (!s || !info?.autoFilter) return;
  const ops: EngineOp[] = info.autoFilter.filteredCols.map((col) => ({ type: "filterColumn", sheet: s.sheet, col, criteria: null }));
  if (ops.length > 0) await c.apply(ops);
}

export function filterColumn(c: AppController, col: number, values: ReadonlyArray<string> | null): Promise<ApplyResult | null> {
  const s = c.selection;
  if (!s) return Promise.resolve(null);
  return c.apply([{ type: "filterColumn", sheet: s.sheet, col, criteria: values ? { values } : null }]);
}

/** `GridProps.onFilterButton`. */
export function openFilterMenu(c: AppController, col: number, anchor: MenuAnchor): void {
  const session = c.session;
  if (!session) return;
  c.filterMenu.set({ sessionId: session.id, sheet: session.activeSheet, col, anchor });
}

/** Sorts the autofilter range by one column (buttons in the filter menu). */
export async function sortFilterColumn(c: AppController, col: number, ascending: boolean): Promise<void> {
  const info = await sheetInfo(c);
  const range = info?.autoFilter?.range;
  if (!range) return;
  await sortRange(c, range, [{ col, ascending }], true);
}

// ----- row heights / column widths ----------------------------------------------------

/** Excel shows row heights in points and column widths in characters (Calibri 11). */
export const pxToPoints = (px: number) => Math.round(px * 0.75 * 100) / 100;
export const pointsToPx = (points: number) => Math.round(points / 0.75);
export const pxToChars = (px: number) => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
export const charsToPx = (chars: number) => Math.round(chars * 7 + 5);

function axisLimit(info: SheetInfo | null, axis: "row" | "col"): number {
  const used = info?.usedRange;
  const end = used ? (axis === "row" ? used.r1 : used.c1) + 1 : 0;
  return Math.max(end, axis === "row" ? 1000 : 100);
}

/** Size (CSS px) of the active row/column, for the dialogs. */
export async function currentSize(c: AppController, axis: "row" | "col"): Promise<number> {
  const s = c.selection;
  const info = await sheetInfo(c);
  if (!s || !info) return axis === "row" ? 20 : 64;
  const index = axis === "row" ? s.active.row : s.active.col;
  const overrides = axis === "row" ? info.rowOverrides : info.colOverrides;
  const size = overrides.find((o) => o.index === index)?.size;
  return size ?? (axis === "row" ? info.defaultRowHeight : info.defaultColWidth);
}

export async function setSize(c: AppController, axis: "row" | "col", size: number | null): Promise<ApplyResult | null> {
  const s = c.selection;
  if (!s) return null;
  const info = await sheetInfo(c);
  const indices = axisIndices(s.ranges, axis, axisLimit(info, axis));
  return c.apply([
    axis === "row"
      ? { type: "setRowHeights", sheet: s.sheet, rows: indices, size }
      : { type: "setColWidths", sheet: s.sheet, cols: indices, size },
  ]);
}

export async function setHidden(c: AppController, axis: "row" | "col", hidden: boolean): Promise<ApplyResult | null> {
  const s = c.selection;
  if (!s) return null;
  const info = await sheetInfo(c);
  const indices = axisIndices(s.ranges, axis, axisLimit(info, axis));
  return c.apply([{ type: "setHidden", sheet: s.sheet, axis, indices, hidden }]);
}

/** "Autoajustar ancho de columna": the grid measures, the engine stores. */
export async function autofitColumns(c: AppController): Promise<void> {
  const s = c.selection;
  const grid = c.session?.grid;
  if (!s || !grid) return;
  const info = await sheetInfo(c);
  const cols = axisIndices(s.ranges, "col", axisLimit(info, "col"));
  const widths = await grid.measureAutofit(cols);
  const bySize = new Map<number, number[]>();
  cols.forEach((col, i) => {
    const width = Math.round(widths[i] ?? 0);
    if (width > 0) bySize.set(width, [...(bySize.get(width) ?? []), col]);
  });
  const ops: EngineOp[] = [...bySize].map(([size, list]) => ({ type: "setColWidths", sheet: s.sheet, cols: list, size }));
  if (ops.length > 0) await c.apply(ops);
}
