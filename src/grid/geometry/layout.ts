import type { SheetGeometry } from "./SheetGeometry";

export type PaneKind = "corner" | "top" | "left" | "main";

/**
 * A rectangular region of the canvas showing a scrolled window of the sheet.
 * With frozen rows/cols there are up to four panes; `main` always exists.
 */
export interface Pane {
  readonly kind: PaneKind;
  /** Rect in CSS px, relative to the canvas. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Sheet-unit offsets shown at the pane's left / top edge (includes scroll). */
  readonly originX: number;
  readonly originY: number;
  /** Sheet-unit offsets at the pane edge when unscrolled. */
  readonly baseX: number;
  readonly baseY: number;
  /**
   * Scroll of this pane in whole device pixels. Device positions are
   * computed as round(unscrolled position) - scrollDev, so a scroll by N
   * device px shifts every edge by exactly N px (enables pixel-exact blits).
   */
  readonly scrollDevX: number;
  readonly scrollDevY: number;
  /** Visible index ranges (inclusive). r1 < r0 means no rows. */
  readonly r0: number;
  readonly r1: number;
  readonly c0: number;
  readonly c1: number;
  readonly scrollsX: boolean;
  readonly scrollsY: boolean;
}

export interface GridLayout {
  /** Canvas size in CSS px. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly zoom: number;
  readonly headerW: number;
  readonly headerH: number;
  /** Size of the frozen area in CSS px (0 if none). */
  readonly frozenW: number;
  readonly frozenH: number;
  /** Scroll position in sheet units (snapped to device pixels), relative to the first unfrozen row/col. */
  readonly scrollX: number;
  readonly scrollY: number;
  readonly panes: ReadonlyArray<Pane>;
  readonly main: Pane;
}

export interface ScrollExtent {
  /** Max scroll in sheet units. */
  readonly maxX: number;
  readonly maxY: number;
  /** Size of the scrolling (main) viewport in sheet units. */
  readonly viewW: number;
  readonly viewH: number;
}

export function frozenSize(geom: SheetGeometry, zoom: number): { w: number; h: number } {
  return {
    w: geom.cols.offsetOf(geom.frozenCols) * zoom,
    h: geom.rows.offsetOf(geom.frozenRows) * zoom,
  };
}

export function scrollExtent(
  geom: SheetGeometry,
  width: number,
  height: number,
  zoom: number,
  headerW: number,
  headerH: number,
): ScrollExtent {
  const fz = frozenSize(geom, zoom);
  const viewW = Math.max(0, (width - headerW - fz.w) / zoom);
  const viewH = Math.max(0, (height - headerH - fz.h) / zoom);
  const contentW = geom.cols.total() - geom.cols.offsetOf(geom.frozenCols);
  const contentH = geom.rows.total() - geom.rows.offsetOf(geom.frozenRows);
  return { maxX: Math.max(0, contentW - viewW), maxY: Math.max(0, contentH - viewH), viewW, viewH };
}

function pane(
  geom: SheetGeometry,
  kind: PaneKind,
  x: number,
  y: number,
  w: number,
  h: number,
  baseX: number,
  baseY: number,
  scrollDevX: number,
  scrollDevY: number,
  zoom: number,
  dpr: number,
  maxRow: number,
  maxCol: number,
): Pane {
  const originX = baseX + scrollDevX / (zoom * dpr);
  const originY = baseY + scrollDevY / (zoom * dpr);
  const empty = w <= 0 || h <= 0;
  const r0 = geom.rows.indexAt(originY);
  const c0 = geom.cols.indexAt(originX);
  let r1 = empty ? r0 - 1 : geom.rows.indexAt(originY + h / zoom - 1e-6);
  let c1 = empty ? c0 - 1 : geom.cols.indexAt(originX + w / zoom - 1e-6);
  if (maxRow >= 0) r1 = Math.min(r1, maxRow);
  if (maxCol >= 0) c1 = Math.min(c1, maxCol);
  return {
    kind, x, y, w, h, originX, originY, baseX, baseY, scrollDevX, scrollDevY, r0, r1, c0, c1,
    scrollsX: kind === "top" || kind === "main",
    scrollsY: kind === "left" || kind === "main",
  };
}

