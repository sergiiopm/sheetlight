import type { ChartType } from "@/engine/contract";
import type { ChartData, ChartLook, SeriesData } from "@/charts/data";
import { formatPercent, formatTick, niceScale, percentScale, type AxisScale } from "@/charts/scale";
import { CHART_STYLE, font, luminance, paletteColor } from "@/charts/theme";

/**
 * Canvas 2D chart renderer with Excel 2013+ default styling. Pure drawing:
 * callers size the canvas and set the device-pixel transform; everything here
 * is in CSS px at 100% zoom. `layoutChart` is separate so layout math can be
 * tested without a canvas (any object with `measureText` works).
 */
export type ChartContext2D = Pick<
  CanvasRenderingContext2D,
  | "save"
  | "restore"
  | "beginPath"
  | "closePath"
  | "moveTo"
  | "lineTo"
  | "arc"
  | "rect"
  | "fill"
  | "stroke"
  | "fillRect"
  | "strokeRect"
  | "fillText"
  | "measureText"
  | "translate"
  | "rotate"
  | "clip"
  | "setLineDash"
  | "fillStyle"
  | "strokeStyle"
  | "lineWidth"
  | "font"
  | "textAlign"
  | "textBaseline"
  | "lineJoin"
  | "lineCap"
>;

export type TextMeasurer = Pick<ChartContext2D, "measureText" | "font">;

