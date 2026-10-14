import type { CellAddress, CellRange } from "@/engine/types";
import { colAtX, computeLayout, paneForCell, rowAtY, scrollExtent } from "../geometry/layout";
import type { GridLayout, ScrollExtent } from "../geometry/layout";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import type { NativeScrollbars } from "../input/NativeScrollbars";
import type { ScrollTarget } from "../input/SmoothScroller";
import type { StyleResolver } from "../render/StyleResolver";
import type { TextMeasurer } from "../render/TextMeasurer";
import type { GridTheme } from "../render/theme";
import { clamp } from "./util";

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2;

/** Rectangle in CSS px relative to the grid root (canvas coordinates). */
export interface CssRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type ViewportChange = "scroll" | "layout";

/**
 * Scroll position, zoom and layout of the grid. The grid's own scroll
 * position (sheet units, relative to the first unfrozen row/col) is the
 * source of truth; the native scrollbars are a view of it.
 *
 * Scroll extent follows Excel: the scrollbar range covers the used range
 * plus one screen and grows as you scroll or navigate past it (wheel and
 * keyboard can always reach the whole sheet). The range never shrinks while
 * the user drags the scrollbar thumb.
 */
export class Viewport implements ScrollTarget {
  private scrollX = 0;
  private scrollY = 0;
  /** Last scroll delta (prefetch direction). */
  lastDx = 0;
  lastDy = 0;
  private zoomValue = 1;
  private dpr = 1;
  private headerW = 40;
  private layoutCache: GridLayout | null = null;
  private layoutScrollX = NaN;
  private layoutScrollY = NaN;
  private layoutGeomVersion = -1;
  private extentCache: ScrollExtent | null = null;
  private readonly extentKey = [NaN, NaN, NaN, NaN, NaN];
  /** Excel-style scrollbar extent (sheet units), grown by scrolling. */
  private grownX = 0;
  private grownY = 0;
  private usedEnd: CellAddress = { row: 0, col: 0 };

  constructor(
    private readonly geom: SheetGeometry,
    private readonly scrollbars: NativeScrollbars,
    private readonly measurer: TextMeasurer,
    private readonly styles: StyleResolver,
    private theme: GridTheme,
    private readonly onChange: (what: ViewportChange) => void,
  ) {}

  setTheme(theme: GridTheme): void {
    this.theme = theme;
    this.invalidateLayout();
  }

  /** Bottom-right of the data (used range); drives the scrollbar extent. */
  setUsedEnd(end: CellAddress): void {
    this.usedEnd = end;
  }

  get zoom(): number {
    return this.zoomValue;
  }

  get lineHeight(): number {
    return this.geom.rows.defaultSize * 3;
  }

  get pageHeight(): number {
    return this.extent().viewH * this.zoomValue;
  }

  invalidateLayout(): void {
    this.layoutCache = null;
    this.extentCache = null;
  }

  private headerHeight(): number {
    return this.theme.headerHeight * this.zoomValue;
  }

  private computeHeaderWidth(height: number): number {
    const { rows } = this.geom;
    const bottomRow = rows.indexAt(rows.offsetOf(this.geom.frozenRows) + this.scrollY + height / this.zoomValue);
    const digits = Math.max(3, String(bottomRow + 1).length);
    const font = `${this.theme.headerFontSizePx * this.zoomValue}px ${this.theme.headerFont}`;
    const digitW = this.measurer.measure(font, "0");
    return Math.ceil(digits * digitW + 12 * this.zoomValue);
  }