export function computeLayout(
  geom: SheetGeometry,
  width: number,
  height: number,
  dpr: number,
  zoom: number,
  scrollX: number,
  scrollY: number,
  headerW: number,
  headerH: number,
): GridLayout {
  const fz = frozenSize(geom, zoom);
  const fw = Math.min(fz.w, Math.max(0, width - headerW));
  const fh = Math.min(fz.h, Math.max(0, height - headerH));
  const mainX = headerW + fw;
  const mainY = headerH + fh;
  const mainW = Math.max(0, width - mainX);
  const mainH = Math.max(0, height - mainY);
  const bx = geom.cols.offsetOf(geom.frozenCols);
  const by = geom.rows.offsetOf(geom.frozenRows);
  const s = zoom * dpr;
  const sdx = Math.round(scrollX * s);
  const sdy = Math.round(scrollY * s);
  const fr = geom.frozenRows - 1;
  const fc = geom.frozenCols - 1;
  const panes: Pane[] = [];
  if (fw > 0 && fh > 0) panes.push(pane(geom, "corner", headerW, headerH, fw, fh, 0, 0, 0, 0, zoom, dpr, fr, fc));
  if (fh > 0) panes.push(pane(geom, "top", mainX, headerH, mainW, fh, bx, 0, sdx, 0, zoom, dpr, fr, -1));
  if (fw > 0) panes.push(pane(geom, "left", headerW, mainY, fw, mainH, 0, by, 0, sdy, zoom, dpr, -1, fc));
  const main = pane(geom, "main", mainX, mainY, mainW, mainH, bx, by, sdx, sdy, zoom, dpr, -1, -1);
  panes.push(main);
  return { width, height, dpr, zoom, headerW, headerH, frozenW: fw, frozenH: fh, scrollX: sdx / s, scrollY: sdy / s, panes, main };
}

/** Pane under a canvas point (CSS px), or null when over headers. */
export function paneAt(layout: GridLayout, x: number, y: number): Pane | null {
  if (x < layout.headerW || y < layout.headerH) return null;
  const inFrozenX = x < layout.headerW + layout.frozenW;
  const inFrozenY = y < layout.headerH + layout.frozenH;
  const kind: PaneKind = inFrozenX ? (inFrozenY ? "corner" : "left") : inFrozenY ? "top" : "main";
  return layout.panes.find((p) => p.kind === kind) ?? layout.main;
}

/** Column under canvas x (CSS px); x left of the cells clamps into the sheet. */
export function colAtX(geom: SheetGeometry, layout: GridLayout, x: number): number {
  const fx = x - layout.headerW;
  if (fx < layout.frozenW) return geom.cols.indexAt(Math.max(0, fx) / layout.zoom);
  return geom.cols.indexAt(layout.main.originX + (x - layout.main.x) / layout.zoom);
}

export function rowAtY(geom: SheetGeometry, layout: GridLayout, y: number): number {
  const fy = y - layout.headerH;
  if (fy < layout.frozenH) return geom.rows.indexAt(Math.max(0, fy) / layout.zoom);
  return geom.rows.indexAt(layout.main.originY + (y - layout.main.y) / layout.zoom);
}

/** Canvas x (CSS px) of the left edge of column `col` as seen in the pane that shows it. */
export function colScreenX(geom: SheetGeometry, layout: GridLayout, col: number): number {
  if (col < geom.frozenCols) return layout.headerW + geom.cols.offsetOf(col) * layout.zoom;
  return layout.main.x + (geom.cols.offsetOf(col) - layout.main.originX) * layout.zoom;
}

export function rowScreenY(geom: SheetGeometry, layout: GridLayout, row: number): number {
  if (row < geom.frozenRows) return layout.headerH + geom.rows.offsetOf(row) * layout.zoom;
  return layout.main.y + (geom.rows.offsetOf(row) - layout.main.originY) * layout.zoom;
}

/** Device-pixel x of sheet offset `off` (sheet units) in pane p. Exact under scroll. */
export function devX(L: GridLayout, p: Pane, off: number): number {
  return Math.round((p.x + (off - p.baseX) * L.zoom) * L.dpr) - p.scrollDevX;
}

export function devY(L: GridLayout, p: Pane, off: number): number {
  return Math.round((p.y + (off - p.baseY) * L.zoom) * L.dpr) - p.scrollDevY;
}