export interface RenderOptions {
  /** Thumbnail mode (chart gallery): no texts, legend or border. */
  readonly compact?: boolean;
  /** Draw the light gray chart-area border (default true). */
  readonly border?: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface LegendItem {
  readonly label: string;
  readonly color: string;
  readonly kind: "box" | "line";
  readonly x: number;
  readonly y: number;
}

export interface CategoryAxisLayout {
  /** Label rotation in degrees (0 or -45). */
  readonly rotation: 0 | -45;
  /** Draw every n-th label. */
  readonly every: number;
  /** Wrapped lines per category label (horizontal mode). */
  readonly lines: ReadonlyArray<ReadonlyArray<string>>;
}

export interface ChartLayout {
  readonly width: number;
  readonly height: number;
  readonly title: { readonly lines: ReadonlyArray<string>; readonly y: number } | null;
  readonly legend: { readonly rect: Rect; readonly items: ReadonlyArray<LegendItem> } | null;
  readonly plot: Rect;
  /** Value axis (Y for scatter). */
  readonly valueScale: AxisScale | null;
  /** Scatter X axis. */
  readonly xScale: AxisScale | null;
  readonly categoryAxis: CategoryAxisLayout | null;
  readonly pointCount: number;
  readonly horizontal: boolean;
  readonly percent: boolean;
  readonly leftTitle: string | null;
  readonly bottomTitle: string | null;
}

const LABEL_GAP = 6;
const ELLIPSIS = "…";

function measure(ctx: TextMeasurer, text: string): number {
  return ctx.measureText(text).width;
}

/** Truncates with an ellipsis to fit `maxWidth`. */
export function fitText(ctx: TextMeasurer, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (measure(ctx, text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(ctx, text.slice(0, mid) + ELLIPSIS) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : text.slice(0, lo).trimEnd() + ELLIPSIS;
}

/** Greedy word wrap; returns null when a single word does not fit. */
function wrapText(ctx: TextMeasurer, text: string, maxWidth: number, maxLines: number): string[] | null {
  if (measure(ctx, text) <= maxWidth) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (measure(ctx, candidate) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (!line) return null;
    lines.push(line);
    line = word;
    if (measure(ctx, line) > maxWidth) return null;
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

function isPieLike(type: ChartType): boolean {
  return type === "pie" || type === "doughnut";
}

function pointCountOf(data: ChartData): number {
  let n = data.categories.length;
  for (const s of data.series) n = Math.max(n, s.values.length);
  return n;
}

/** Series stacked/normalized according to the chart grouping (primary plot only). */
interface Stacked {
  /** Bottom and top of each point (value space), per series. */
  readonly base: ReadonlyArray<Float64Array>;
  readonly top: ReadonlyArray<Float64Array>;
  readonly present: ReadonlyArray<Uint8Array>;
  readonly min: number;
  readonly max: number;
}

function stackSeries(look: ChartLook, data: ChartData, n: number): Stacked {
  const stacked = look.grouping === "stacked" || look.grouping === "percentStacked";
  const percent = look.grouping === "percentStacked";
  const base: Float64Array[] = [];
  const top: Float64Array[] = [];
  const present: Uint8Array[] = [];
  const posAcc = new Float64Array(n);
  const negAcc = new Float64Array(n);
  const totals = new Float64Array(n);
  if (percent) {
    for (const s of data.series) {
      if (s.type !== look.type) continue;
      for (let i = 0; i < n; i += 1) totals[i] += Math.abs(s.values[i] ?? 0);
    }
  }
  let min = Infinity;
  let max = -Infinity;
  for (const s of data.series) {
    const b = new Float64Array(n);
    const t = new Float64Array(n);
    const p = new Uint8Array(n);
    const inStack = stacked && s.type === look.type;
    for (let i = 0; i < n; i += 1) {
      const raw = s.values[i];
      if (raw === null || raw === undefined) {
        // Gaps: stacked areas/lines continue at the running total.
        b[i] = inStack ? posAcc[i] : 0;
        t[i] = b[i];
        continue;
      }
      p[i] = 1;
      let v = raw;
      if (percent && inStack) v = totals[i] === 0 ? 0 : v / totals[i];
      if (inStack) {
        if (v >= 0) {
          b[i] = posAcc[i];
          posAcc[i] += v;
          t[i] = posAcc[i];
        } else {
          b[i] = negAcc[i];
          negAcc[i] += v;
          t[i] = negAcc[i];
        }
      } else {
        b[i] = 0;
        t[i] = v;
      }
      min = Math.min(min, t[i], b[i]);
      max = Math.max(max, t[i], b[i]);
    }
    base.push(b);
    top.push(t);
    present.push(p);
  }
  if (min === Infinity) {
    min = 0;
    max = 0;
  }
  return { base, top, present, min, max };
}

function legendItems(look: ChartLook, data: ChartData): Array<{ label: string; color: string; kind: "box" | "line" }> {
  if (isPieLike(look.type)) {
    const n = pointCountOf(data);
    const out = [];
    for (let i = 0; i < n; i += 1) out.push({ label: data.categories[i] ?? String(i + 1), color: paletteColor(i), kind: "box" as const });
    return out;
  }
  return data.series.map((s) => ({
    label: s.name,
    color: s.color,
    kind: s.type === "line" || s.type === "scatter" ? ("line" as const) : ("box" as const),
  }));
}

function intervalsFor(length: number, spacing: number): number {
  return Math.max(1, Math.min(12, Math.floor(length / spacing)));
}

function scatterX(s: SeriesData, i: number): number | null {
  return s.xValues ? (s.xValues[i] ?? null) : i + 1;
}

export function layoutChart(
  ctx: TextMeasurer,
  width: number,
  height: number,
  look: ChartLook,
  data: ChartData,
  options: RenderOptions = {},
): ChartLayout {
  const compact = options.compact ?? false;
  const pad = compact ? 4 : CHART_STYLE.padding;
  let x = pad;
  let y = pad;
  let w = Math.max(0, width - 2 * pad);
  let h = Math.max(0, height - 2 * pad);
  const n = pointCountOf(data);
  const horizontal = look.type === "bar";
  const percent = look.grouping === "percentStacked" && !isPieLike(look.type) && look.type !== "scatter";

  // Title.
  let title: ChartLayout["title"] = null;
  if (!compact && look.title && look.title.trim()) {
    ctx.font = font(CHART_STYLE.titleSize);
    const lines = look.title.split("\n").map((l) => fitText(ctx, l, w));
    const lineH = CHART_STYLE.titleSize * 1.25;
    title = { lines, y: y + lineH / 2 };
    y += lines.length * lineH + 6;
    h -= lines.length * lineH + 6;
  }

  // Legend.
  let legend: ChartLayout["legend"] = null;
  const rawItems = compact || look.legend === "none" ? [] : legendItems(look, data);
  if (rawItems.length > 0 && w > 40 && h > 30) {
    ctx.font = font(CHART_STYLE.legendSize);
    const itemH = CHART_STYLE.legendSize * 1.45;
    const keyW = (kind: "box" | "line") => (kind === "line" ? 20 : 7);
    const items: LegendItem[] = [];
    if (look.legend === "right" || look.legend === "left") {
      const maxW = w * 0.4;
      let lw = 0;
      const fitted = rawItems.map((it) => {
        const label = fitText(ctx, it.label, maxW - keyW(it.kind) - 5);
        lw = Math.max(lw, keyW(it.kind) + 5 + measure(ctx, label));
        return { ...it, label };
      });
      const visible = Math.max(1, Math.min(fitted.length, Math.floor(h / itemH)));
      const lh = visible * itemH;
      const lx = look.legend === "right" ? x + w - lw : x;
      const ly = y + (h - lh) / 2;
      for (let i = 0; i < visible; i += 1) items.push({ ...fitted[i], x: lx, y: ly + i * itemH + itemH / 2 });
      legend = { rect: { x: lx, y: ly, w: lw, h: lh }, items };
      if (look.legend === "right") w -= lw + 10;
      else {
        x += lw + 10;
        w -= lw + 10;
      }
    } else {
      // Rows of items, each row centered.
      const rows: Array<Array<{ label: string; color: string; kind: "box" | "line"; width: number }>> = [[]];
      let rowW = 0;
      for (const it of rawItems) {
        const label = fitText(ctx, it.label, w - keyW(it.kind) - 5);
        const itemW = keyW(it.kind) + 5 + measure(ctx, label);
        const sep = rows[rows.length - 1].length > 0 ? 14 : 0;
        if (rowW + sep + itemW > w && rows[rows.length - 1].length > 0) {
          rows.push([]);
          rowW = 0;
        }
        rows[rows.length - 1].push({ ...it, label, width: itemW });
        rowW += (rows[rows.length - 1].length > 1 ? 14 : 0) + itemW;
      }
      const maxRows = Math.max(1, Math.floor((h * 0.3) / itemH));
      const shown = rows.slice(0, maxRows);
      const lh = shown.length * itemH;
      const ly = look.legend === "top" ? y : y + h - lh;
      let maxRowW = 0;
      shown.forEach((row, r) => {
        const total = row.reduce((acc, it, i) => acc + it.width + (i > 0 ? 14 : 0), 0);
        maxRowW = Math.max(maxRowW, total);
        let ix = x + (w - total) / 2;
        for (const it of row) {
          items.push({ label: it.label, color: it.color, kind: it.kind, x: ix, y: ly + r * itemH + itemH / 2 });
          ix += it.width + 14;
        }
      });
      legend = { rect: { x: x + (w - maxRowW) / 2, y: ly, w: maxRowW, h: lh }, items };
      if (look.legend === "top") y += lh + 6;
      h -= lh + 6;
    }
  }

  const base = {
    width,
    height,
    title,
    legend,
    pointCount: n,
    horizontal,
    percent,
  };

  if (isPieLike(look.type)) {
    return {
      ...base,
      plot: { x, y, w: Math.max(0, w), h: Math.max(0, h) },
      valueScale: null,
      xScale: null,
      categoryAxis: null,
      leftTitle: null,
      bottomTitle: null,
    };
  }

  // Axis titles.
  const leftTitle = compact ? null : (horizontal ? look.xAxisTitle : look.yAxisTitle) || null;
  const bottomTitle = compact ? null : (horizontal ? look.yAxisTitle : look.xAxisTitle) || null;
  const axisTitleH = CHART_STYLE.axisTitleSize * 1.25;
  if (leftTitle) {
    x += axisTitleH + 4;
    w -= axisTitleH + 4;
  }
  if (bottomTitle) h -= axisTitleH + 4;

  const labelH = compact ? 0 : CHART_STYLE.labelSize * 1.25;
  ctx.font = font(CHART_STYLE.labelSize);

  if (look.type === "scatter") {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of data.series) {
      for (let i = 0; i < s.values.length; i += 1) {
        const vy = s.values[i];
        const vx = scatterX(s, i);
        if (vy === null || vx === null) continue;
        minX = Math.min(minX, vx);
        maxX = Math.max(maxX, vx);
        minY = Math.min(minY, vy);
        maxY = Math.max(maxY, vy);
      }
    }
    if (minX === Infinity) {
      minX = 0;
      maxX = 1;
      minY = 0;
      maxY = 1;
    }
    let plotH = h - labelH - (compact ? 0 : 4);
    const yScale = niceScale(minY, maxY, intervalsFor(plotH, CHART_STYLE.labelSize * 2.6));
    const yLabelW = compact ? 0 : Math.max(...yScale.ticks.map((t) => measure(ctx, formatTick(t, yScale, false))));
    const plotX = x + yLabelW + (compact ? 0 : LABEL_GAP);
    let plotW = Math.max(0, x + w - plotX - (compact ? 0 : 8));
    const sampleX = niceScale(minX, maxX, 10);
    const xLabelW = compact ? 20 : Math.max(...sampleX.ticks.map((t) => measure(ctx, formatTick(t, sampleX, false))));
    const xScale = niceScale(minX, maxX, intervalsFor(plotW, xLabelW + 16));
    plotH = Math.max(0, plotH);
    plotW = Math.max(0, plotW);
    return {
      ...base,
      plot: { x: plotX, y, w: plotW, h: plotH },
      valueScale: yScale,
      xScale,
      categoryAxis: null,
      leftTitle,
      bottomTitle,
    };
  }

  const stack = stackSeries(look, data, n);
  const scaleFor = (length: number, spacing: number): AxisScale =>
    percent ? percentScale(intervalsFor(length, spacing)) : niceScale(stack.min, stack.max, intervalsFor(length, spacing));
  const tickLabelWidth = (scale: AxisScale) =>
    compact ? 0 : Math.max(...scale.ticks.map((t) => measure(ctx, formatTick(t, scale, percent))));

  if (!horizontal) {
    // Vertical value axis on the left, categories at the bottom.
    let catH = labelH;
    let plotH = Math.max(0, h - catH - (compact ? 0 : 4));
    let scale = scaleFor(plotH, CHART_STYLE.labelSize * 2.6);
    let categoryAxis: CategoryAxisLayout = { rotation: 0, every: 1, lines: [] };
    let plotX = x;
    let plotW = w;
    for (let pass = 0; pass < 2; pass += 1) {
      const valueW = tickLabelWidth(scale);
      plotX = x + valueW + (compact ? 0 : LABEL_GAP);
      plotW = Math.max(0, x + w - plotX - (compact ? 0 : 4));
      const slot = n > 0 ? plotW / n : plotW;
      if (compact) {
        categoryAxis = { rotation: 0, every: 1, lines: [] };
        catH = 0;
      } else {
        categoryAxis = categoryLabels(ctx, data, n, slot, h * 0.4);
        catH = categoryAxis.rotation === -45 ? rotatedHeight(ctx, data, n, h * 0.4) : labelH * Math.max(1, ...categoryAxis.lines.map((l) => l.length));
      }
      plotH = Math.max(0, h - catH - (compact ? 0 : 4));
      scale = scaleFor(plotH, CHART_STYLE.labelSize * 2.6);
    }
    return {
      ...base,
      plot: { x: plotX, y, w: plotW, h: plotH },
      valueScale: scale,
      xScale: null,
      categoryAxis,
      leftTitle,
      bottomTitle,
    };
  }

  // Horizontal bars: categories on the left, values at the bottom.
  const plotH = Math.max(0, h - labelH - (compact ? 0 : 4));
  const slot = n > 0 ? plotH / n : plotH;
  let catW = 0;
  const lines: string[][] = [];
  if (!compact) {
    const maxCatW = w * 0.35;
    for (let i = 0; i < n; i += 1) {
      const label = fitText(ctx, data.categories[i] ?? String(i + 1), maxCatW);
      lines.push([label]);
      catW = Math.max(catW, measure(ctx, label));
    }
  }
  const every = compact ? 1 : Math.max(1, Math.ceil((labelH * 1.05) / Math.max(slot, 0.0001)));
  const plotX = x + catW + (compact ? 0 : LABEL_GAP);
  const plotW = Math.max(0, x + w - plotX - (compact ? 0 : 8));
  const sample = scaleFor(plotW, 60);
  const valueW = tickLabelWidth(sample);
  const scale = scaleFor(plotW, Math.max(30, valueW + 18));
  return {
    ...base,
    plot: { x: plotX, y, w: plotW, h: plotH },
    valueScale: scale,
    xScale: null,
    categoryAxis: { rotation: 0, every, lines },
    leftTitle,
    bottomTitle,
  };
}

/** Horizontal labels when they fit (wrapping to 2 lines), else -45° and skipping. */
function categoryLabels(ctx: TextMeasurer, data: ChartData, n: number, slot: number, maxHeight: number): CategoryAxisLayout {
  const labelH = CHART_STYLE.labelSize * 1.25;
  const maxW = slot * 0.92;
  const lines: string[][] = [];
  let fits = n > 0;
  for (let i = 0; i < n && fits; i += 1) {
    const wrapped = wrapText(ctx, data.categories[i] ?? String(i + 1), maxW, 2);
    if (!wrapped) fits = false;
    else lines.push(wrapped);
  }
  if (fits) return { rotation: 0, every: 1, lines };
  const every = Math.max(1, Math.ceil((labelH * 1.4) / Math.max(slot, 0.0001)));
  // Rotated labels never wrap; truncate to the space available along the diagonal.
  const maxDiag = Math.max(0, maxHeight / Math.SQRT1_2 - labelH);
  const rotated: string[][] = [];
  for (let i = 0; i < n; i += 1) rotated.push([fitText(ctx, data.categories[i] ?? String(i + 1), maxDiag)]);
  return { rotation: -45, every, lines: rotated };
}

function rotatedHeight(ctx: TextMeasurer, data: ChartData, n: number, maxHeight: number): number {
  const labelH = CHART_STYLE.labelSize * 1.25;
  let maxW = 0;
  for (let i = 0; i < n; i += 1) maxW = Math.max(maxW, measure(ctx, data.categories[i] ?? String(i + 1)));
  return Math.min(maxHeight, maxW * Math.SQRT1_2 + labelH * Math.SQRT1_2 + 2);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function crisp(v: number): number {
  return Math.round(v) + 0.5;
}

function valuePos(scale: AxisScale, v: number, start: number, length: number, invert: boolean): number {
  const t = scale.max === scale.min ? 0 : (v - scale.min) / (scale.max - scale.min);
  return invert ? start + length - t * length : start + t * length;
}

function clampValue(scale: AxisScale, v: number): number {
  return Math.min(scale.max, Math.max(scale.min, v));
}

export function renderChart(
  ctx: ChartContext2D,
  width: number,
  height: number,
  look: ChartLook,
  data: ChartData,
  options: RenderOptions = {},
): ChartLayout {
  const layout = layoutChart(ctx, width, height, look, data, options);
  const compact = options.compact ?? false;
  ctx.save();
  ctx.fillStyle = CHART_STYLE.background;
  ctx.fillRect(0, 0, width, height);
  if (options.border ?? !compact) {
    ctx.strokeStyle = CHART_STYLE.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  }
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";

  if (isPieLike(look.type)) drawPie(ctx, layout, look, data, compact);
  else if (look.type === "scatter") drawScatter(ctx, layout, data, compact);
  else drawCategoryChart(ctx, layout, look, data, compact);

  if (layout.title) {
    ctx.font = font(CHART_STYLE.titleSize);
    ctx.fillStyle = CHART_STYLE.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = CHART_STYLE.titleSize * 1.25;
    layout.title.lines.forEach((line, i) => ctx.fillText(line, width / 2, layout.title!.y + i * lineH));
  }
  if (layout.legend) drawLegend(ctx, layout.legend.items);
  ctx.restore();
  return layout;
}

function drawLegend(ctx: ChartContext2D, items: ReadonlyArray<LegendItem>) {
  ctx.font = font(CHART_STYLE.legendSize);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const it of items) {
    if (it.kind === "line") {
      ctx.strokeStyle = it.color;
      ctx.lineWidth = CHART_STYLE.lineWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(it.x + 1.5, it.y);
      ctx.lineTo(it.x + 18.5, it.y);
      ctx.stroke();
      ctx.lineCap = "butt";
    } else {
      ctx.fillStyle = it.color;
      ctx.fillRect(it.x, it.y - 3.5, 7, 7);
    }
    ctx.fillStyle = CHART_STYLE.text;
    ctx.fillText(it.label, it.x + (it.kind === "line" ? 20 : 7) + 5, it.y);
  }
}

function drawAxisTitles(ctx: ChartContext2D, layout: ChartLayout) {
  ctx.font = font(CHART_STYLE.axisTitleSize);
  ctx.fillStyle = CHART_STYLE.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const { plot } = layout;
  const half = (CHART_STYLE.axisTitleSize * 1.25) / 2;
  if (layout.bottomTitle) {
    const yPos = layout.height - CHART_STYLE.padding - half - (layout.legend && layout.legend.rect.y > plot.y + plot.h ? layout.legend.rect.h + 6 : 0);
    ctx.fillText(fitText(ctx, layout.bottomTitle, plot.w), plot.x + plot.w / 2, yPos);
  }
  if (layout.leftTitle) {
    const legendLeft = layout.legend && layout.legend.rect.x + layout.legend.rect.w < plot.x ? layout.legend.rect.w + 10 : 0;
    ctx.save();
    ctx.translate(CHART_STYLE.padding + legendLeft + half, plot.y + plot.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(fitText(ctx, layout.leftTitle, plot.h), 0, 0);
    ctx.restore();
  }
}

function drawCategoryChart(ctx: ChartContext2D, layout: ChartLayout, look: ChartLook, data: ChartData, compact: boolean) {
  const { plot, pointCount: n, horizontal, percent } = layout;
  const scale = layout.valueScale!;
  if (plot.w <= 0 || plot.h <= 0) return;
  const valueStart = horizontal ? plot.x : plot.y;
  const valueLen = horizontal ? plot.w : plot.h;
  const toPx = (v: number) => valuePos(scale, clampValue(scale, v), valueStart, valueLen, !horizontal);

  // Gridlines.
  ctx.strokeStyle = CHART_STYLE.gridline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of scale.ticks) {
    const p = crisp(toPx(t));
    if (horizontal) {
      ctx.moveTo(p, plot.y);
      ctx.lineTo(p, plot.y + plot.h);
    } else {
      ctx.moveTo(plot.x, p);
      ctx.lineTo(plot.x + plot.w, p);
    }
  }
  ctx.stroke();

  const stack = stackSeries(look, data, n);
  const slot = n > 0 ? (horizontal ? plot.h : plot.w) / n : 0;
  const catStart = horizontal ? plot.y : plot.x;
  // Horizontal bars list the first category at the bottom (Excel default).
  const slotStart = (i: number) => (horizontal ? catStart + (n - 1 - i) * slot : catStart + i * slot);
  const stacked = look.grouping === "stacked" || look.grouping === "percentStacked";
  const hasBars = data.series.some((s) => s.type === "column" || s.type === "bar");
  const zero = toPx(0);

  const plotClip = () => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x - 1, plot.y - 1, plot.w + 2, plot.h + 2);
    ctx.clip();
  };
  plotClip();

  // Areas first (behind bars and lines), then bars, then lines.
  const areaEdge = !hasBars && data.series.every((s) => s.type === "area");
  data.series.forEach((s, si) => {
    if (s.type !== "area" || n === 0) return;
    const inStack = stacked && s.type === look.type;
    const xAt = (i: number) => (areaEdge ? (n === 1 ? plot.x + plot.w / 2 : plot.x + (plot.w * i) / (n - 1)) : slotStart(i) + slot / 2);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const top = inStack ? stack.top[si][i] : (s.values[i] ?? 0);
      const px = xAt(i);
      const py = toPx(top);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      const bottom = inStack ? stack.base[si][i] : 0;
      ctx.lineTo(xAt(i), toPx(bottom));
    }
    ctx.closePath();
    ctx.fill();
  });

  // Bars.
  const barSeries = data.series.map((s, i) => ({ s, i })).filter(({ s }) => s.type === "column" || s.type === "bar");
  if (barSeries.length > 0 && slot > 0) {
    const primaryStacked = stacked && (look.type === "column" || look.type === "bar");
    const m = primaryStacked ? 1 : barSeries.length;
    const overlap = primaryStacked ? 1 : -0.27;
    const gap = primaryStacked ? 1.5 : 2.19;
    const bw = slot / (m - (m - 1) * overlap + gap);
    barSeries.forEach(({ s, i: si }, k) => {
      ctx.fillStyle = s.color;
      const offset = (gap * bw) / 2 + (primaryStacked ? 0 : k * bw * (1 - overlap));
      for (let i = 0; i < n; i += 1) {
        if (!stack.present[si][i]) continue;
        const a = toPx(primaryStacked ? stack.base[si][i] : 0);
        const b = toPx(primaryStacked ? stack.top[si][i] : (s.values[i] ?? 0));
        const lo = Math.min(a, b);
        const len = Math.abs(b - a);
        if (len < 0.01) continue;
        if (horizontal) {
          const top = slotStart(i) + slot - offset - bw;
          ctx.fillRect(lo, top, len, bw);
        } else {
          ctx.fillRect(slotStart(i) + offset, lo, bw, len);
        }
      }
    });
  }

  // Lines.
  data.series.forEach((s, si) => {
    if (s.type !== "line" || n === 0) return;
    const inStack = stacked && s.type === look.type;
    const pts: Array<[number, number] | null> = [];
    for (let i = 0; i < n; i += 1) {
      if (!stack.present[si][i]) {
        pts.push(null);
        continue;
      }
      const v = inStack ? stack.top[si][i] : (s.values[i] ?? 0);
      pts.push([slotStart(i) + slot / 2, toPx(v)]);
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = compact ? 2 : CHART_STYLE.lineWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (!p) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
      pen = true;
    }
    ctx.stroke();
    ctx.lineCap = "butt";
    if (!compact && n <= 40) {
      ctx.fillStyle = s.color;
      for (const p of pts) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], CHART_STYLE.markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  });
  ctx.restore();

  // Category axis line at zero (or at the axis minimum).
  ctx.strokeStyle = CHART_STYLE.axisLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (horizontal) {
    const p = crisp(zero);
    ctx.moveTo(p, plot.y);
    ctx.lineTo(p, plot.y + plot.h);
  } else {
    const p = crisp(zero);
    ctx.moveTo(plot.x, p);
    ctx.lineTo(plot.x + plot.w, p);
  }
  ctx.stroke();

  if (compact) return;

  // Value labels.
  ctx.font = font(CHART_STYLE.labelSize);
  ctx.fillStyle = CHART_STYLE.text;
  if (horizontal) {
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of scale.ticks) ctx.fillText(formatTick(t, scale, percent), toPx(t), plot.y + plot.h + 4);
  } else {
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of scale.ticks) ctx.fillText(formatTick(t, scale, percent), plot.x - LABEL_GAP, toPx(t));
  }

  // Category labels.
  const cat = layout.categoryAxis;
  if (cat && n > 0) {
    const labelH = CHART_STYLE.labelSize * 1.25;
    for (let i = 0; i < n; i += cat.every) {
      const lines = cat.lines[i] ?? [];
      const center = slotStart(i) + slot / 2;
      if (horizontal) {
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(lines[0] ?? "", plot.x - LABEL_GAP, center);
      } else if (cat.rotation === 0) {
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        lines.forEach((line, li) => ctx.fillText(line, center, plot.y + plot.h + 4 + li * labelH));
      } else {
        ctx.save();
        ctx.translate(center, plot.y + plot.h + 4);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText(lines[0] ?? "", 0, 0);
        ctx.restore();
      }
    }
  }
  drawAxisTitles(ctx, layout);
}

