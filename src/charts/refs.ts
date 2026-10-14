import type { SheetMeta } from "@/engine/contract";
import { MAX_COLS, MAX_ROWS, colIndex, colName, type CellRange, type SheetId } from "@/engine/types";

/**
 * Chart series references: `Hoja1!$B$2:$B$13`, `'Mi hoja'!A1:A5`, `B2:B13`
 * (unqualified = the chart's sheet), whole columns/rows (`$B:$B`, `2:2`) and
 * unions in parentheses (`(Hoja1!A1:A3,Hoja1!A5:A7)`).
 */
export interface SheetRef {
  /** null = unqualified (the chart's own sheet). */
  readonly sheetName: string | null;
  readonly range: CellRange;
  /** True for `$B:$B`-style refs (rows are clamped to the used range). */
  readonly wholeCols: boolean;
  /** True for `2:2`-style refs (cols are clamped to the used range). */
  readonly wholeRows: boolean;
}

export interface ResolvedRef {
  readonly sheet: SheetId;
  readonly range: CellRange;
  readonly wholeCols: boolean;
  readonly wholeRows: boolean;
}

/** Splits on commas that are outside quoted sheet names. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    else if (ch === "," && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
const COL_RE = /^\$?([A-Za-z]{1,3})$/;
const ROW_RE = /^\$?(\d{1,7})$/;

type Endpoint = { row: number | null; col: number | null };

function parseEndpoint(text: string): Endpoint | null {
  let m = CELL_RE.exec(text);
  if (m) {
    const col = colIndex(m[1]);
    const row = Number(m[2]) - 1;
    return col < 0 || row < 0 || row >= MAX_ROWS ? null : { row, col };
  }
  m = COL_RE.exec(text);
  if (m) {
    const col = colIndex(m[1]);
    return col < 0 ? null : { row: null, col };
  }
  m = ROW_RE.exec(text);
  if (m) {
    const row = Number(m[1]) - 1;
    return row < 0 || row >= MAX_ROWS ? null : { row, col: null };
  }
  return null;
}

/** Parses one area (`'Mi hoja'!$A$1:$B$2`). */
function parseArea(text: string): SheetRef | null {
  const t = text.trim();
  let sheetName: string | null = null;
  let rest = t;
  if (t.startsWith("'")) {
    let i = 1;
    let name = "";
    for (; i < t.length; i += 1) {
      if (t[i] === "'") {
        if (t[i + 1] === "'") {
          name += "'";
          i += 1;
          continue;
        }
        break;
      }
      name += t[i];
    }
    if (t[i] !== "'" || t[i + 1] !== "!") return null;
    sheetName = name;
    rest = t.slice(i + 2);
  } else {
    const bang = t.lastIndexOf("!");
    if (bang >= 0) {
      sheetName = t.slice(0, bang);
      rest = t.slice(bang + 1);
      if (!sheetName) return null;
    }
  }
  const pieces = rest.split(":");
  if (pieces.length < 1 || pieces.length > 2) return null;
  const a = parseEndpoint(pieces[0]);
  const b = pieces.length === 2 ? parseEndpoint(pieces[1]) : a;
  if (!a || !b) return null;
  const wholeCols = a.row === null && b.row === null;
  const wholeRows = a.col === null && b.col === null;
  if ((a.row === null) !== (b.row === null) || (a.col === null) !== (b.col === null)) return null;
  // A lone column/row (`B` or `2`) without a colon is not a reference.
  if (pieces.length === 1 && (wholeCols || wholeRows)) return null;
  const r0 = a.row ?? 0;
  const r1 = b.row ?? MAX_ROWS - 1;
  const c0 = a.col ?? 0;
  const c1 = b.col ?? MAX_COLS - 1;
  return {
    sheetName,
    range: { r0: Math.min(r0, r1), c0: Math.min(c0, c1), r1: Math.max(r0, r1), c1: Math.max(c0, c1) },
    wholeCols,
    wholeRows,
  };
}

/** Parses a series reference into its areas; null if it is not a valid reference. */
export function parseRef(formula: string): SheetRef[] | null {
  let text = formula.trim();
  if (text.startsWith("=")) text = text.slice(1).trim();
  if (text.startsWith("(") && text.endsWith(")")) text = text.slice(1, -1);
  if (!text) return null;
  const areas: SheetRef[] = [];
  for (const part of splitTopLevel(text)) {
    const area = parseArea(part);
    if (!area) return null;
    areas.push(area);
  }
  return areas;
}

/** True when a sheet name must be quoted in a formula (mirrors `charts::quote_sheet` in Rust). */
export function sheetNeedsQuotes(name: string): boolean {
  if (!name) return true;
  const first = name[0];
  if (/[0-9.]/.test(first)) return true;
  if (!/^[\p{L}\p{N}_.]+$/u.test(name)) return true;
  const upper = name.toUpperCase();
  const a1 = /^([A-Z]{1,3})(\d+)$/.exec(upper);
  if (a1) return true;
  if (/^R\d*(C\d*)?$/.test(upper) || /^C\d*$/.test(upper)) return true;
  return false;
}

export function quoteSheetName(name: string): string {
  return sheetNeedsQuotes(name) ? `'${name.replace(/'/g, "''")}'` : name;
}

/** `'Mi hoja'!$B$2:$B$13` (absolute, like Excel writes chart refs). */
export function formatRef(sheetName: string, range: CellRange): string {
  const a = `$${colName(range.c0)}$${range.r0 + 1}`;
  const single = range.r0 === range.r1 && range.c0 === range.c1;
  const b = single ? "" : `:$${colName(range.c1)}$${range.r1 + 1}`;
  return `${quoteSheetName(sheetName)}!${a}${b}`;
}

/** Maps sheet names to ids (case-insensitive, like Excel). */
export function resolveRef(
  formula: string,
  sheets: ReadonlyArray<SheetMeta>,
  defaultSheet: SheetId,
): ResolvedRef[] | null {
  const areas = parseRef(formula);
  if (!areas) return null;
  const out: ResolvedRef[] = [];
  for (const area of areas) {
    let sheet = defaultSheet;
    if (area.sheetName !== null) {
      const lower = area.sheetName.toLowerCase();
      const meta = sheets.find((s) => s.name.toLowerCase() === lower);
      if (!meta) return null;
      sheet = meta.id;
    }
    out.push({ sheet, range: area.range, wholeCols: area.wholeCols, wholeRows: area.wholeRows });
  }
  return out;
}
