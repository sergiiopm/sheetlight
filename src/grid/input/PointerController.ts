import type { CellAddress, CellRange } from "@/engine/types";
import { MAX_COLS, MAX_ROWS } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import type { ReferencePicker } from "../api";
import type { Viewport } from "../core/Viewport";
import { sameRange } from "../core/util";
import { colAtX, devX, devY, paneForCell, rowAtY } from "../geometry/layout";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import { filterButtonRect } from "../render/BaseRenderer";
import type { GridInteractions } from "./GridInteractions";
import { hitTest } from "./hitTest";
import type { HitTarget } from "./hitTest";

type Drag =
  | { readonly kind: "none" }
  | { readonly kind: "cells" }
  | { readonly kind: "rows" }
  | { readonly kind: "cols" }
  | { readonly kind: "resizeCol"; readonly index: number; readonly startPos: number; readonly startSize: number; readonly wasHidden: boolean }
  | { readonly kind: "resizeRow"; readonly index: number; readonly startPos: number; readonly startSize: number; readonly wasHidden: boolean }
  | { readonly kind: "fill"; readonly source: CellRange; target: CellRange }
  | { readonly kind: "pick"; readonly picker: ReferencePicker; readonly axis: "cells" | "rows" | "cols"; readonly anchor: CellAddress; range: CellRange };

/** What the pointer layer needs from the grid. */
export interface PointerHost {
  readonly geom: SheetGeometry;
  readonly viewport: Viewport;
  readonly actions: GridInteractions;
  readonly readOnly: boolean;
  selection(): SelectionState;
  picker(): ReferencePicker | null;
  cursorMode(): "default" | "formatPainter";
  setResizeGuide(guide: { axis: "col" | "row"; index: number } | null): void;
  setFillPreview(range: CellRange | null): void;
  setPick(range: CellRange | null): void;
  /** Live (uncommitted) resize while dragging. */
  resizeAxis(axis: "row" | "col", index: number, size: number): void;
  unhideLocally(axis: "row" | "col", index: number): void;
  filterButton(col: number, anchor: DOMRect): void;
  requestFrame(): void;
}

const CURSORS: Record<HitTarget["type"], string> = {
  corner: "default",
  colHeader: "s-resize",
  rowHeader: "e-resize",
  colBorder: "col-resize",
  rowBorder: "row-resize",
  cell: "cell",
  none: "default",
};

/** Paintbrush + cross cursor for the format painter. */
const FORMAT_PAINTER_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Cpath d='M8 1v14M1 8h14' stroke='%23fff' stroke-width='4'/%3E%3Cpath d='M8 1v14M1 8h14' stroke='%23000' stroke-width='2'/%3E%3Crect x='14' y='12' width='8' height='5' rx='1' fill='%23fff' stroke='%23000'/%3E%3Cpath d='M17 17v5' stroke='%23000' stroke-width='2'/%3E%3C/svg%3E\") 8 8, cell";

/** CSS px tolerance around the fill handle. */
const FILL_GRAB = 5;

/**
 * Mouse / pen interaction: click & drag selection, Shift-extend, Ctrl
 * multi-range, header selection, header-border resize and autofit, fill
 * handle drag, autofilter buttons, reference picking for the formula editor,
 * auto-scroll while dragging outside the scrolling pane.
 */
export class PointerController {
  private drag: Drag = { kind: "none" };
  private px = 0;
  private py = 0;
  private lastAutoT = 0;
  private cursor = "";

  constructor(private readonly host: PointerHost) {}

