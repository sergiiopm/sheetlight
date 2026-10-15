import type { CellValue, ChartSeries, ChartType, RangeValues, WorkbookEngine } from "@/engine/contract";
import type { CellAddress, CellRange, DocumentId, SheetId } from "@/engine/types";
import { formatRef } from "@/charts/refs";

/**
 * Excel-like inference of series from a selected block of cells:
 * - a top-left cell that is empty means "row 1 and column 1 are labels";
 * - a first row of text over numbers holds the series names;
 * - a first column of text (or dates) holds the categories;
 * - series run along columns when there are at least as many rows as
 *   columns, otherwise along rows (overridable).
 */
export type SeriesOrientation = "cols" | "rows";

export interface InferredChart {
  readonly series: ChartSeries[];
  readonly orientation: SeriesOrientation;
  readonly headerRow: boolean;
  readonly headerCol: boolean;
}

/** Display strings that look like plain numbers ("1.234,5", "12%", "-3 €"); dates do not. */
const NUMERIC_DISPLAY = /^[-+(]?[\d.,\s ]*\d[\d.,\s ]*\)?\s*[%€$£]?$/;

function isLabel(value: CellValue, display: string): boolean {
  if (value.type === "text") return value.value.trim() !== "" && !NUMERIC_DISPLAY.test(value.value.trim());
  // Dates are numbers with a date format: treat them as labels (Excel uses them as categories).
  if (value.type === "number") return display.trim() !== "" && !NUMERIC_DISPLAY.test(display.trim());
  return false;
}

function isEmpty(value: CellValue): boolean {
  return value.type === "empty" || (value.type === "text" && value.value.trim() === "");
}

export function inferSeries(
  data: RangeValues,
  sheetName: string,
  options: { orientation?: SeriesOrientation; chartType?: ChartType } = {},
): InferredChart {
  const { range, values, display } = data;
  const rows = values.length;
  const cols = rows > 0 ? values[0].length : 0;
  const cell = (r: number, c: number) => values[r]?.[c] ?? ({ type: "empty" } as const);
  const disp = (r: number, c: number) => display[r]?.[c] ?? "";
  const labelOrEmpty = (r: number, c: number) => isEmpty(cell(r, c)) || isLabel(cell(r, c), disp(r, c));

  let headerRow = false;
  let headerCol = false;
  if (rows > 1 && cols > 1 && isEmpty(cell(0, 0))) {
    headerRow = true;
    headerCol = true;
  } else {
    if (cols > 1) {
      // First column is labels if every cell below the header is label-like and at least one is a label.
      let any = false;
      let all = true;
      for (let r = 1; r < rows; r += 1) {
        if (!labelOrEmpty(r, 0)) all = false;
        if (isLabel(cell(r, 0), disp(r, 0))) any = true;
      }
      headerCol = all && any;
    }
    if (rows > 1) {
      let any = false;
      let all = true;
      for (let c = headerCol ? 1 : 0; c < cols; c += 1) {
        if (!labelOrEmpty(0, c)) all = false;
        if (isLabel(cell(0, c), disp(0, c))) any = true;
      }
      headerRow = all && any;
    }
  }
  // A single row/column of labels with nothing else: keep it as data.
  if (headerCol && cols === 1) headerCol = false;
  if (headerRow && rows === 1) headerRow = false;

  const dataRows = rows - (headerRow ? 1 : 0);
  const dataCols = cols - (headerCol ? 1 : 0);
  const orientation: SeriesOrientation = options.orientation ?? (dataRows >= dataCols ? "cols" : "rows");
  const r0 = range.r0 + (headerRow ? 1 : 0);
  const c0 = range.c0 + (headerCol ? 1 : 0);

  const series: ChartSeries[] = [];
  if (dataRows <= 0 || dataCols <= 0) return { series, orientation, headerRow, headerCol };

  if (orientation === "cols") {
    let categoriesRef = headerCol ? formatRef(sheetName, { r0, c0: range.c0, r1: range.r1, c1: range.c0 }) : null;
    let firstCol = c0;
    // Scatter without a label column: the first data column holds the X values.
    if (options.chartType === "scatter" && !headerCol && dataCols > 1) {
      categoriesRef = formatRef(sheetName, { r0, c0, r1: range.r1, c1: c0 });
      firstCol = c0 + 1;
    }
    for (let c = firstCol; c <= range.c1; c += 1) {
      series.push({
        nameRef: headerRow ? formatRef(sheetName, { r0: range.r0, c0: c, r1: range.r0, c1: c }) : null,
        name: headerRow ? disp(0, c - range.c0) || null : null,
        categoriesRef,
        valuesRef: formatRef(sheetName, { r0, c0: c, r1: range.r1, c1: c }),
        color: null,
      });
    }
  } else {
    let categoriesRef = headerRow ? formatRef(sheetName, { r0: range.r0, c0, r1: range.r0, c1: range.c1 }) : null;
    let firstRow = r0;
    if (options.chartType === "scatter" && !headerRow && dataRows > 1) {
      categoriesRef = formatRef(sheetName, { r0, c0, r1: r0, c1: range.c1 });
      firstRow = r0 + 1;
    }
    for (let r = firstRow; r <= range.r1; r += 1) {
      series.push({
        nameRef: headerCol ? formatRef(sheetName, { r0: r, c0: range.c0, r1: r, c1: range.c0 }) : null,
        name: headerCol ? disp(r - range.r0, 0) || null : null,
        categoriesRef,
        valuesRef: formatRef(sheetName, { r0: r, c0, r1: r, c1: range.c1 }),
        color: null,
      });
    }
  }
  return { series, orientation, headerRow, headerCol };
}

