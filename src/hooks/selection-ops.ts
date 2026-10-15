import type {
  BorderPreset,
  BorderStyle,
  ClearWhat,
  EngineOp,
  RangeValues,
  SelectionHint,
  SheetMeta,
  StylePatch,
} from "@/engine/contract";
import {
  MAX_COLS,
  MAX_ROWS,
  parseRangeName,
  rangeContains,
  type CellAddress,
  type CellRange,
  type SheetId,
} from "@/engine/types";
import type { SelectionKind, SelectionState } from "@/model/selection";

/**
 * Pure helpers that turn the current selection into `EngineOp`s (and back).
 * No engine or React here, so every rule is unit-tested.
 */

export function activeRangeOf(selection: SelectionState): CellRange {
  return selection.ranges[selection.activeRange] ?? selection.ranges[selection.ranges.length - 1];
}

export function isSingleCell(range: CellRange): boolean {
  return range.r0 === range.r1 && range.c0 === range.c1;
}

export interface Span {
  readonly index: number;
  readonly count: number;
}

/** Merged row (or column) spans covered by `ranges`, sorted by descending index. */
export function axisSpans(ranges: ReadonlyArray<CellRange>, axis: "row" | "col"): Span[] {
  const intervals = ranges
    .map((r) => (axis === "row" ? [r.r0, r.r1] : [r.c0, r.c1]))
    .sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged.reverse().map(([start, end]) => ({ index: start, count: end - start + 1 }));
}

/**
 * Indices of every row/col covered by `ranges`, ascending and unique.
 * `limit` bounds whole-sheet selections (setting 1M row heights is never what
 * the user means; callers pass the used range end).
 */
export function axisIndices(ranges: ReadonlyArray<CellRange>, axis: "row" | "col", limit: number): number[] {
  const set = new Set<number>();
  for (const span of axisSpans(ranges, axis)) {
    const end = Math.min(span.index + span.count - 1, span.index + limit - 1, (axis === "row" ? MAX_ROWS : MAX_COLS) - 1);
    for (let i = span.index; i <= end && set.size < limit; i += 1) set.add(i);
  }
  return [...set].sort((a, b) => a - b);
}

export function insertRowsOps(sheet: SheetId, ranges: ReadonlyArray<CellRange>): EngineOp[] {
  return axisSpans(ranges, "row").map(({ index, count }) => ({ type: "insertRows", sheet, index, count }));
}

export function deleteRowsOps(sheet: SheetId, ranges: ReadonlyArray<CellRange>): EngineOp[] {
  return axisSpans(ranges, "row").map(({ index, count }) => ({ type: "deleteRows", sheet, index, count }));
}

export function insertColsOps(sheet: SheetId, ranges: ReadonlyArray<CellRange>): EngineOp[] {
  return axisSpans(ranges, "col").map(({ index, count }) => ({ type: "insertCols", sheet, index, count }));
}

export function deleteColsOps(sheet: SheetId, ranges: ReadonlyArray<CellRange>): EngineOp[] {
  return axisSpans(ranges, "col").map(({ index, count }) => ({ type: "deleteCols", sheet, index, count }));
}

export type CellShift = "right" | "down" | "left" | "up" | "entireRow" | "entireCol";

/** Ops for Excel's "Insertar/Eliminar celdas" dialog choice. */
export function shiftCellsOps(selection: SelectionState, insert: boolean, shift: CellShift): EngineOp[] {
  const { sheet, ranges } = selection;
  if (shift === "entireRow") return insert ? insertRowsOps(sheet, ranges) : deleteRowsOps(sheet, ranges);
  if (shift === "entireCol") return insert ? insertColsOps(sheet, ranges) : deleteColsOps(sheet, ranges);
  // Bottom-right ranges first so earlier shifts don't move later targets.
  const ordered = [...ranges].sort((a, b) => b.r0 - a.r0 || b.c0 - a.c0);
  return ordered.map((range) =>
    insert
      ? { type: "insertCells", sheet, range, shift: shift === "right" ? "right" : "down" }
      : { type: "deleteCells", sheet, range, shift: shift === "left" ? "left" : "up" },
  );
}

/**
 * Ctrl++ / Ctrl+-: whole rows or columns act directly; plain cells need the
 * dialog (returns null).
 */
export function smartStructureOps(selection: SelectionState, insert: boolean): EngineOp[] | null {
  return structureOpsForKind(selection.kind, selection, insert);
}

