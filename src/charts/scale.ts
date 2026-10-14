/**
 * Value axis scaling (Excel-like "auto" min/max/major unit) and Spanish
 * number formatting of tick labels.
 */

export interface AxisScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: ReadonlyArray<number>;
  /** Decimals needed to print every tick exactly. */
  readonly decimals: number;
}

const NICE_STEPS = [1, 2, 5, 10];

function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = step.toPrecision(10).replace(/0+$/, "").replace(/\.$/, "");
  if (text.includes("e")) {
    const exp = Number(text.split("e")[1]);
    return exp < 0 ? -exp : 0;
  }
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

function niceStep(rough: number): number {
  const exp = Math.floor(Math.log10(rough));
  const base = 10 ** exp;
  for (const m of NICE_STEPS) {
    const step = m * base;
    if (step >= rough * (1 - 1e-9)) return step;
  }
  return 10 * base;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** Math.min(decimals, 15);
  return Math.round(v * f) / f;
}

/**
 * Picks min, max and major unit like Excel's automatic axis:
 * - zero is included unless all values sit in a narrow band far from it
 *   (range < 1/6 of the largest magnitude);
 * - 5% headroom, then rounded out to the major unit;
 * - major unit from 1/2/5 × 10^n so that there are at most `maxTicks` intervals
 *   (at least two when the data crosses zero, which must be a tick).
 */
export function niceScale(dataMin: number, dataMax: number, maxTicks: number): AxisScale {
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  // Mixed signs need zero as a tick, hence at least two intervals.
  const intervals = Math.max(lo < 0 && hi > 0 ? 2 : 1, Math.floor(maxTicks));
  const degenerate = lo === hi;
  if (lo === hi) {
    if (lo === 0) {
      hi = 1;
    } else if (lo > 0) {
      lo = 0;
    } else {
      hi = 0;
    }
  }
  const magnitude = Math.max(Math.abs(lo), Math.abs(hi));
  const sameSign = lo >= 0 || hi <= 0;
  const zeroBased = !sameSign || (hi - lo) / magnitude >= 1 / 6;
  if (zeroBased) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  // A constant series gets an exact 0..value axis (Excel: all zeros -> 0..1).
  const pad = degenerate ? 0 : (hi - lo) * 0.05;
  let step = niceStep((hi - lo) / intervals);
  for (let guard = 0; ; guard += 1) {
    // Headroom only on sides that are not pinned at zero.
    let min = lo === 0 ? 0 : Math.floor((lo - pad) / step) * step;
    let max = hi === 0 ? 0 : Math.ceil((hi + pad) / step) * step;
    if (!zeroBased && lo > 0) min = Math.max(0, min);
    if (!zeroBased && hi < 0) max = Math.min(0, max);
    const count = Math.round((max - min) / step);
    if (count <= intervals || guard >= 8) {
      const decimals = decimalsOf(step);
      const ticks: number[] = [];
      for (let i = 0; i <= count; i += 1) ticks.push(roundTo(min + i * step, decimals + 2));
      return { min: roundTo(min, decimals + 2), max: roundTo(max, decimals + 2), step, ticks, decimals };
    }
    step = niceStep(step * 1.01);
  }
}

/** Fixed 0..100% scale for 100% stacked charts. */
export function percentScale(maxTicks: number): AxisScale {
  const step = maxTicks >= 10 ? 0.1 : maxTicks >= 5 ? 0.2 : maxTicks >= 4 ? 0.25 : 0.5;
  const ticks: number[] = [];
  for (let v = 0; v <= 1 + 1e-9; v += step) ticks.push(roundTo(v, 4));
  return { min: 0, max: 1, step, ticks, decimals: decimalsOf(step * 100) };
}

const formatters = new Map<number, Intl.NumberFormat>();

function formatter(decimals: number): Intl.NumberFormat {
  let f = formatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    formatters.set(decimals, f);
  }
  return f;
}

/** Spanish number: `1.234,5` (es-ES groups from 5 digits: `1234`, `12.345`). */
export function formatNumber(value: number, decimals: number): string {
  const d = Math.max(0, Math.min(10, decimals));
  const text = formatter(d).format(Object.is(value, -0) ? 0 : value);
  return text;
}

/** `25%` (Excel `0%` style in es-ES, no space). */
export function formatPercent(fraction: number, decimals = 0): string {
  return `${formatNumber(fraction * 100, decimals)}%`;
}

export function formatTick(value: number, scale: AxisScale, percent: boolean): string {
  return percent ? formatPercent(value, Math.max(0, scale.decimals)) : formatNumber(value, scale.decimals);
}
