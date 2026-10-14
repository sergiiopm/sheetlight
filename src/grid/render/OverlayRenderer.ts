import { colName, rangesIntersect, type CellRange } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import { devX, devY } from "../geometry/layout";
import type { GridLayout, Pane } from "../geometry/layout";
import type { GridTheme } from "./theme";

/** A ref highlight with its colors pre-resolved (no string work per frame). */
export interface ResolvedHighlight {
  readonly range: CellRange;
  readonly border: string;
  readonly fill: string;
}

export interface OverlayState {
  readonly selection: SelectionState | null;
  /** Column/row being resized (drawn as a guide line), if any. */
  readonly resize: { readonly axis: "col" | "row"; readonly index: number } | null;
  /** Target range while dragging the fill handle. */
  readonly fillPreview: CellRange | null;
  readonly highlights: ReadonlyArray<ResolvedHighlight>;
  /** Range being picked for the formula editor (reference picker). */
  readonly pick: CellRange | null;
  readonly marquee: CellRange | null;
  /** Marching-ants phase in device px. */
  readonly marqueePhase: number;
  readonly showFillHandle: boolean;
}

interface DeviceRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Transparent layer above the cells: selection fill and border, active cell,
 * fill handle, header highlights, formula reference highlights, fill-drag
 * preview, copy marquee, resize guide. Selection changes only repaint this
 * layer (cheap), never the cell layer.
 */
export class OverlayRenderer {
  constructor(
    private readonly geom: SheetGeometry,
    private theme: GridTheme,
  ) {}

  setTheme(theme: GridTheme): void {
    this.theme = theme;
  }

