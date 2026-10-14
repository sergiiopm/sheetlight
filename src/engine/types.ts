/**
 * Cell addressing primitives shared by every module (grid, editor, engine,
 * model, charts). All indices are 0-based; the engine adapter converts to the
 * 1-based indices IronCalc uses.
 */

/** Excel sheet limits. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** Stable id of an open document inside the engine (never reused while the app runs). */
export type DocumentId = number;
/** Stable id of a sheet inside a document (survives rename and reorder). */
export type SheetId = number;
/** Render style id. 0 is always the default style. Ids are per document. */
export type StyleId = number;

export interface CellAddress {
  readonly row: number;
  readonly col: number;
}

/** Inclusive, normalized range (r0 <= r1, c0 <= c1). */
export interface CellRange {
  readonly r0: number;
  readonly c0: number;
  readonly r1: number;
  readonly c1: number;
}

export interface SheetCell extends CellAddress {
  readonly sheet: SheetId;
}

export interface SheetRange extends CellRange {
  readonly sheet: SheetId;
}

export type Direction = "up" | "down" | "left" | "right";

export function cellRange(cell: CellAddress): CellRange {
  return { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
}

export function normRange(a: CellAddress, b: CellAddress): CellRange {
  return {
    r0: Math.min(a.row, b.row),
    c0: Math.min(a.col, b.col),
    r1: Math.max(a.row, b.row),
    c1: Math.max(a.col, b.col),
  };
}

export function rangeContains(r: CellRange, row: number, col: number): boolean {
  return row >= r.r0 && row <= r.r1 && col >= r.c0 && col <= r.c1;
}

export function rangesIntersect(a: CellRange, b: CellRange): boolean {
  return a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;
}

export function rangeUnion(a: CellRange, b: CellRange): CellRange {
  return {
    r0: Math.min(a.r0, b.r0),
    c0: Math.min(a.c0, b.c0),
    r1: Math.max(a.r1, b.r1),
    c1: Math.max(a.c1, b.c1),
  };
}

export function rangeCellCount(r: CellRange): number {
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1);
}

const colNameCache: string[] = [];

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 16383 -> "XFD". */
export function colName(col: number): string {
  const cached = colNameCache[col];
  if (cached !== undefined) return cached;
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  colNameCache[col] = s;
  return s;
}

/** "A" -> 0, "XFD" -> 16383. Returns -1 for invalid input. */
export function colIndex(name: string): number {
  let n = 0;
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i) & ~32; // upper-case ASCII
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  return n > 0 && n <= MAX_COLS ? n - 1 : -1;
}

export function cellName(a: CellAddress): string {
  return `${colName(a.col)}${a.row + 1}`;
}

export function rangeName(r: CellRange): string {
  if (r.r0 === r.r1 && r.c0 === r.c1) return cellName({ row: r.r0, col: r.c0 });
  return `${cellName({ row: r.r0, col: r.c0 })}:${cellName({ row: r.r1, col: r.c1 })}`;
}

/** Parses "B7" (optionally with `$`) into a 0-based address. */
export function parseCellName(text: string): CellAddress | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(text.trim());
  if (!match) return null;
  const col = colIndex(match[1]);
  const row = Number(match[2]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col };
}

/** Parses "B7" or "A1:C10" into a normalized range. */
export function parseRangeName(text: string): CellRange | null {
  const parts = text.split(":");
  if (parts.length === 1) {
    const cell = parseCellName(parts[0]);
    return cell ? cellRange(cell) : null;
  }
  if (parts.length !== 2) return null;
  const a = parseCellName(parts[0]);
  const b = parseCellName(parts[1]);
  return a && b ? normRange(a, b) : null;
}