function drawScatter(ctx: ChartContext2D, layout: ChartLayout, data: ChartData, compact: boolean) {
  const { plot } = layout;
  const ys = layout.valueScale!;
  const xs = layout.xScale!;
  if (plot.w <= 0 || plot.h <= 0) return;
  const px = (v: number) => valuePos(xs, v, plot.x, plot.w, false);
  const py = (v: number) => valuePos(ys, v, plot.y, plot.h, true);
  ctx.strokeStyle = CHART_STYLE.gridline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of ys.ticks) {
    const p = crisp(py(t));
    ctx.moveTo(plot.x, p);
    ctx.lineTo(plot.x + plot.w, p);
  }
  for (const t of xs.ticks) {
    const p = crisp(px(t));
    ctx.moveTo(p, plot.y);
    ctx.lineTo(p, plot.y + plot.h);
  }
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x - 4, plot.y - 4, plot.w + 8, plot.h + 8);
  ctx.clip();
  const r = (compact ? 4 : CHART_STYLE.markerSize) / 2;
  for (const s of data.series) {
    ctx.fillStyle = s.color;
    for (let i = 0; i < s.values.length; i += 1) {
      const vy = s.values[i];
      const vx = scatterX(s, i);
      if (vy === null || vx === null) continue;
      ctx.beginPath();
      ctx.arc(px(vx), py(vy), r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  if (compact) return;
  ctx.font = font(CHART_STYLE.labelSize);
  ctx.fillStyle = CHART_STYLE.text;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const t of ys.ticks) ctx.fillText(formatTick(t, ys, false), plot.x - LABEL_GAP, py(t));
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of xs.ticks) ctx.fillText(formatTick(t, xs, false), px(t), plot.y + plot.h + 4);
  drawAxisTitles(ctx, layout);
}