  render(ctx: CanvasRenderingContext2D, L: GridLayout, s: OverlayState): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const p of L.panes) this.renderPane(ctx, L, p, s);
    if (s.selection) this.renderHeaderHighlights(ctx, L, s.selection);
    if (s.resize) this.renderResizeGuide(ctx, L, s.resize.axis, s.resize.index);
  }

  /** Device-pixel rect of a cell range as seen through a pane (clamped near the pane). */
  private rangeRect(L: GridLayout, p: Pane, r: CellRange): DeviceRect {
    const { rows, cols } = this.geom;
    const m = Math.round(8 * L.dpr);
    const px0 = Math.round(p.x * L.dpr) - m;
    const px1 = Math.round((p.x + p.w) * L.dpr) + m;
    const py0 = Math.round(p.y * L.dpr) - m;
    const py1 = Math.round((p.y + p.h) * L.dpr) + m;
    const cx = (v: number) => Math.min(Math.max(v, px0), px1);
    const cy = (v: number) => Math.min(Math.max(v, py0), py1);
    return {
      x0: cx(devX(L, p, cols.offsetOf(r.c0))),
      x1: cx(devX(L, p, cols.endOf(r.c1))),
      y0: cy(devY(L, p, rows.offsetOf(r.r0))),
      y1: cy(devY(L, p, rows.endOf(r.r1))),
    };
  }

  private paneRange(p: Pane): CellRange {
    return { r0: p.r0, c0: p.c0, r1: p.r1, c1: p.c1 };
  }

  private renderPane(ctx: CanvasRenderingContext2D, L: GridLayout, p: Pane, s: OverlayState): void {
    if (p.r1 < p.r0 || p.c1 < p.c0) return;
    const t = this.theme;
    const dpr = L.dpr;
    const lw = Math.max(1, Math.round(dpr * 0.75));
    const pr = this.paneRange(p);
    const px0 = Math.round(p.x * dpr);
    const py0 = Math.round(p.y * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(px0, py0, Math.round((p.x + p.w) * dpr) - px0, Math.round((p.y + p.h) * dpr) - py0);
    ctx.clip();

    // Formula reference highlights (under the selection, like Excel).
    const hb = Math.max(2, Math.round(2 * dpr));
    for (const h of s.highlights) {
      if (!rangesIntersect(h.range, pr)) continue;
      const d = this.rangeRect(L, p, h.range);
      ctx.fillStyle = h.fill;
      ctx.fillRect(d.x0, d.y0, d.x1 - d.x0 - lw, d.y1 - d.y0 - lw);
      ctx.fillStyle = h.border;
      strokeRectFill(ctx, d.x0 - lw, d.y0 - lw, d.x1, d.y1, hb);
      const hs = Math.round(5 * dpr);
      for (const [x, y] of [[d.x0 - lw, d.y0 - lw], [d.x1 - lw, d.y0 - lw], [d.x0 - lw, d.y1 - lw], [d.x1 - lw, d.y1 - lw]]) {
        ctx.fillRect(x - Math.floor(hs / 2), y - Math.floor(hs / 2), hs, hs);
      }
    }

    const sel = s.selection;
    if (sel && sel.ranges.length > 0) this.renderSelection(ctx, L, p, pr, sel, s.showFillHandle, lw);

    if (s.fillPreview && rangesIntersect(s.fillPreview, pr)) {
      const d = this.rangeRect(L, p, s.fillPreview);
      dashedRect(ctx, d.x0 - lw, d.y0 - lw, d.x1 - lw, d.y1 - lw, Math.max(1, Math.round(dpr)), t.fillPreview, null, 3 * dpr, 2 * dpr, 0);
    }
    if (s.pick && rangesIntersect(s.pick, pr)) {
      const d = this.rangeRect(L, p, s.pick);
      dashedRect(ctx, d.x0 - lw, d.y0 - lw, d.x1 - lw, d.y1 - lw, Math.max(2, Math.round(2 * dpr)), t.marquee, null, 4 * dpr, 3 * dpr, 0);
    }
    if (s.marquee && rangesIntersect(s.marquee, pr)) {
      const d = this.rangeRect(L, p, s.marquee);
      dashedRect(ctx, d.x0 - lw, d.y0 - lw, d.x1 - lw, d.y1 - lw, Math.max(2, Math.round(2 * dpr)), t.marquee, t.background, 4 * dpr, 4 * dpr, s.marqueePhase);
    }
    ctx.restore();
  }

  private renderSelection(ctx: CanvasRenderingContext2D, L: GridLayout, p: Pane, pr: CellRange, sel: SelectionState, fillHandle: boolean, lw: number): void {
    const t = this.theme;
    const dpr = L.dpr;
    const activeRange = sel.ranges[sel.activeRange] ?? sel.ranges[0];
    const a = sel.active;
    const activeMerge = this.geom.merges.at(a.row, a.col);
    const activeCell: CellRange = activeMerge ?? { r0: a.row, c0: a.col, r1: a.row, c1: a.col };
    const multiCell =
      sel.ranges.length > 1 || activeRange.r0 !== activeCell.r0 || activeRange.r1 !== activeCell.r1 || activeRange.c0 !== activeCell.c0 || activeRange.c1 !== activeCell.c1;

    // Translucent fill for every range...
    if (multiCell) {
      ctx.fillStyle = t.selectionFill;
      for (const r of sel.ranges) {
        if (!rangesIntersect(r, pr)) continue;
        const d = this.rangeRect(L, p, r);
        ctx.fillRect(d.x0, d.y0, d.x1 - d.x0 - lw, d.y1 - d.y0 - lw);
      }
    }
    // ...except the active cell, which stays clear (Excel).
    const ac = rangesIntersect(activeCell, pr) ? this.rangeRect(L, p, activeCell) : null;
    if (ac && multiCell) ctx.clearRect(ac.x0, ac.y0, ac.x1 - ac.x0 - lw, ac.y1 - ac.y0 - lw);

    // Thick border around the active range (or around the active cell for multi-range).
    const bw = Math.max(2, Math.round(2 * dpr));
    ctx.fillStyle = t.selectionBorder;
    if (sel.ranges.length === 1 && rangesIntersect(activeRange, pr)) {
      const d = this.rangeRect(L, p, activeRange);
      strokeRectFill(ctx, d.x0 - lw, d.y0 - lw, d.x1, d.y1, bw);
      // Fill handle at the bottom-right corner (single range only).
      if (fillHandle) {
        const hs = Math.round(6 * dpr);
        const hx = d.x1 - lw - Math.floor(hs / 2);
        const hy = d.y1 - lw - Math.floor(hs / 2);
        ctx.fillStyle = t.fillHandleRing;
        ctx.fillRect(hx - lw, hy - lw, hs + 2 * lw, hs + 2 * lw);
        ctx.fillStyle = t.selectionBorder;
        ctx.fillRect(hx, hy, hs, hs);
      }
    }
    if (sel.ranges.length > 1 && ac) {
      strokeRectFill(ctx, ac.x0 - lw, ac.y0 - lw, ac.x1, ac.y1, lw);
    }
  }

  private renderHeaderHighlights(ctx: CanvasRenderingContext2D, L: GridLayout, sel: SelectionState): void {
    const t = this.theme;
    const { rows, cols } = this.geom;
    const dpr = L.dpr;
    const lw = Math.max(1, Math.round(dpr * 0.75));
    const hh = Math.round(L.headerH * dpr);
    const hw = Math.round(L.headerW * dpr);
    const bw = Math.max(2, Math.round(2 * dpr));
    const font = `${Math.round(t.headerFontSizePx * L.zoom * dpr * 10) / 10}px ${t.headerFont}`;
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fullCols = sel.kind === "cols" || sel.kind === "all";
    const fullRows = sel.kind === "rows" || sel.kind === "all";
    if (sel.kind === "all") {
      ctx.fillStyle = t.headerAllSelectedBg;
      ctx.fillRect(0, 0, hw - lw, hh - lw);
    }
    const colPanes = L.panes.filter((p) => p.kind === (L.frozenH > 0 ? "corner" : "left") || p.kind === (L.frozenH > 0 ? "top" : "main"));
    const rowPanes = L.panes.filter((p) => p.kind === (L.frozenW > 0 ? "corner" : "top") || p.kind === (L.frozenW > 0 ? "left" : "main"));
    for (const p of colPanes) {
      if (p.c1 < p.c0) continue;
      const sx0 = Math.round(p.x * dpr);
      const sx1 = Math.round((p.x + p.w) * dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx0, 0, sx1 - sx0, hh);
      ctx.clip();
      for (const r of sel.ranges) {
        const c0 = Math.max(r.c0, p.c0);
        const c1 = Math.min(r.c1, p.c1);
        if (c0 > c1) continue;
        for (let c = c0; c <= c1; c++) {
          const x0 = devX(L, p, cols.offsetOf(c));
          const x1 = devX(L, p, cols.endOf(c));
          if (x1 <= x0) continue;
          ctx.fillStyle = fullCols ? t.headerAllSelectedBg : t.headerSelectedBg;
          ctx.fillRect(x0, 0, x1 - x0 - lw, hh - lw);
          ctx.fillStyle = t.headerSelectedText;
          ctx.fillText(colName(c), (x0 + x1 - lw) / 2, hh / 2);
        }
        const x0 = Math.max(sx0, devX(L, p, cols.offsetOf(c0)));
        const x1 = Math.min(sx1, devX(L, p, cols.endOf(c1)));
        ctx.fillStyle = t.headerSelectedLine;
        ctx.fillRect(x0, hh - bw, x1 - x0, bw);
      }
      ctx.restore();
    }
    for (const p of rowPanes) {
      if (p.r1 < p.r0) continue;
      const sy0 = Math.round(p.y * dpr);
      const sy1 = Math.round((p.y + p.h) * dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sy0, hw, sy1 - sy0);
      ctx.clip();
      for (const r of sel.ranges) {
        const r0 = Math.max(r.r0, p.r0);
        const r1 = Math.min(r.r1, p.r1);
        if (r0 > r1) continue;
        let row = rows.nextVisible(r0, 1);
        while (row >= 0 && row <= r1) {
          const y0 = devY(L, p, rows.offsetOf(row));
          const y1 = devY(L, p, rows.endOf(row));
          ctx.fillStyle = fullRows ? t.headerAllSelectedBg : t.headerSelectedBg;
          ctx.fillRect(0, y0, hw - lw, y1 - y0 - lw);
          ctx.fillStyle = t.headerSelectedText;
          ctx.fillText(String(row + 1), hw / 2, (y0 + y1 - lw) / 2);
          row = row + 1 < rows.count ? rows.nextVisible(row + 1, 1) : -1;
        }
        const y0 = Math.max(sy0, devY(L, p, rows.offsetOf(r0)));
        const y1 = Math.min(sy1, devY(L, p, rows.endOf(r1)));
        ctx.fillStyle = t.headerSelectedLine;
        ctx.fillRect(hw - bw, y0, bw, y1 - y0);
      }
      ctx.restore();
    }
  }

  private renderResizeGuide(ctx: CanvasRenderingContext2D, L: GridLayout, axis: "col" | "row", index: number): void {
    const { rows, cols } = this.geom;
    const dpr = L.dpr;
    ctx.fillStyle = this.theme.resizeGuide;
    const w = Math.max(1, Math.round(dpr));
    if (axis === "col") {
      const p = index < this.geom.frozenCols ? (L.panes.find((q) => q.kind === "left" || q.kind === "corner") ?? L.main) : L.main;
      const x = devX(L, p, cols.endOf(index));
      ctx.fillRect(x - w, 0, w, ctx.canvas.height);
    } else {
      const p = index < this.geom.frozenRows ? (L.panes.find((q) => q.kind === "top" || q.kind === "corner") ?? L.main) : L.main;
      const y = devY(L, p, rows.endOf(index));
      ctx.fillRect(0, y - w, ctx.canvas.width, w);
    }
  }
}

/** Rectangle outline drawn with fillRect (crisp at any DPR). */
function strokeRectFill(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const h = Math.floor(w / 2);
  ctx.fillRect(x0 - h, y0 - h, x1 - x0 + w, w);
  ctx.fillRect(x0 - h, y1 - h, x1 - x0 + w, w);
  ctx.fillRect(x0 - h, y0 - h, w, y1 - y0 + w);
  ctx.fillRect(x1 - h, y0 - h, w, y1 - y0 + w);
}

/** Dashed outline; with `under` set, draws a solid base first (marching ants). */
function dashedRect(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  color: string,
  under: string | null,
  dash: number,
  gap: number,
  phase: number,
): void {
  const off = w % 2 === 1 ? 0.5 : 0;
  ctx.lineWidth = w;
  if (under) {
    ctx.setLineDash([]);
    ctx.strokeStyle = under;
    ctx.strokeRect(x0 + off, y0 + off, x1 - x0, y1 - y0);
  }
  ctx.setLineDash([dash, gap]);
  ctx.lineDashOffset = -phase;
  ctx.strokeStyle = color;
  ctx.strokeRect(x0 + off, y0 + off, x1 - x0, y1 - y0);
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

/** `#rrggbb` -> `rgba(r, g, b, a)`. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