function structureOpsForKind(kind: SelectionKind, selection: SelectionState, insert: boolean): EngineOp[] | null {
  switch (kind) {
    case "rows":
      return shiftCellsOps(selection, insert, "entireRow");
    case "cols":
      return shiftCellsOps(selection, insert, "entireCol");
    case "all":
      return [];
    case "cells":
      return null;
  }
}

export function styleOp(selection: SelectionState, patch: StylePatch): EngineOp {
  return { type: "setStyle", sheet: selection.sheet, ranges: selection.ranges, patch };
}

export function bordersOp(selection: SelectionState, preset: BorderPreset, style: BorderStyle = "thin", color = "#000000"): EngineOp {
  return { type: "setBorders", sheet: selection.sheet, ranges: selection.ranges, preset, style, color };
}

export function clearOp(selection: SelectionState, what: ClearWhat): EngineOp {
  return { type: "clear", sheet: selection.sheet, ranges: selection.ranges, what };
}

export function mergeOps(selection: SelectionState, mode: "merge" | "mergeCenter" | "mergeAcross"): EngineOp[] {
  return selection.ranges
    .filter((range) => !isSingleCell(range))
    .map((range) => ({ type: "merge", sheet: selection.sheet, range, mode }));
}

export function unmergeOp(selection: SelectionState): EngineOp {
  return { type: "unmerge", sheet: selection.sheet, ranges: selection.ranges };
}

/** Excel's font size ladder for "Aumentar/Disminuir tamaño de fuente". */
export const FONT_SIZES: ReadonlyArray<number> = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export function nextFontSize(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    const next = FONT_SIZES.find((size) => size > current);
    return next ?? Math.min(409, Math.ceil((current + 1) / 10) * 10);
  }
  const previous = [...FONT_SIZES].reverse().find((size) => size < current);
  return previous ?? Math.max(1, current - 1);
}

/**
 * Frozen rows/cols for "Inmovilizar paneles": everything above and left of
 * the active cell. At A1 Excel freezes the middle of the view instead; we
 * freeze nothing and the caller tells the user.
 */
export function freezeAt(active: CellAddress): { rows: number; cols: number } {
  return { rows: Math.max(0, active.row), cols: Math.max(0, active.col) };
}

export function hintToSelection(hint: SelectionHint): SelectionState {
  const ranges = hint.ranges.length > 0 ? hint.ranges : [{ r0: hint.active.row, c0: hint.active.col, r1: hint.active.row, c1: hint.active.col }];
  const index = ranges.findIndex((r) => rangeContains(r, hint.active.row, hint.active.col));
  const activeRange = index === -1 ? ranges.length - 1 : index;
  const range = ranges[activeRange];
  const active = index === -1 ? { row: range.r0, col: range.c0 } : hint.active;
  return { sheet: hint.sheet, ranges, activeRange, active, anchor: active, kind: "cells" };
}

export function rangeSelection(sheet: SheetId, range: CellRange, active: CellAddress = { row: range.r0, col: range.c0 }): SelectionState {
  return { sheet, ranges: [range], activeRange: 0, active, anchor: active, kind: kindOfRange(range) };
}

export function kindOfRange(range: CellRange): SelectionKind {
  const fullRows = range.c0 === 0 && range.c1 >= MAX_COLS - 1;
  const fullCols = range.r0 === 0 && range.r1 >= MAX_ROWS - 1;
  if (fullRows && fullCols) return "all";
  if (fullRows) return "rows";
  if (fullCols) return "cols";
  return "cells";
}

/**
 * Right click outside the current selection moves the selection there first
 * (Excel). Returns null when the click is inside the selection.
 */