  attach(el: HTMLElement): () => void {
    const down = (e: PointerEvent) => this.onDown(e, el);
    const move = (e: PointerEvent) => this.onMove(e, el);
    const up = (e: PointerEvent) => this.onUp(e, el);
    const dbl = (e: MouseEvent) => this.onDoubleClick(e, el);
    const ctx = (e: MouseEvent) => this.onContextMenu(e, el);
    el.addEventListener("pointerdown", down);
    el.addEventListener("dblclick", dbl);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", ctx);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("dblclick", dbl);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("contextmenu", ctx);
    };
  }

  get dragging(): boolean {
    return this.drag.kind !== "none";
  }

  private local(e: MouseEvent, el: HTMLElement): { x: number; y: number } {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private setCursor(el: HTMLElement, c: string): void {
    if (c !== this.cursor) {
      el.style.cursor = c;
      this.cursor = c;
    }
  }

  /** Refresh the cursor after a mode change (format painter). */
  resetCursor(el: HTMLElement): void {
    this.cursor = "";
    this.setCursor(el, this.host.cursorMode() === "formatPainter" ? FORMAT_PAINTER_CURSOR : "cell");
  }

  /** The single active range when the fill handle is available. */
  private fillSource(): CellRange | null {
    if (this.host.readOnly || this.host.picker()) return null;
    const s = this.host.selection();
    if (s.ranges.length !== 1 || s.kind !== "cells") return null;
    return s.ranges[0];
  }

  /** Is (x, y) on the fill handle (bottom-right corner of the single selected range)? */
  private onFillHandle(x: number, y: number): CellRange | null {
    const src = this.fillSource();
    if (!src) return null;
    const { geom, viewport } = this.host;
    const L = viewport.layout();
    const p = paneForCell(L, geom, src.r1, src.c1);
    const hx = devX(L, p, geom.cols.endOf(src.c1)) / L.dpr;
    const hy = devY(L, p, geom.rows.endOf(src.r1)) / L.dpr;
    if (hx < p.x - 1 || hx > p.x + p.w + 1 || hy < p.y - 1 || hy > p.y + p.h + 1) return null;
    return Math.abs(x - hx) <= FILL_GRAB && Math.abs(y - hy) <= FILL_GRAB ? src : null;
  }

  /** Autofilter dropdown button under (x, y): its column and client rect. */
  private onFilterButton(x: number, y: number, el: HTMLElement): { col: number; rect: DOMRect } | null {
    const { geom, viewport } = this.host;
    const af = geom.autoFilter;
    if (!af || x < 0 || y < 0) return null;
    const L = viewport.layout();
    if (x < L.headerW || y < L.headerH) return null;
    const row = rowAtY(geom, L, y);
    const col = colAtX(geom, L, x);
    if (row !== af.range.r0 || col < af.range.c0 || col > af.range.c1) return null;
    const p = paneForCell(L, geom, row, col);
    const dpr = L.dpr;
    const lw = Math.max(1, Math.round(dpr * 0.75));
    const b = filterButtonRect(
      devX(L, p, geom.cols.offsetOf(col)),
      devY(L, p, geom.rows.offsetOf(row)),
      devX(L, p, geom.cols.endOf(col)),
      devY(L, p, geom.rows.endOf(row)),
      lw,
      dpr * L.zoom,
    );
    if (b.size <= 2) return null;
    const bx = b.x / dpr;
    const by = b.y / dpr;
    const bs = b.size / dpr;
    if (x < bx || x > bx + bs || y < by || y > by + bs) return null;
    const r = el.getBoundingClientRect();
    return { col, rect: new DOMRect(r.left + bx, r.top + by, bs, bs) };
  }

  private onDown(e: PointerEvent, el: HTMLElement): void {
    if (e.button !== 0) return;
    const { x, y } = this.local(e, el);
    // Ignore presses on the native scrollbars.
    if (x >= el.clientWidth || y >= el.clientHeight) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    const { geom, viewport, actions } = this.host;
    const L = viewport.layout();
    this.px = x;
    this.py = y;

    const fb = this.onFilterButton(x, y, el);
    if (fb) {
      this.host.filterButton(fb.col, fb.rect);
      return;
    }
    const fillSrc = this.onFillHandle(x, y);
    if (fillSrc) {
      this.drag = { kind: "fill", source: fillSrc, target: fillSrc };
      this.host.setFillPreview(fillSrc);
      el.setPointerCapture(e.pointerId);
      return;
    }

    const hit = hitTest(geom, L, x, y);
    const picker = this.host.picker();
    if (picker && (hit.type === "cell" || hit.type === "colHeader" || hit.type === "rowHeader")) {
      const anchor: CellAddress = hit.type === "cell" ? { row: hit.row, col: hit.col } : hit.type === "colHeader" ? { row: 0, col: hit.col } : { row: hit.row, col: 0 };
      const axis = hit.type === "cell" ? "cells" : hit.type === "colHeader" ? "cols" : "rows";
      const range = this.pickRange(axis, anchor, anchor);
      this.drag = { kind: "pick", picker, axis, anchor, range };
      this.host.setPick(range);
      picker.onPick(range, false);
      el.setPointerCapture(e.pointerId);
      return;
    }

    const mode = e.shiftKey ? "extend" : e.ctrlKey || e.metaKey ? "add" : "replace";
    switch (hit.type) {
      case "none":
        return;
      case "corner":
        actions.selectAll();
        break;
      case "colBorder":
      case "rowBorder": {
        if (this.host.readOnly) return;
        const axis = hit.type === "colBorder" ? "col" : "row";
        const index = hit.type === "colBorder" ? hit.col : hit.row;
        const model = axis === "col" ? geom.cols : geom.rows;
        const wasHidden = model.isHidden(index);
        const startSize = wasHidden ? 0 : model.storedSizeOf(index);
        this.drag = axis === "col"
          ? { kind: "resizeCol", index, startPos: x, startSize, wasHidden }
          : { kind: "resizeRow", index, startPos: y, startSize, wasHidden };
        this.host.setResizeGuide({ axis, index });
        break;
      }
      case "colHeader":
        actions.clickColHeader(hit.col, mode, L.main.r0);
        this.drag = { kind: "cols" };
        break;
      case "rowHeader":
        actions.clickRowHeader(hit.row, mode, L.main.c0);
        this.drag = { kind: "rows" };
        break;
      case "cell":
        actions.clickCell({ row: hit.row, col: hit.col }, mode);
        this.drag = { kind: "cells" };
        break;
    }
    el.setPointerCapture(e.pointerId);
  }

  private pickRange(axis: "cells" | "rows" | "cols", a: CellAddress, b: CellAddress): CellRange {
    if (axis === "rows") return { r0: Math.min(a.row, b.row), r1: Math.max(a.row, b.row), c0: 0, c1: MAX_COLS - 1 };
    if (axis === "cols") return { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(a.col, b.col), c1: Math.max(a.col, b.col) };
    return this.host.geom.merges.expand({ r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) });
  }

  private onDoubleClick(e: MouseEvent, el: HTMLElement): void {
    const { x, y } = this.local(e, el);
    if (x >= el.clientWidth || y >= el.clientHeight) return;
    const { geom, viewport, actions } = this.host;
    const fill = this.onFillHandle(x, y);
    if (fill) {
      void actions.fillDownToAdjacent(fill);
      return;
    }
    const hit = hitTest(geom, viewport.layout(), x, y);
    if (hit.type === "colBorder") void actions.autofitColumns(hit.col);
    else if (hit.type === "rowBorder") actions.autofitRows(hit.row);
    else if (hit.type === "cell" && !this.host.picker() && !this.onFilterButton(x, y, el)) actions.requestEdit("dblclick");
  }

  private onContextMenu(e: MouseEvent, el: HTMLElement): void {
    e.preventDefault();
    const { x, y } = this.local(e, el);
    if (x >= el.clientWidth || y >= el.clientHeight) return;
    const hit = hitTest(this.host.geom, this.host.viewport.layout(), x, y);
    const L = this.host.viewport.layout();
    switch (hit.type) {
      case "cell":
        this.host.actions.contextMenuAt("cell", { row: hit.row, col: hit.col }, e.clientX, e.clientY);
        break;
      case "colHeader":
      case "colBorder":
        this.host.actions.contextMenuAt("colHeader", { row: L.main.r0, col: hit.col }, e.clientX, e.clientY);
        break;
      case "rowHeader":
      case "rowBorder":
        this.host.actions.contextMenuAt("rowHeader", { row: hit.row, col: L.main.c0 }, e.clientX, e.clientY);
        break;
      case "corner":
        this.host.actions.contextMenuAt("corner", { row: 0, col: 0 }, e.clientX, e.clientY);
        break;
      default:
        break;
    }
  }

  private onMove(e: PointerEvent, el: HTMLElement): void {
    const { x, y } = this.local(e, el);
    this.px = x;
    this.py = y;
    const { geom, viewport } = this.host;
    const d = this.drag;
    if (d.kind === "none") {
      if (e.buttons !== 0) return;
      const over = x < el.clientWidth && y < el.clientHeight;
      if (!over) {
        this.setCursor(el, "default");
        return;
      }
      if (this.onFillHandle(x, y)) {
        this.setCursor(el, "crosshair");
        return;
      }
      if (this.onFilterButton(x, y, el)) {
        this.setCursor(el, "default");
        return;
      }
      const type = hitTest(geom, viewport.layout(), x, y).type;
      if (this.host.readOnly && (type === "colBorder" || type === "rowBorder")) this.setCursor(el, "default");
      else if (type === "cell" && this.host.cursorMode() === "formatPainter") this.setCursor(el, FORMAT_PAINTER_CURSOR);
      else this.setCursor(el, CURSORS[type]);
      return;
    }
    if (d.kind === "resizeCol" || d.kind === "resizeRow") {
      const axis = d.kind === "resizeCol" ? "col" : "row";
      const delta = ((axis === "col" ? x : y) - d.startPos) / viewport.zoom;
      const size = Math.max(1, d.startSize + delta);
      if (d.wasHidden) this.host.unhideLocally(axis, d.index);
      this.host.resizeAxis(axis, d.index, size);
      return;
    }
    this.dragTo(x, y);
    // Keep frames coming while the pointer is outside (auto-scroll).
    this.host.requestFrame();
  }

  private onUp(e: PointerEvent, el: HTMLElement): void {
    const d = this.drag;
    this.drag = { kind: "none" };
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const { geom, actions } = this.host;
    if (d.kind === "resizeCol" || d.kind === "resizeRow") {
      const axis = d.kind === "resizeCol" ? "col" : "row";
      this.host.setResizeGuide(null);
      const model = axis === "col" ? geom.cols : geom.rows;
      const unchanged = !d.wasHidden && model.storedSizeOf(d.index) === d.startSize;
      if (!unchanged && !(d.wasHidden && model.isHidden(d.index))) actions.commitResize(axis, d.index, model.storedSizeOf(d.index), d.wasHidden);
    } else if (d.kind === "fill") {
      this.host.setFillPreview(null);
      actions.commitFill(d.source, d.target);
    } else if (d.kind === "pick") {
      this.host.setPick(null);
      d.picker.onPick(d.range, true);
    }
  }

  /** Extend the drag to the cell under (x, y), clamped into the grid. */
  private dragTo(x: number, y: number): void {
    const { geom, viewport, actions } = this.host;
    const L = viewport.layout();
    const cx = Math.min(Math.max(x, L.headerW), L.width - 1);
    const cy = Math.min(Math.max(y, L.headerH), L.height - 1);
    const cell = { row: rowAtY(geom, L, cy), col: colAtX(geom, L, cx) };
    const d = this.drag;
    switch (d.kind) {
      case "cells":
      case "rows":
      case "cols":
        actions.dragTo(cell, d.kind);
        break;
      case "fill": {
        const t = actions.fillTarget(d.source, cell);
        if (!sameRange(t, d.target)) {
          d.target = t;
          this.host.setFillPreview(t);
        }
        break;
      }
      case "pick": {
        const r = this.pickRange(d.axis, d.anchor, cell);
        if (!sameRange(r, d.range)) {
          d.range = r;
          this.host.setPick(r);
          d.picker.onPick(r, false);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Called every frame. While a drag is active and the pointer is outside
   * the scrolling pane, scroll with a speed that grows with the distance
   * (Excel-like), then re-extend the drag.
   */
  stepAutoScroll(now: number): boolean {
    const d = this.drag;
    if (d.kind === "none" || d.kind === "resizeCol" || d.kind === "resizeRow") {
      this.lastAutoT = 0;
      return false;
    }
    const axis = d.kind === "pick" ? d.axis : d.kind === "fill" ? "cells" : d.kind;
    const { viewport } = this.host;
    const L = viewport.layout();
    const m = L.main;
    const { x: sx, y: sy } = viewport.getScroll();
    let vx = 0;
    let vy = 0;
    if (axis !== "rows") {
      if (this.px > L.width) vx = speed(this.px - L.width);
      else if (this.px < m.x && sx > 0) vx = -speed(m.x - this.px);
    }
    if (axis !== "cols") {
      if (this.py > L.height) vy = speed(this.py - L.height);
      else if (this.py < m.y && sy > 0) vy = -speed(m.y - this.py);
    }
    if (vx === 0 && vy === 0) {
      this.lastAutoT = 0;
      return false;
    }
    const dt = this.lastAutoT === 0 ? 16 : Math.min(50, now - this.lastAutoT);
    this.lastAutoT = now;
    viewport.setScroll(sx + (vx * dt) / 1000 / viewport.zoom, sy + (vy * dt) / 1000 / viewport.zoom);
    this.dragTo(this.px, this.py);
    return true;
  }
}

/** Auto-scroll speed in screen px/s for a pointer `dist` px outside the pane. */
function speed(dist: number): number {
  return 150 + 3 * Math.pow(dist, 1.45);
}