/**
 * Excel's "current region": grows a rectangle from `cell` while any cell on
 * its border (including diagonals) is non-empty. Looks at a bounded window
 * around the cell to stay fast on huge sheets.
 */
export async function currentRegion(
  engine: WorkbookEngine,
  doc: DocumentId,
  sheet: SheetId,
  cell: CellAddress,
  window: { rows: number; cols: number } = { rows: 500, cols: 60 },
): Promise<CellRange> {
  const win: CellRange = {
    r0: Math.max(0, cell.row - window.rows),
    c0: Math.max(0, cell.col - window.cols),
    r1: cell.row + window.rows,
    c1: cell.col + window.cols,
  };
  const data = await engine.getRangeValues(doc, sheet, win);
  const filled = (r: number, c: number) => {
    const v = data.values[r - win.r0]?.[c - win.c0];
    return v !== undefined && !isEmpty(v);
  };
  let r0 = cell.row;
  let r1 = cell.row;
  let c0 = cell.col;
  let c1 = cell.col;
  for (let changed = true; changed; ) {
    changed = false;
    const rowHas = (r: number) => {
      for (let c = Math.max(win.c0, c0 - 1); c <= Math.min(win.c1, c1 + 1); c += 1) if (filled(r, c)) return true;
      return false;
    };
    const colHas = (c: number) => {
      for (let r = Math.max(win.r0, r0 - 1); r <= Math.min(win.r1, r1 + 1); r += 1) if (filled(r, c)) return true;
      return false;
    };
    if (r0 > win.r0 && rowHas(r0 - 1)) {
      r0 -= 1;
      changed = true;
    }
    if (r1 < win.r1 && rowHas(r1 + 1)) {
      r1 += 1;
      changed = true;
    }
    if (c0 > win.c0 && colHas(c0 - 1)) {
      c0 -= 1;
      changed = true;
    }
    if (c1 < win.c1 && colHas(c1 + 1)) {
      c1 += 1;
      changed = true;
    }
  }
  return { r0, c0, r1, c1 };
}

/** Removes empty outer rows/columns of a selection (e.g. whole columns selected). */
export function trimEmpty(data: RangeValues): CellRange | null {
  const { range, values } = data;
  let r0 = Infinity;
  let r1 = -Infinity;
  let c0 = Infinity;
  let c1 = -Infinity;
  for (let r = 0; r < values.length; r += 1) {
    const row = values[r];
    for (let c = 0; c < row.length; c += 1) {
      if (isEmpty(row[c])) continue;
      r0 = Math.min(r0, r);
      r1 = Math.max(r1, r);
      c0 = Math.min(c0, c);
      c1 = Math.max(c1, c);
    }
  }
  if (r0 === Infinity) return null;
  return { r0: range.r0 + r0, c0: range.c0 + c0, r1: range.r0 + r1, c1: range.c0 + c1 };
}