export function selectionForContextClick(
  selection: SelectionState,
  region: "cell" | "rowHeader" | "colHeader" | "corner",
  cell: CellAddress,
): SelectionState | null {
  const inside = selection.ranges.some((r) => {
    if (region === "rowHeader") return r.r0 <= cell.row && cell.row <= r.r1 && r.c0 === 0 && r.c1 >= MAX_COLS - 1;
    if (region === "colHeader") return r.c0 <= cell.col && cell.col <= r.c1 && r.r0 === 0 && r.r1 >= MAX_ROWS - 1;
    if (region === "corner") return kindOfRange(r) === "all";
    return rangeContains(r, cell.row, cell.col);
  });
  if (inside) return null;
  const range: CellRange =
    region === "rowHeader"
      ? { r0: cell.row, c0: 0, r1: cell.row, c1: MAX_COLS - 1 }
      : region === "colHeader"
        ? { r0: 0, c0: cell.col, r1: MAX_ROWS - 1, c1: cell.col }
        : region === "corner"
          ? { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }
          : { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
  const active = region === "rowHeader" ? { row: cell.row, col: 0 } : region === "colHeader" ? { row: 0, col: cell.col } : region === "corner" ? { row: 0, col: 0 } : cell;
  return rangeSelection(selection.sheet, range, active);
}

/**
 * Data range for sort/filter: the selection, or the used range when only one
 * cell is selected (Excel expands to the current region; the used range is a
 * close, cheap approximation). Whole columns/rows are clipped to the used range.
 */
export function dataRangeFor(range: CellRange, usedRange: CellRange | null): CellRange | null {
  if (!usedRange) return isSingleCell(range) ? null : range;
  if (isSingleCell(range)) return usedRange;
  const kind = kindOfRange(range);
  if (kind === "cells") return range;
  const clipped = {
    r0: Math.max(range.r0, usedRange.r0),
    c0: Math.max(range.c0, usedRange.c0),
    r1: Math.min(range.r1, usedRange.r1),
    c1: Math.min(range.c1, usedRange.c1),
  };
  return clipped.r0 <= clipped.r1 && clipped.c0 <= clipped.c1 ? clipped : null;
}

/**
 * Excel's header guess for sort: the first row is a header when it is all
 * text and the second row has at least one non-text value (or when the first
 * row is text-only and differs in kind from the rest).
 */
export function guessHasHeader(values: RangeValues): boolean {
  const [first, second] = values.values;
  if (!first || !second) return false;
  const firstAllText = first.every((v) => v.type === "text");
  if (!firstAllText) return false;
  return second.some((v) => v.type !== "text" && v.type !== "empty") || first.some((v, i) => v.type === "text" && second[i]?.type === "empty");
}

export interface ParsedReference {
  readonly sheet: SheetId | null;
  readonly range: CellRange;
}

/** Parses "B7", "A1:C10", "Hoja2!A1", "'Mi hoja'!$B$2:$C$4". */
export function parseReference(text: string, sheets: ReadonlyArray<SheetMeta>): ParsedReference | null {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  let sheet: SheetId | null = null;
  let address = trimmed;
  if (bang !== -1) {
    let name = trimmed.slice(0, bang).trim();
    if (name.startsWith("'") && name.endsWith("'") && name.length >= 2) name = name.slice(1, -1).replaceAll("''", "'");
    const meta = sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!meta) return null;
    sheet = meta.id;
    address = trimmed.slice(bang + 1);
  }
  const whole = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})$/.exec(address) ?? /^\$?([0-9]{1,7}):\$?([0-9]{1,7})$/.exec(address);
  if (whole) {
    const a = parseRangeName(/^\d/.test(whole[1]) ? `A${whole[1]}:A${whole[2]}` : `${whole[1]}1:${whole[2]}1`);
    if (!a) return null;
    return /^\d/.test(whole[1].replace("$", ""))
      ? { sheet, range: { r0: a.r0, c0: 0, r1: a.r1, c1: MAX_COLS - 1 } }
      : { sheet, range: { r0: 0, c0: a.c0, r1: MAX_ROWS - 1, c1: a.c1 } };
  }
  const range = parseRangeName(address.replaceAll("$", ""));
  return range ? { sheet, range } : null;
}

/** Name for a new or duplicated sheet that does not collide (case-insensitive). */
export function freeSheetName(sheets: ReadonlyArray<SheetMeta>, base = "Hoja"): string {
  const taken = new Set(sheets.map((s) => s.name.toLowerCase()));
  for (let n = sheets.length + 1; ; n += 1) {
    const name = `${base}${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** Validates a sheet name like Excel; returns a Spanish error or null. */
export function sheetNameError(name: string, sheets: ReadonlyArray<SheetMeta>, self: SheetId | null): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "El nombre de la hoja no puede estar vacío.";
  if (trimmed.length > 31) return "El nombre de la hoja no puede tener más de 31 caracteres.";
  if (/[\\/?*[\]:]/.test(trimmed)) return "El nombre de la hoja no puede contener \\ / ? * [ ] :";
  if (trimmed.startsWith("'") || trimmed.endsWith("'")) return "El nombre de la hoja no puede empezar ni terminar con un apóstrofo.";
  if (sheets.some((s) => s.id !== self && s.name.toLowerCase() === trimmed.toLowerCase())) return "Ya existe una hoja con ese nombre.";
  return null;
}