  /** Current layout (recomputed lazily when scroll / size / zoom / geometry change). */
  layout(): GridLayout {
    const w = this.scrollbars.clientWidth;
    const h = this.scrollbars.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const L = this.layoutCache;
    if (
      L &&
      L.width === w &&
      L.height === h &&
      L.dpr === dpr &&
      L.zoom === this.zoomValue &&
      this.layoutScrollX === this.scrollX &&
      this.layoutScrollY === this.scrollY &&
      this.layoutGeomVersion === this.geom.version
    ) {
      return L;
    }
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.measurer.clear();
    }
    this.styles.setScale(dpr * this.zoomValue);
    this.headerW = this.computeHeaderWidth(h);
    this.layoutGeomVersion = this.geom.version;
    this.extentCache = null;
    const ext = this.extent();
    // Geometry or viewport changes can shrink the scroll range.
    this.scrollX = clamp(this.scrollX, 0, ext.maxX);
    this.scrollY = clamp(this.scrollY, 0, ext.maxY);
    this.layoutScrollX = this.scrollX;
    this.layoutScrollY = this.scrollY;
    this.layoutCache = computeLayout(this.geom, w, h, dpr, this.zoomValue, this.scrollX, this.scrollY, this.headerW, this.headerHeight());
    return this.layoutCache;
  }

  /** Full scroll range of the sheet (wheel / keyboard / programmatic). */
  extent(): ScrollExtent {
    const w = this.scrollbars.clientWidth;
    const h = this.scrollbars.clientHeight;
    const k = this.extentKey;
    const gv = this.geom.version;
    if (this.extentCache && k[0] === w && k[1] === h && k[2] === this.zoomValue && k[3] === this.headerW && k[4] === gv) return this.extentCache;
    k[0] = w;
    k[1] = h;
    k[2] = this.zoomValue;
    k[3] = this.headerW;
    k[4] = gv;
    this.extentCache = scrollExtent(this.geom, w, h, this.zoomValue, this.headerW, this.headerHeight());
    return this.extentCache;
  }

  /** Excel-style scrollbar extent (sheet units): used range + one screen, grown by scrolling. */
  private scrollbarExtent(): { maxX: number; maxY: number } {
    const ext = this.extent();
    const { rows, cols, frozenRows, frozenCols } = this.geom;
    const usedY = rows.offsetOf(Math.min(rows.count, Math.max(this.usedEnd.row, frozenRows) + 1)) - rows.offsetOf(frozenRows);
    const usedX = cols.offsetOf(Math.min(cols.count, Math.max(this.usedEnd.col, frozenCols) + 1)) - cols.offsetOf(frozenCols);
    this.grownY = Math.max(this.grownY, this.scrollY);
    this.grownX = Math.max(this.grownX, this.scrollX);
    return {
      maxX: Math.min(ext.maxX, Math.max(usedX, this.grownX)),
      maxY: Math.min(ext.maxY, Math.max(usedY, this.grownY)),
    };
  }

  /** Push range + position to the native scrollbars (once per frame). */
  syncScrollbars(): void {
    const se = this.scrollbarExtent();
    const z = this.zoomValue;
    this.scrollbars.setRange(se.maxX * z, se.maxY * z);
    this.scrollbars.sync(this.scrollX * z, this.scrollY * z);
  }

  // -------------------------------------------------------------- scroll

  getScroll(): { x: number; y: number } {
    return { x: this.scrollX, y: this.scrollY };
  }

  clampScroll(x: number, y: number): { x: number; y: number } {
    const ext = this.extent();
    return { x: clamp(x, 0, ext.maxX), y: clamp(y, 0, ext.maxY) };
  }

  /** Set the scroll (sheet units). `fromScrollbar` keeps the grown extent (thumb drag). */
  setScroll(x: number, y: number, fromScrollbar = false): { x: number; y: number } {
    const c = this.clampScroll(x, y);
    if (c.x !== this.scrollX || c.y !== this.scrollY) {
      this.lastDx = c.x - this.scrollX;
      this.lastDy = c.y - this.scrollY;
      this.scrollX = c.x;
      this.scrollY = c.y;
      if (!fromScrollbar) {
        // Scrolling back towards the data shrinks the extent again (Excel).
        if (this.grownY > c.y) this.grownY = c.y;
        if (this.grownX > c.x) this.grownX = c.x;
      }
      this.onChange("scroll");
    }
    return c;
  }

  /** Read a user scrollbar movement; true if the scroll changed. */
  readNative(): boolean {
    const r = this.scrollbars.read();
    if (!r) return false;
    const z = this.zoomValue;
    this.setScroll(r.movedX ? r.vx / z : this.scrollX, r.movedY ? r.vy / z : this.scrollY, true);
    return true;
  }

  /** Scroll the minimum amount so that the cell (or its merge) is fully visible. */
  ensureVisible(cell: CellAddress): void {
    const { rows, cols, frozenRows, frozenCols } = this.geom;
    const m = this.geom.merges.at(cell.row, cell.col);
    const ext = this.extent();
    let { x, y } = this.getScroll();
    if (cell.row >= frozenRows) {
      const base = rows.offsetOf(frozenRows);
      const top = rows.offsetOf(m ? Math.max(m.r0, frozenRows) : cell.row) - base;
      const bottom = rows.endOf(m ? m.r1 : cell.row) - base;
      if (top < y) y = top;
      else if (bottom > y + ext.viewH) y = Math.min(top, bottom - ext.viewH);
    }
    if (cell.col >= frozenCols) {
      const base = cols.offsetOf(frozenCols);
      const left = cols.offsetOf(m ? Math.max(m.c0, frozenCols) : cell.col) - base;
      const right = cols.endOf(m ? m.c1 : cell.col) - base;
      if (left < x) x = left;
      else if (right > x + ext.viewW) x = Math.min(left, right - ext.viewW);
    }
    this.setScroll(x, y);
  }

  /** Scroll so that `cell` is the top-left cell of the scrolling pane. */
  scrollToTopLeft(cell: CellAddress): void {
    const { rows, cols, frozenRows, frozenCols } = this.geom;
    const x = cell.col >= frozenCols ? cols.offsetOf(cell.col) - cols.offsetOf(frozenCols) : 0;
    const y = cell.row >= frozenRows ? rows.offsetOf(cell.row) - rows.offsetOf(frozenRows) : 0;
    this.setScroll(x, y);
  }

  /** Top-left visible cell of the scrolling pane. */
  topLeft(): CellAddress {
    const L = this.layout();
    return { row: L.main.r0, col: L.main.c0 };
  }

  // ---------------------------------------------------------------- zoom

  setZoom(z: number): boolean {
    const nz = clamp(Math.round(z * 100) / 100, MIN_ZOOM, MAX_ZOOM);
    if (nz === this.zoomValue) return false;
    this.zoomValue = nz;
    this.invalidateLayout();
    this.onChange("layout");
    return true;
  }

  // --------------------------------------------------------------- rects

  /** CSS rect (canvas coords) of a range as positioned by the pane of its top-left cell; unclipped. */
  rangeRect(range: CellRange): CssRect {
    const L = this.layout();
    const { rows, cols } = this.geom;
    const p = paneForCell(L, this.geom, range.r0, range.c0);
    const x = p.x + (cols.offsetOf(range.c0) - p.originX) * L.zoom;
    const y = p.y + (rows.offsetOf(range.r0) - p.originY) * L.zoom;
    const w = (cols.endOf(range.c1) - cols.offsetOf(range.c0)) * L.zoom;
    const h = (rows.endOf(range.r1) - rows.offsetOf(range.r0)) * L.zoom;
    return { x, y, w, h };
  }

  /** CSS rect of a cell (its merge if merged), or null if not visible in its pane. */
  cellRect(cell: CellAddress): CssRect | null {
    const m = this.geom.merges.at(cell.row, cell.col);
    const range = m ?? { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
    const L = this.layout();
    const p = paneForCell(L, this.geom, range.r0, range.c0);
    const r = this.rangeRect(range);
    if (r.w <= 0 || r.h <= 0) return null;
    if (r.x + r.w <= p.x || r.x >= p.x + p.w || r.y + r.h <= p.y || r.y >= p.y + p.h) return null;
    return r;
  }

  /** Cell under a canvas point (CSS px). */
  cellAt(x: number, y: number): CellAddress {
    const L = this.layout();
    return { row: rowAtY(this.geom, L, y), col: colAtX(this.geom, L, x) };
  }
}