function drawPie(ctx: ChartContext2D, layout: ChartLayout, look: ChartLook, data: ChartData, compact: boolean) {
  const { plot } = layout;
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const radius = (Math.min(plot.w, plot.h) / 2) * (compact ? 0.95 : 0.9);
  if (radius <= 2) return;
  const doughnut = look.type === "doughnut";
  const rings = doughnut ? data.series : data.series.slice(0, 1);
  if (rings.length === 0) return;
  const hole = doughnut ? radius * 0.5 : 0;
  const ringW = (radius - hole) / rings.length;
  ctx.font = font(CHART_STYLE.labelSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  rings.forEach((s, ri) => {
    const inner = hole + ri * ringW;
    const outer = inner + ringW;
    let total = 0;
    for (const v of s.values) total += Math.abs(v ?? 0);
    if (total <= 0) return;
    let angle = -Math.PI / 2;
    const labels: Array<{ x: number; y: number; text: string; color: string }> = [];
    s.values.forEach((v, i) => {
      const value = Math.abs(v ?? 0);
      if (value === 0) return;
      const sweep = (value / total) * Math.PI * 2;
      const color = paletteColor(i);
      ctx.fillStyle = color;
      ctx.beginPath();
      if (inner > 0) {
        ctx.arc(cx, cy, outer, angle, angle + sweep);
        ctx.arc(cx, cy, inner, angle + sweep, angle, true);
      } else {
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, outer, angle, angle + sweep);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#FFFFFF";
      ctx.lineWidth = compact ? 1 : 1.5;
      ctx.stroke();
      if (!compact) {
        const mid = angle + sweep / 2;
        const lr = inner > 0 ? (inner + outer) / 2 : outer * 0.62;
        const text = formatPercent(value / total);
        const tw = ctx.measureText(text).width;
        const room = inner > 0 ? Math.min(sweep * lr, ringW * 2) : sweep * lr;
        if (room >= tw * 0.9 || sweep > 0.5) {
          labels.push({
            x: cx + Math.cos(mid) * lr,
            y: cy + Math.sin(mid) * lr,
            text,
            color: luminance(color) > 0.45 ? "#404040" : "#FFFFFF",
          });
        }
      }
      angle += sweep;
    });
    for (const l of labels) {
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, l.y);
    }
  });
}