/** Rectangle in device pixels, half-open [x0, x1) x [y0, y1). */
export interface DeviceRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export function paneDeviceRect(L: GridLayout, p: Pane): DeviceRect {
  return {
    x0: Math.round(p.x * L.dpr),
    y0: Math.round(p.y * L.dpr),
    x1: Math.round((p.x + p.w) * L.dpr),
    y1: Math.round((p.y + p.h) * L.dpr),
  };
}

/** True if `b` can be drawn by shifting `a` (only scroll offsets differ). */
export function blitCompatible(a: GridLayout, b: GridLayout): boolean {
  if (
    a.width !== b.width || a.height !== b.height || a.dpr !== b.dpr || a.zoom !== b.zoom ||
    a.headerW !== b.headerW || a.headerH !== b.headerH || a.frozenW !== b.frozenW || a.frozenH !== b.frozenH ||
    a.panes.length !== b.panes.length
  ) {
    return false;
  }
  for (let i = 0; i < a.panes.length; i++) if (a.panes[i].kind !== b.panes[i].kind) return false;
  return true;
}

/** Minimum distance (sheet units) scanned beyond a pane edge for text overflowing into view. */
export const OVERFLOW_SCAN_MIN = 1500;
/** Hard cap on scanned columns beyond each pane edge. */
export const OVERFLOW_SCAN_MAX_COLS = 256;

/**
 * Columns drawn/fetched for pane `p`: the visible ones plus enough columns on
 * each side that text overflowing into view from off-screen cells is drawn.
 * Adaptive: at least max(1500 px, half a pane width) of sheet distance, capped
 * at 256 columns, bounded by the pane's column domain (frozen / scrolling).
 */
export function overflowColumns(geom: SheetGeometry, p: Pane, zoom: number): { ce0: number; ce1: number } {
  const { cols } = geom;
  const colMin = p.scrollsX ? geom.frozenCols : 0;
  const colMax = p.scrollsX ? cols.count - 1 : geom.frozenCols - 1;
  const dist = Math.max(OVERFLOW_SCAN_MIN, p.w / zoom / 2);
  let ce0 = p.c0 > colMin ? cols.indexAt(cols.offsetOf(p.c0) - dist) : p.c0;
  let ce1 = p.c1 < colMax ? cols.indexAt(cols.endOf(p.c1) + dist) : p.c1;
  ce0 = Math.max(colMin, p.c0 - OVERFLOW_SCAN_MAX_COLS, Math.min(ce0, p.c0));
  ce1 = Math.min(colMax, p.c1 + OVERFLOW_SCAN_MAX_COLS, Math.max(ce1, p.c1));
  return { ce0, ce1 };
}

/** Row / column index domain of a pane (frozen panes only show the frozen part). */
export function paneDomain(geom: SheetGeometry, p: Pane): { rMin: number; rMax: number; cMin: number; cMax: number } {
  return {
    rMin: p.scrollsY ? geom.frozenRows : 0,
    rMax: p.scrollsY ? geom.rows.count - 1 : geom.frozenRows - 1,
    cMin: p.scrollsX ? geom.frozenCols : 0,
    cMax: p.scrollsX ? geom.cols.count - 1 : geom.frozenCols - 1,
  };
}

/**
 * Calls `fn(br)` for every 64-row block band that contains at least one
 * visible row in [r0, r1], skipping hidden runs in O(log k) per band.
 */
export function forEachVisibleBand(geom: SheetGeometry, r0: number, r1: number, blockRows: number, fn: (br: number) => void): void {
  let r = geom.rows.nextVisible(Math.max(0, r0), 1);
  while (r >= 0 && r <= r1) {
    const br = Math.floor(r / blockRows);
    fn(br);
    const next = (br + 1) * blockRows;
    if (next >= geom.rows.count) break;
    r = geom.rows.nextVisible(next, 1);
  }
}

/** The pane that shows a cell (by frozen region). */
export function paneForCell(L: GridLayout, geom: SheetGeometry, row: number, col: number): Pane {
  const top = row < geom.frozenRows;
  const left = col < geom.frozenCols;
  const kind: PaneKind = top ? (left ? "corner" : "top") : left ? "left" : "main";
  return L.panes.find((p) => p.kind === kind) ?? L.main;
}
