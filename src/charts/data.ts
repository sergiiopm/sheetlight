import type { CellValue, ChartSeries, ChartSpec, ChartType, RangeValues, SheetMeta, WorkbookEngine } from "@/engine/contract";
import type { CellRange, DocumentId, SheetId } from "@/engine/types";
import { resolveRef, type ResolvedRef } from "@/charts/refs";
import { normalizeColor, paletteColor } from "@/charts/theme";

/** Resolved numbers and labels of one series, ready to draw. */
export interface SeriesData {
  readonly name: string;
  /** null = gap (empty cell or error). Text is plotted as 0, like Excel. */
  readonly values: ReadonlyArray<number | null>;
  /** Scatter X values (null when the X range is missing or not numeric: 1..n). */
  readonly xValues: ReadonlyArray<number | null> | null;
  readonly color: string;
  /** Effective plot type (combo charts). */
  readonly type: ChartType;
}

export interface ChartData {
  readonly categories: ReadonlyArray<string>;
  readonly series: ReadonlyArray<SeriesData>;
}

/** The parts of a `ChartSpec` that affect drawing (everything but id/anchor). */
export type ChartLook = Pick<ChartSpec, "type" | "grouping" | "title" | "legend" | "xAxisTitle" | "yAxisTitle">;

/** A sheet range a chart reads from (for change tracking). */
export interface ChartDependency {
  readonly sheet: SheetId;
  readonly range: CellRange;
}

/** Effective plot type of a series (only column/line/area mix in combos). */
export function seriesType(chartType: ChartType, series: ChartSeries): ChartType {
  const t = series.chartType;
  const combinable = (x: ChartType) => x === "column" || x === "line" || x === "area";
  return t && combinable(chartType) && combinable(t) ? t : chartType;
}

/** Ranges read by a chart, resolved against the current sheet names. */
export function chartDependencies(
  chart: Pick<ChartSpec, "sheet" | "series">,
  sheets: ReadonlyArray<SheetMeta>,
): ChartDependency[] {
  const deps: ChartDependency[] = [];
  for (const s of chart.series) {
    for (const ref of [s.valuesRef, s.categoriesRef, s.nameRef]) {
      if (!ref) continue;
      for (const area of resolveRef(ref, sheets, chart.sheet) ?? []) deps.push({ sheet: area.sheet, range: area.range });
    }
  }
  return deps;
}

/** Fetches range values once per distinct (sheet, range) and clamps whole rows/cols. */
class RangeFetcher {
  private readonly cache = new Map<string, Promise<RangeValues | null>>();
  private readonly used = new Map<SheetId, Promise<CellRange | null>>();

  constructor(
    private readonly engine: WorkbookEngine,
    private readonly doc: DocumentId,
  ) {}

  private usedRange(sheet: SheetId): Promise<CellRange | null> {
    let p = this.used.get(sheet);
    if (!p) {
      p = this.engine.getSheetInfo(this.doc, sheet).then(
        (info) => info.usedRange,
        () => null,
      );
      this.used.set(sheet, p);
    }
    return p;
  }

  async fetch(area: ResolvedRef): Promise<RangeValues | null> {
    let range = area.range;
    if (area.wholeCols || area.wholeRows) {
      const used = await this.usedRange(area.sheet);
      if (!used) return null;
      range = {
        r0: Math.max(range.r0, used.r0),
        r1: Math.min(range.r1, used.r1),
        c0: Math.max(range.c0, used.c0),
        c1: Math.min(range.c1, used.c1),
      };
      if (range.r0 > range.r1 || range.c0 > range.c1) return null;
    }
    const key = `${area.sheet}:${range.r0}:${range.c0}:${range.r1}:${range.c1}`;
    let p = this.cache.get(key);
    if (!p) {
      p = this.engine.getRangeValues(this.doc, area.sheet, range).catch(() => null);
      this.cache.set(key, p);
    }
    return p;
  }

  /** Values of every area of a reference, flattened row-major. */
  async cells(formula: string | null, sheets: ReadonlyArray<SheetMeta>, defaultSheet: SheetId) {
    if (!formula) return null;
    const areas = resolveRef(formula, sheets, defaultSheet);
    if (!areas) return null;
    const values: CellValue[] = [];
    const display: string[] = [];
    const results = await Promise.all(areas.map((a) => this.fetch(a)));
    for (const r of results) {
      if (!r) continue;
      for (let i = 0; i < r.values.length; i += 1) {
        const vRow = r.values[i];
        const dRow = r.display[i];
        for (let j = 0; j < vRow.length; j += 1) {
          values.push(vRow[j]);
          display.push(dRow[j] ?? "");
        }
      }
    }
    return { values, display };
  }
}

function plotted(v: CellValue): number | null {
  switch (v.type) {
    case "number":
      return Number.isFinite(v.value) ? v.value : null;
    case "text":
    case "bool":
      return 0;
    default:
      return null;
  }
}

/**
 * Reads every series of a chart from the engine. Missing sheets or invalid
 * references produce empty series instead of errors (Excel shows an empty
 * chart, it does not fail).
 */
export async function resolveChartData(
  engine: WorkbookEngine,
  doc: DocumentId,
  chart: Pick<ChartSpec, "sheet" | "series" | "type">,
  sheets: ReadonlyArray<SheetMeta>,
): Promise<ChartData> {
  const fetcher = new RangeFetcher(engine, doc);
  const resolved = await Promise.all(
    chart.series.map(async (s) => {
      const [vals, cats, name] = await Promise.all([
        fetcher.cells(s.valuesRef, sheets, chart.sheet),
        fetcher.cells(s.categoriesRef, sheets, chart.sheet),
        fetcher.cells(s.nameRef, sheets, chart.sheet),
      ]);
      return { s, vals, cats, name };
    }),
  );

  let categories: string[] = [];
  let pointCount = 0;
  for (const r of resolved) pointCount = Math.max(pointCount, r.vals?.values.length ?? 0);
  // Excel takes the category labels from the first series that has them.
  const withCats = resolved.find((r) => r.cats && r.cats.display.length > 0);
  if (withCats?.cats) categories = withCats.cats.display.slice();
  if (categories.length < pointCount) {
    for (let i = categories.length; i < pointCount; i += 1) categories.push(String(i + 1));
  }

  const series: SeriesData[] = resolved.map((r, index) => {
    const type = seriesType(chart.type, r.s);
    const values = r.vals ? r.vals.values.map(plotted) : [];
    let xValues: (number | null)[] | null = null;
    if (type === "scatter" && r.cats) {
      const xs = r.cats.values.map((v) => (v.type === "number" ? v.value : null));
      // Text X values: Excel falls back to 1..n.
      xValues = xs.some((x) => x !== null) ? xs : null;
    }
    const nameText = r.name ? r.name.display.filter((t) => t !== "").join(" ") : "";
    const name = nameText || r.s.name || `Serie${index + 1}`;
    const color = normalizeColor(r.s.color) ?? paletteColor(index);
    return { name, values, xValues, color, type };
  });

  return { categories, series };
}
