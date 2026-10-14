import { BLOCK_COLS, BLOCK_ROWS, CellKind, type BlockKey, type BorderSpec, type HAlign } from "@/engine/contract";
import { colName, type CellRange } from "@/engine/types";
import type { BlockCache } from "../data/BlockCache";
import type { GridBlock } from "../data/GridBlock";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import { blitCompatible, devX, devY, overflowColumns, paneDeviceRect, paneDomain } from "../geometry/layout";
import type { DeviceRect, GridLayout, Pane } from "../geometry/layout";
import type { ResolvedStyle, StyleResolver } from "./StyleResolver";
import type { TextMeasurer } from "./TextMeasurer";
import type { GridTheme } from "./theme";

export interface RenderDeps {
  readonly geom: SheetGeometry;
  readonly cache: () => BlockCache;
  readonly styles: StyleResolver;
  readonly measurer: TextMeasurer;
}

export interface BaseRenderStats {
  cells: number;
  texts: number;
  clips: number;
  missingBlocks: number;
  panes: number;
}

/** Block pointer state: a loaded block, known-empty (null) or not loaded yet (undefined). */
type BlockSlot = GridBlock | null | undefined;

type Align = "left" | "center" | "right";

/**
 * How far (in line widths) a cell border can paint outside its cell: borders
 * sit on the shared edge (`x0 - lw`) and thick/double ones grow around it.
 */
const BORDER_REACH = 3;

const BORDER_WIDTH: Record<BorderSpec["style"], number> = {
  thin: 1,
  hair: 1,
  medium: 2,
  thick: 3,
  dashed: 1,
  dotted: 1,
  double: 3,
};

/**
 * Draws the cell content layer: placeholders, gridlines, fills, text (with
 * Excel-style overflow / clipping / wrap / ####), borders, merged cells,
 * autofilter buttons, headers (with hidden row/col markers) and frozen-pane
 * separators. All coordinates are snapped to device pixels so 1px lines stay
 * crisp at any DPR / zoom, and a scroll of N device px moves every edge by
 * exactly N (pixel-exact incremental frames).
 */
export class BaseRenderer {
  private xs = new Int32Array(512);
  private ys = new Int32Array(1024);
  /** Visible row index per drawn row slot (hidden runs skipped). */
  private rowIdx = new Int32Array(1024);
  /** Slot base (band index * blocks per band) per drawn row slot. */
  private rowBand = new Int32Array(1024);
  private slots: BlockSlot[] = [];
  private textCols = new Int32Array(512);
  private mergeSpans: number[] = [];
  private borderCells: number[] = [];
  private theme: GridTheme;
  /** Blocks referenced by merges outside the visible set that are not loaded. */
  readonly missing: BlockKey[] = [];
  readonly stats: BaseRenderStats = { cells: 0, texts: 0, clips: 0, missingBlocks: 0, panes: 0 };

  // ctx state shadowing (avoid redundant state changes)
  private curFont = "";
  private curFill = "";
  private curAlign: CanvasTextAlign = "left";

  constructor(
    private readonly deps: RenderDeps,
    theme: GridTheme,
  ) {
    this.theme = theme;
  }

  setTheme(theme: GridTheme): void {
    this.theme = theme;
  }

  private beginFrame(ctx: CanvasRenderingContext2D): void {
    const st = this.stats;
    st.cells = st.texts = st.clips = st.missingBlocks = st.panes = 0;
    this.missing.length = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    this.curFont = "";
    this.curFill = "";
    this.curAlign = "left";
  }

  /** Full redraw of the cell layer. */
  render(ctx: CanvasRenderingContext2D, L: GridLayout): void {
    this.beginFrame(ctx);
    this.setFill(ctx, this.theme.background);
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    for (const p of L.panes) this.renderPane(ctx, L, p, null);
    this.renderHeaders(ctx, L, null);
    this.renderFrozenLines(ctx, L);
  }

  /**
   * Incremental redraw: shift each pane's previous pixels by its scroll delta
   * (pixel-exact because scroll is snapped to whole device pixels), then
   * repaint only the exposed strips plus the given dirty rects. Returns false
   * if the layouts are not blit-compatible; the caller must then do a full render.
   */
  renderIncremental(ctx: CanvasRenderingContext2D, prev: GridLayout, L: GridLayout, dirty: ReadonlyArray<DeviceRect>): boolean {
    if (!blitCompatible(prev, L)) return false;
    this.beginFrame(ctx);
    const rects: DeviceRect[] = dirty.slice();
    for (let i = 0; i < L.panes.length; i++) {
      const p = L.panes[i];
      const q = prev.panes[i];
      this.blitRegion(ctx, paneDeviceRect(L, p), q.scrollDevX - p.scrollDevX, q.scrollDevY - p.scrollDevY, rects);
    }
    // Grow every repaint rect by the border reach: a border of a cell inside
    // the rect may paint just outside it (and vice versa), so the margin is
    // repainted too (identical pixels where nothing changed).
    const grow = BORDER_REACH * this.lineWidth(L.dpr);
    for (const rect of rects) {
      const g = { x0: rect.x0 - grow, y0: rect.y0 - grow, x1: rect.x1 + grow, y1: rect.y1 + grow };
      for (const p of L.panes) this.renderPane(ctx, L, p, g);
    }

    // Headers scroll with the main pane: blit their strips too, repaint the exposed labels.
    const headerRects: DeviceRect[] = [];
    const m = paneDeviceRect(L, L.main);
    const hw = Math.round(L.headerW * L.dpr);
    const hh = Math.round(L.headerH * L.dpr);
    const dx = prev.main.scrollDevX - L.main.scrollDevX;
    const dy = prev.main.scrollDevY - L.main.scrollDevY;
    this.blitRegion(ctx, { x0: m.x0, x1: m.x1, y0: 0, y1: hh }, dx, 0, headerRects);
    this.blitRegion(ctx, { x0: 0, x1: hw, y0: m.y0, y1: m.y1 }, 0, dy, headerRects);
    for (const rect of headerRects) this.renderHeaders(ctx, L, rect);
    this.renderFrozenLines(ctx, L);
    return true;
  }

  /**
   * Shift the pixels of region r by (dx, dy) and append the exposed strips to
   * `exposed`. If the shift exceeds the region, the whole region is exposed.
   */
  private blitRegion(ctx: CanvasRenderingContext2D, r: DeviceRect, dx: number, dy: number, exposed: DeviceRect[]): void {
    if (dx === 0 && dy === 0) return;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    if (Math.abs(dx) >= w || Math.abs(dy) >= h) {
      exposed.push(r);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x0, r.y0, w, h);
    ctx.clip();
    ctx.drawImage(ctx.canvas, r.x0, r.y0, w, h, r.x0 + dx, r.y0 + dy, w, h);
    this.restore(ctx);
    if (dy < 0) exposed.push({ x0: r.x0, x1: r.x1, y0: r.y1 + dy, y1: r.y1 });
    else if (dy > 0) exposed.push({ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y0 + dy });
    if (dx < 0) exposed.push({ x0: r.x1 + dx, x1: r.x1, y0: r.y0, y1: r.y1 });
    else if (dx > 0) exposed.push({ x0: r.x0, x1: r.x0 + dx, y0: r.y0, y1: r.y1 });
  }

  private setFill(ctx: CanvasRenderingContext2D, color: string): void {
    if (this.curFill !== color) {
      ctx.fillStyle = color;
      this.curFill = color;
    }
  }

  private setFont(ctx: CanvasRenderingContext2D, font: string): void {
    if (this.curFont !== font) {
      ctx.font = font;
      this.curFont = font;
    }
  }

  private setAlign(ctx: CanvasRenderingContext2D, a: CanvasTextAlign): void {
    if (this.curAlign !== a) {
      ctx.textAlign = a;
      this.curAlign = a;
    }
  }

  /** ctx.restore() reverts font/fill/align: re-sync the shadowed state. */
  private restore(ctx: CanvasRenderingContext2D): void {
    ctx.restore();
    this.curFont = "";
    this.curFill = "";
    this.curAlign = ctx.textAlign;
  }

  private lineWidth(dpr: number): number {
    return Math.max(1, Math.round(dpr * 0.75));
  }

  // ---------------------------------------------------------------- panes

  /**
   * Visible rows of a pane with their device y edges: `rowIdx[k]`, `ys[k]`
   * (top) and `ys[k + 1]` (bottom). Hidden runs are skipped in O(log k).
   * Returns the number of rows.
   */
  private collectRows(L: GridLayout, p: Pane): number {
    const { rows } = this.deps.geom;
    let n = 0;
    let r = rows.nextVisible(p.r0, 1);
    if (r < 0 || r > p.r1) return 0;
    let off = rows.offsetOf(r);
    while (r >= 0 && r <= p.r1) {
      if (n + 2 > this.rowIdx.length) this.growRows(n * 2 + 2);
      this.rowIdx[n] = r;
      this.ys[n] = devY(L, p, off);
      off += rows.sizeOf(r);
      n++;
      r = r + 1 < rows.count ? rows.nextVisible(r + 1, 1) : -1;
    }
    this.ys[n] = devY(L, p, off);
    return n;
  }

  private growRows(size: number): void {
    const grow = (a: Int32Array) => {
      const b = new Int32Array(size);
      b.set(a.subarray(0, Math.min(a.length, size)));
      return b;
    };
    this.rowIdx = grow(this.rowIdx);
    this.ys = grow(this.ys);
    this.rowBand = grow(this.rowBand);
  }

  /**
   * Draw one pane, optionally restricted to a device-pixel clip rect (used by
   * incremental frames: exposed scroll strips and dirty blocks).
   */
  private renderPane(ctx: CanvasRenderingContext2D, L: GridLayout, p: Pane, clip: DeviceRect | null): void {
    if (p.r1 < p.r0 || p.c1 < p.c0) return;
    const { geom } = this.deps;
    const cache = this.deps.cache();
    const theme = this.theme;
    const { cols } = geom;
    const dpr = L.dpr;
    const lw = this.lineWidth(dpr);

    const px0 = Math.round(p.x * dpr);
    const py0 = Math.round(p.y * dpr);
    const px1 = Math.round((p.x + p.w) * dpr);
    const py1 = Math.round((p.y + p.h) * dpr);
    const cx0 = clip ? Math.max(px0, clip.x0) : px0;
    const cy0 = clip ? Math.max(py0, clip.y0) : py0;
    const cx1 = clip ? Math.min(px1, clip.x1) : px1;
    const cy1 = clip ? Math.min(py1, clip.y1) : py1;
    if (cx1 <= cx0 || cy1 <= cy0) return;
    this.stats.panes++;

    // Column range extended for overflow scanning, bounded by the pane's column domain.
    const { ce0, ce1 } = overflowColumns(geom, p, L.zoom);
    const nC = ce1 - ce0 + 2;
    if (this.xs.length < nC) this.xs = new Int32Array(nC * 2);
    const xs = this.xs;
    let off = cols.offsetOf(ce0);
    for (let k = 0; k < nC; k++) {
      xs[k] = devX(L, p, off);
      if (k < nC - 1) off += cols.sizeOf(ce0 + k);
    }
    const nR = this.collectRows(L, p);
    if (nR === 0) return;
    const ys = this.ys;
    const rowIdx = this.rowIdx;

    // Row slots touching the clip, plus one on each side (glyphs may bleed a pixel across rows).
    let kS = 0;
    while (kS < nR - 1 && ys[kS + 1] <= cy0) kS++;
    let kE = kS;
    while (kE < nR - 1 && ys[kE + 1] < cy1) kE++;
    kS = Math.max(0, kS - 1);
    kE = Math.min(nR - 1, kE + 1);

    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.clip();
    if (clip) {
      this.setFill(ctx, theme.background);
      ctx.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    }

    // Resolve block slots per band of the drawn rows: slots[bandIndex * nbc + (bc - bc0)].
    const bc0 = Math.floor(ce0 / BLOCK_COLS);
    const bc1 = Math.floor(ce1 / BLOCK_COLS);
    const nbc = bc1 - bc0 + 1;
    const slots = this.slots;
    slots.length = 0;
    let bandCount = 0;
    let lastBr = -1;
    for (let k = kS; k <= kE; k++) {
      const br = Math.floor(rowIdx[k] / BLOCK_ROWS);
      if (br !== lastBr) {
        lastBr = br;
        bandCount++;
        for (let bc = bc0; bc <= bc1; bc++) slots.push(cache.isKnownEmpty(br, bc) ? null : cache.get(br, bc));
      }
      this.rowBand[k] = (bandCount - 1) * nbc;
    }

    // Placeholders for data still in flight (only the visible part).
    this.setFill(ctx, theme.placeholder);
    for (let k = kS; k <= kE; ) {
      const base = this.rowBand[k];
      let kB = k;
      while (kB < kE && this.rowBand[kB + 1] === base) kB++;
      for (let bc = bc0; bc <= bc1; bc++) {
        if (slots[base + bc - bc0] !== undefined) continue;
        const cA = Math.max(p.c0, bc * BLOCK_COLS);
        const cB = Math.min(p.c1, bc * BLOCK_COLS + BLOCK_COLS - 1);
        if (cA > cB) continue;
        this.stats.missingBlocks++;
        ctx.fillRect(xs[cA - ce0], ys[k], xs[cB - ce0 + 1] - xs[cA - ce0], ys[kB + 1] - ys[k]);
      }
      k = kB + 1;
    }

    // Gridlines: one rect per visible row/col edge (last device pixel of each cell).
    if (geom.showGridLines) {
      this.setFill(ctx, theme.gridline);
      for (let c = p.c0; c <= p.c1; c++) {
        const x1 = xs[c - ce0 + 1];
        if (x1 > xs[c - ce0] && x1 > cx0 && x1 - lw < cx1) ctx.fillRect(x1 - lw, cy0, lw, cy1 - cy0);
      }
      for (let k = kS; k <= kE; k++) {
        const y1 = ys[k + 1];
        if (y1 > ys[k]) ctx.fillRect(cx0, y1 - lw, cx1 - cx0, lw);
      }
    }

    const merges = geom.merges.size > 0 ? geom.merges.query({ r0: rowIdx[kS], c0: ce0, r1: rowIdx[kE], c1: ce1 }) : [];
    this.borderCells.length = 0;

    for (let k = kS; k <= kE; k++) {
      const y0 = ys[k];
      const y1 = ys[k + 1];
      if (y1 <= y0) continue;
      const r = rowIdx[k];
      // Merged spans on this row, as flat [c0, c1, ...].
      const spans = this.mergeSpans;
      spans.length = 0;
      for (const m of merges) if (r >= m.r0 && r <= m.r1) spans.push(m.c0, m.c1);
      this.renderRow(ctx, L, r, y0, y1, ce0, ce1, bc0, this.rowBand[k], lw, cx0, cx1);
    }

    if (this.borderCells.length > 0) this.renderBorders(ctx, ce0, lw);
    if (merges.length > 0) this.renderMerges(ctx, L, p, merges, lw);
    if (geom.autoFilter) this.renderFilterButtons(ctx, L, p, ce0, nR, lw);
    this.restore(ctx);
  }

  private inMerge(c: number): boolean {
    const s = this.mergeSpans;
    for (let k = 0; k < s.length; k += 2) if (c >= s[k] && c <= s[k + 1]) return true;
    return false;
  }

  /** Is cell (r, c) free for text overflow? Unknown (not loaded) counts as occupied. */
  private overflowFree(r: number, c: number, ce0: number, ce1: number, bc0: number, band: number): boolean {
    if (c < ce0 || c > ce1 || this.inMerge(c)) return false;
    const slot = this.slots[band + Math.floor(c / BLOCK_COLS) - bc0];
    if (slot === null) return true;
    if (slot === undefined) return false;
    const i = (r % BLOCK_ROWS) * BLOCK_COLS + (c % BLOCK_COLS);
    return slot.texts[i] === null && slot.kinds[i] !== CellKind.Pending;
  }

  private fillOfCell(r: number, c: number, bc0: number, band: number): string | null {
    const slot = this.slots[band + Math.floor(c / BLOCK_COLS) - bc0];
    if (!slot) return null;
    const sid = slot.styleIds[(r % BLOCK_ROWS) * BLOCK_COLS + (c % BLOCK_COLS)];
    return sid === 0 ? null : this.deps.styles.get(sid).fill;
  }

  private renderRow(
    ctx: CanvasRenderingContext2D,
    L: GridLayout,
    r: number,
    y0: number,
    y1: number,
    ce0: number,
    ce1: number,
    bc0: number,
    band: number,
    lw: number,
    clipL: number,
    clipR: number,
  ): void {
    const { styles, measurer } = this.deps;
    const theme = this.theme;
    const xs = this.xs;
    const slots = this.slots;
    const rowInBlock = (r % BLOCK_ROWS) * BLOCK_COLS;
    const hasMerges = this.mergeSpans.length > 0;
    let nText = 0;
    if (this.textCols.length < ce1 - ce0 + 1) this.textCols = new Int32Array((ce1 - ce0 + 1) * 2);
    const textCols = this.textCols;

    // Pass 1: fills, pending placeholders, border collection, text cell collection.
    for (let c = ce0; c <= ce1; c++) {
      const slot = slots[band + Math.floor(c / BLOCK_COLS) - bc0];
      if (!slot) continue;
      const i = rowInBlock + (c % BLOCK_COLS);
      const sid = slot.styleIds[i];
      const text = slot.texts[i];
      const kind = slot.kinds[i];
      if (sid === 0 && text === null && kind !== CellKind.Pending) continue;
      if (hasMerges && this.inMerge(c)) continue;
      this.stats.cells++;
      const x0 = xs[c - ce0];
      const x1 = xs[c - ce0 + 1];
      if (kind === CellKind.Pending) {
        if (x1 > clipL && x0 < clipR && x1 > x0) {
          this.setFill(ctx, theme.placeholder);
          ctx.fillRect(x0, y0, x1 - x0 - lw, y1 - y0 - lw);
        }
        continue;
      }
      // Borders reach up to BORDER_REACH line widths into the neighbouring cells.
      const reach = BORDER_REACH * lw;
      if (sid !== 0 && x1 > x0 && x1 + reach > clipL && x0 - reach < clipR) {
        const st = styles.get(sid);
        if (st.fill !== null && x1 > clipL && x0 < clipR) {
          this.setFill(ctx, st.fill);
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        if (st.hasBorders) this.borderCells.push(r, c, sid, y0, y1);
      }
      if (text !== null) textCols[nText++] = c;
    }

    // Pass 2: text.
    const s = L.dpr * L.zoom;
    const padX = Math.max(1, Math.round(theme.cellPaddingX * s));
    const padY = Math.round(theme.cellPaddingY * s);
    for (let k = 0; k < nText; k++) {
      const c = textCols[k];
      const cx0 = xs[c - ce0];
      const cx1 = xs[c - ce0 + 1];
      if (cx1 <= cx0) continue; // hidden column
      const slot = slots[band + Math.floor(c / BLOCK_COLS) - bc0] as GridBlock;
      const i = rowInBlock + (c % BLOCK_COLS);
      const text = slot.texts[i] as string;
      const kind = slot.kinds[i];
      const st = styles.get(slot.styleIds[i]);
      const visible = cx1 > clipL && cx0 < clipR;
      const align = effectiveAlign(st.hAlign, kind);
      const fm = measurer.fontMetrics(st.font);
      const indent = st.indent * Math.round(9 * s);
      const availL = cx0 + padX + (align === "left" ? indent : 0);
      const availR = cx1 - lw - padX - (align === "right" ? indent : 0);
      const avail = availR - availL;
      const baseline = baselineY(st, fm.ascent, fm.descent, y0, y1 - lw, padY);

      if (st.wrap) {
        if (visible) this.drawWrapped(ctx, st, text, align, cx0, cx1 - lw, y0, y1 - lw, padX, padY, fm.ascent, fm.descent);
        continue;
      }
      if (st.hAlign === "fill") {
        if (visible) this.drawRepeated(ctx, st, text, availL, availR, baseline, cx0, cx1 - lw, y0, y1 - lw);
        continue;
      }

      const quickFit = text.length * fm.maxCharW <= avail;
      const w = quickFit ? 0 : measurer.measure(st.font, text);
      if (quickFit || w <= avail) {
        if (!visible) continue;
        this.drawText(ctx, st, text, align, availL, availR, baseline, w);
        continue;
      }
      if (kind === CellKind.Number) {
        if (!visible) continue;
        const n = Math.max(1, Math.floor(avail / fm.hashW));
        this.drawClipped(ctx, st, "#".repeat(n), "left", availL, availR, baseline, cx0, cx1 - lw, y0, y1 - lw);
        continue;
      }

      // Text overflow into empty neighbours (Excel rules: left -> right, right -> left, center -> both).
      let cl = c;
      let cr = c;
      let spanL = cx0;
      let spanR = cx1;
      if (align === "left") {
        while (availL + w > spanR - lw - padX && this.overflowFree(r, cr + 1, ce0, ce1, bc0, band)) {
          cr++;
          spanR = xs[cr - ce0 + 1];
        }
      } else if (align === "right") {
        while (availR - w < spanL + padX && this.overflowFree(r, cl - 1, ce0, ce1, bc0, band)) {
          cl--;
          spanL = xs[cl - ce0];
        }
      } else {
        const mid = (cx0 + cx1 - lw) / 2;
        while (mid - w / 2 < spanL + padX && this.overflowFree(r, cl - 1, ce0, ce1, bc0, band)) {
          cl--;
          spanL = xs[cl - ce0];
        }
        while (mid + w / 2 > spanR - lw - padX && this.overflowFree(r, cr + 1, ce0, ce1, bc0, band)) {
          cr++;
          spanR = xs[cr - ce0 + 1];
        }
      }
      if (spanR <= clipL || spanL >= clipR) continue;
      // Hide the gridlines the text flows across.
      if (this.deps.geom.showGridLines) {
        for (let cc = cl; cc < cr; cc++) {
          this.setFill(ctx, this.fillOfCell(r, cc, bc0, band) ?? theme.background);
          ctx.fillRect(xs[cc - ce0 + 1] - lw, y0, lw, y1 - y0 - lw);
        }
      }
      const textL = align === "right" ? availR : availL;
      const fitsSpan =
        align === "left" ? availL + w <= spanR - lw : align === "right" ? availR - w >= spanL : (cx0 + cx1 - lw) / 2 - w / 2 >= spanL && (cx0 + cx1 - lw) / 2 + w / 2 <= spanR - lw;
      if (fitsSpan) this.drawText(ctx, st, text, align, textL, availR, baseline, w);
      else this.drawClipped(ctx, st, text, align, availL, availR, baseline, spanL, spanR - lw, y0, y1 - lw);
    }
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    st: ResolvedStyle,
    text: string,
    align: Align,
    availL: number,
    availR: number,
    baseline: number,
    knownWidth: number,
  ): void {
    this.stats.texts++;
    this.setFont(ctx, st.font);
    this.setFill(ctx, st.color);
    let x: number;
    if (align === "left") {
      this.setAlign(ctx, "left");
      x = availL;
    } else if (align === "right") {
      this.setAlign(ctx, "right");
      x = availR;
    } else {
      this.setAlign(ctx, "center");
      x = (availL + availR) / 2;
    }
    ctx.fillText(text, x, baseline);
    if (st.underline !== 0 || st.strike) {
      const w = knownWidth > 0 ? knownWidth : this.deps.measurer.measure(st.font, text);
      const lx = align === "left" ? x : align === "right" ? x - w : x - w / 2;
      const t = Math.max(1, Math.round(st.fontPx / 14));
      if (st.underline !== 0) ctx.fillRect(lx, Math.round(baseline + t), w, t);
      if (st.underline === 2) ctx.fillRect(lx, Math.round(baseline + 3 * t), w, t);
      if (st.strike) ctx.fillRect(lx, Math.round(baseline - st.fontPx * 0.3), w, t);
    }
  }

  private drawClipped(
    ctx: CanvasRenderingContext2D,
    st: ResolvedStyle,
    text: string,
    align: Align,
    availL: number,
    availR: number,
    baseline: number,
    clipL: number,
    clipR: number,
    clipT: number,
    clipB: number,
  ): void {
    this.stats.clips++;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipL, clipT, clipR - clipL, clipB - clipT);
    ctx.clip();
    this.drawText(ctx, st, text, align, availL, availR, baseline, 0);
    this.restore(ctx);
  }

  /** `fill` alignment: repeat the text across the cell (whole copies only, like Excel). */
  private drawRepeated(
    ctx: CanvasRenderingContext2D,
    st: ResolvedStyle,
    text: string,
    availL: number,
    availR: number,
    baseline: number,
    clipL: number,
    clipR: number,
    clipT: number,
    clipB: number,
  ): void {
    const w = this.deps.measurer.measure(st.font, text);
    if (w <= 0) return;
    const n = Math.max(1, Math.floor((availR - availL) / w));
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipL, clipT, clipR - clipL, clipB - clipT);
    ctx.clip();
    for (let k = 0; k < n; k++) this.drawText(ctx, st, text, "left", availL + k * w, availR, baseline, w);
    this.restore(ctx);
  }

  private drawWrapped(
    ctx: CanvasRenderingContext2D,
    st: ResolvedStyle,
    text: string,
    align: Align,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    padX: number,
    padY: number,
    ascent: number,
    descent: number,
  ): void {
    const lines = this.deps.measurer.wrap(st.font, text, x1 - x0 - 2 * padX);
    const lineH = Math.round((ascent + descent) * 1.05);
    const blockH = lines.length * lineH;
    let y: number;
    if (st.vAlign === "top") y = y0 + padY + ascent;
    else if (st.vAlign === "middle") y = (y0 + y1) / 2 - blockH / 2 + ascent;
    else y = y1 - padY - descent - (lines.length - 1) * lineH;
    this.stats.clips++;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    for (const line of lines) {
      if (y - ascent > y1) break;
      this.drawText(ctx, st, line, align, x0 + padX, x1 - padX, y, 0);
      y += lineH;
    }
    this.restore(ctx);
  }

  // -------------------------------------------------------------- borders

  private renderBorders(ctx: CanvasRenderingContext2D, ce0: number, lw: number): void {
    const { styles } = this.deps;
    const b = this.borderCells;
    const xs = this.xs;
    for (let k = 0; k < b.length; k += 5) {
      const c = b[k + 1];
      const st = styles.get(b[k + 2]);
      const y0 = b[k + 3];
      const y1 = b[k + 4];
      const x0 = xs[c - ce0];
      const x1 = xs[c - ce0 + 1];
      drawCellBorders(ctx, st, x0, y0, x1, y1, lw, 15, (color) => this.setFill(ctx, color));
    }
  }

  // --------------------------------------------------------------- merges

  /**
   * Merged cells. A merge crossing a frozen boundary is split: each pane draws
   * its part (fill, outer borders on real edges), and the text is drawn only
   * in the pane holding the merge's top-left cell, laid out in that part.
   */
  private renderMerges(ctx: CanvasRenderingContext2D, L: GridLayout, p: Pane, merges: ReadonlyArray<CellRange>, lw: number): void {
    const { geom, styles, measurer } = this.deps;
    const cache = this.deps.cache();
    const theme = this.theme;
    const { rows, cols } = geom;
    const s = L.dpr * L.zoom;
    const padX = Math.max(1, Math.round(theme.cellPaddingX * s));
    const padY = Math.round(theme.cellPaddingY * s);
    const dom = paneDomain(geom, p);
    for (const m of merges) {
      const r0 = Math.max(m.r0, dom.rMin);
      const r1 = Math.min(m.r1, dom.rMax);
      const c0 = Math.max(m.c0, dom.cMin);
      const c1 = Math.min(m.c1, dom.cMax);
      if (r0 > r1 || c0 > c1) continue;
      const mx0 = devX(L, p, cols.offsetOf(c0));
      const mx1 = devX(L, p, cols.endOf(c1));
      const my0 = devY(L, p, rows.offsetOf(r0));
      const my1 = devY(L, p, rows.endOf(r1));
      if (mx1 <= mx0 || my1 <= my0) continue;
      const br = Math.floor(m.r0 / BLOCK_ROWS);
      const bc = Math.floor(m.c0 / BLOCK_COLS);
      const block = cache.isKnownEmpty(br, bc) ? null : cache.get(br, bc);
      if (block === undefined) this.missing.push({ br, bc });
      const i = (m.r0 % BLOCK_ROWS) * BLOCK_COLS + (m.c0 % BLOCK_COLS);
      const sid = block ? block.styleIds[i] : 0;
      const text = block ? block.texts[i] : null;
      const st = styles.get(sid);
      this.setFill(ctx, block === undefined ? theme.placeholder : (st.fill ?? theme.background));
      ctx.fillRect(mx0, my0, mx1 - mx0 - lw, my1 - my0 - lw);
      const ownsText = m.r0 >= dom.rMin && m.r0 <= dom.rMax && m.c0 >= dom.cMin && m.c0 <= dom.cMax;
      if (text && ownsText) {
        const fm = measurer.fontMetrics(st.font);
        const align = effectiveAlign(st.hAlign, block ? block.kinds[i] : CellKind.Text);
        const baseline = baselineY(st, fm.ascent, fm.descent, my0, my1 - lw, padY);
        if (st.wrap) {
          this.drawWrapped(ctx, st, text, align, mx0, mx1 - lw, my0, my1 - lw, padX, padY, fm.ascent, fm.descent);
        } else {
          this.drawClipped(ctx, st, text, align, mx0 + padX, mx1 - lw - padX, baseline, mx0, mx1 - lw, my0, my1 - lw);
        }
      }
      if (st.hasBorders) {
        const sides = (r0 === m.r0 ? 1 : 0) | (c1 === m.c1 ? 2 : 0) | (r1 === m.r1 ? 4 : 0) | (c0 === m.c0 ? 8 : 0);
        drawCellBorders(ctx, st, mx0, my0, mx1, my1, lw, sides, (color) => this.setFill(ctx, color));
      }
    }
  }

  // -------------------------------------------------------- filter buttons

  /** Autofilter dropdown buttons in the header row of `SheetInfo.autoFilter`. */
  private renderFilterButtons(ctx: CanvasRenderingContext2D, L: GridLayout, p: Pane, ce0: number, nR: number, lw: number): void {
    const af = this.deps.geom.autoFilter;
    if (!af) return;
    const row = af.range.r0;
    let k = -1;
    for (let j = 0; j < nR; j++) {
      if (this.rowIdx[j] === row) {
        k = j;
        break;
      }
    }
    if (k < 0) return;
    const y0 = this.ys[k];
    const y1 = this.ys[k + 1];
    const theme = this.theme;
    const c0 = Math.max(af.range.c0, p.c0);
    const c1 = Math.min(af.range.c1, p.c1);
    for (let c = c0; c <= c1; c++) {
      const x0 = this.xs[c - ce0];
      const x1 = this.xs[c - ce0 + 1];
      if (x1 <= x0) continue;
      const b = filterButtonRect(x0, y0, x1, y1, lw, L.dpr * L.zoom);
      if (b.size <= 2) continue;
      const filtered = af.filteredCols.includes(c);
      this.setFill(ctx, theme.filterButtonBorder);
      ctx.fillRect(b.x, b.y, b.size, b.size);
      this.setFill(ctx, theme.filterButtonBg);
      ctx.fillRect(b.x + lw, b.y + lw, b.size - 2 * lw, b.size - 2 * lw);
      this.setFill(ctx, filtered ? theme.filterActiveGlyph : theme.filterButtonGlyph);
      const cx = b.x + b.size / 2;
      const cy = b.y + b.size / 2;
      const u = b.size / 16;
      ctx.beginPath();
      if (filtered) {
        // Funnel + small arrow (Excel's "filter applied" glyph).
        ctx.moveTo(cx - 6 * u, cy - 5 * u);
        ctx.lineTo(cx + 2 * u, cy - 5 * u);
        ctx.lineTo(cx - 1 * u, cy - 1 * u);
        ctx.lineTo(cx - 1 * u, cy + 4 * u);
        ctx.lineTo(cx - 3 * u, cy + 5 * u);
        ctx.lineTo(cx - 3 * u, cy - 1 * u);
        ctx.closePath();
        ctx.moveTo(cx + 2 * u, cy + 1 * u);
        ctx.lineTo(cx + 7 * u, cy + 1 * u);
        ctx.lineTo(cx + 4.5 * u, cy + 4 * u);
        ctx.closePath();
      } else {
        ctx.moveTo(cx - 4 * u, cy - 2 * u);
        ctx.lineTo(cx + 4 * u, cy - 2 * u);
        ctx.lineTo(cx, cy + 3 * u);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  // -------------------------------------------------------------- headers

  /** Draw row/column headers, optionally restricted to a device-pixel clip. */
  private renderHeaders(ctx: CanvasRenderingContext2D, L: GridLayout, clip: DeviceRect | null): void {
    const { geom } = this.deps;
    const theme = this.theme;
    const { rows, cols } = geom;
    const dpr = L.dpr;
    const z = L.zoom;
    const lw = this.lineWidth(dpr);
    const hw = Math.round(L.headerW * dpr);
    const hh = Math.round(L.headerH * dpr);
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const font = `${Math.round(theme.headerFontSizePx * z * dpr * 10) / 10}px ${theme.headerFont}`;
    const mark = Math.max(2, Math.round(2 * dpr));
    const kx0 = clip ? clip.x0 : 0;
    const kx1 = clip ? clip.x1 : W;
    const ky0 = clip ? clip.y0 : 0;
    const ky1 = clip ? clip.y1 : H;
    if (clip) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(kx0, ky0, kx1 - kx0, ky1 - ky0);
      ctx.clip();
    }

    this.setFill(ctx, theme.headerBg);
    if (ky0 < hh) ctx.fillRect(kx0, 0, kx1 - kx0, hh);
    if (kx0 < hw) ctx.fillRect(0, ky0, hw, ky1 - ky0);
    this.setFont(ctx, font);
    this.setAlign(ctx, "center");
    ctx.textBaseline = "middle";

    // Column header segments: frozen columns + scrolling columns.
    const colPanes = L.panes.filter((p) => p.kind === (L.frozenH > 0 ? "corner" : "left") || p.kind === (L.frozenH > 0 ? "top" : "main"));
    for (const p of colPanes) {
      if (p.c1 < p.c0 || ky0 >= hh) continue;
      const sx0 = Math.round(p.x * dpr);
      const sx1 = Math.round((p.x + p.w) * dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx0, 0, sx1 - sx0, hh);
      ctx.clip();
      let off = cols.offsetOf(p.c0);
      for (let c = p.c0; c <= p.c1; c++) {
        const size = cols.sizeOf(c);
        const x0 = devX(L, p, off);
        off += size;
        const x1 = devX(L, p, off);
        if (x1 <= x0 || x1 <= kx0 - mark || x0 >= kx1 + mark) continue;
        this.setFill(ctx, theme.headerLine);
        ctx.fillRect(x1 - lw, 0, lw, hh);
        if (c > 0 && cols.isHidden(c - 1)) {
          // Hidden columns before this one: Excel's double line marker.
          this.setFill(ctx, theme.hiddenMarker);
          ctx.fillRect(x0 - lw - Math.floor(mark / 2), 0, mark, hh);
        }
        this.setFill(ctx, theme.headerText);
        ctx.fillText(colName(c), (x0 + x1 - lw) / 2, hh / 2);
      }
      this.restore(ctx);
    }

    // Row header segments: frozen rows + scrolling rows (hidden runs skipped).
    this.setFont(ctx, font);
    ctx.textBaseline = "middle";
    const rowPanes = L.panes.filter((p) => p.kind === (L.frozenW > 0 ? "corner" : "top") || p.kind === (L.frozenW > 0 ? "left" : "main"));
    for (const p of rowPanes) {
      if (p.r1 < p.r0 || kx0 >= hw) continue;
      const sy0 = Math.round(p.y * dpr);
      const sy1 = Math.round((p.y + p.h) * dpr);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sy0, hw, sy1 - sy0);
      ctx.clip();
      let r = rows.nextVisible(p.r0, 1);
      let off = r >= 0 ? rows.offsetOf(r) : 0;
      while (r >= 0 && r <= p.r1) {
        const size = rows.sizeOf(r);
        const y0 = devY(L, p, off);
        off += size;
        const y1 = devY(L, p, off);
        if (y1 > y0 && y1 > ky0 - mark && y0 < ky1 + mark) {
          this.setFill(ctx, theme.headerLine);
          ctx.fillRect(0, y1 - lw, hw, lw);
          if (r > 0 && rows.isHidden(r - 1)) {
            this.setFill(ctx, theme.hiddenMarker);
            ctx.fillRect(0, y0 - lw - Math.floor(mark / 2), hw, mark);
          }
          this.setFill(ctx, theme.headerText);
          ctx.fillText(String(r + 1), hw / 2, (y0 + y1 - lw) / 2);
        }
        r = r + 1 < rows.count ? rows.nextVisible(r + 1, 1) : -1;
      }
      this.restore(ctx);
    }
    ctx.textBaseline = "alphabetic";

    // Header outer edges.
    this.setFill(ctx, theme.headerLine);
    ctx.fillRect(0, hh - lw, W, lw);
    ctx.fillRect(hw - lw, 0, lw, H);
    if (clip) this.restore(ctx);
  }

  private renderFrozenLines(ctx: CanvasRenderingContext2D, L: GridLayout): void {
    const dpr = L.dpr;
    const lw = this.lineWidth(dpr);
    this.setFill(ctx, this.theme.frozenLine);
    if (L.frozenW > 0) ctx.fillRect(Math.round((L.headerW + L.frozenW) * dpr) - lw, 0, lw, ctx.canvas.height);
    if (L.frozenH > 0) ctx.fillRect(0, Math.round((L.headerH + L.frozenH) * dpr) - lw, ctx.canvas.width, lw);
  }
}

/** Device-pixel square of an autofilter button inside the cell (x0..x1, y0..y1). */
export function filterButtonRect(x0: number, y0: number, x1: number, y1: number, lw: number, scale: number): { x: number; y: number; size: number } {
  const size = Math.max(0, Math.min(Math.round(16 * scale), y1 - y0 - lw - 2, x1 - x0 - lw - 2));
  return { x: x1 - lw - 1 - size, y: y1 - lw - 1 - size, size };
}

export function effectiveAlign(h: HAlign, kind: number): Align {
  switch (h) {
    case "left":
    case "fill":
    case "justify":
      return "left";
    case "center":
    case "centerContinuous":
      return "center";
    case "right":
      return "right";
    default:
      if (kind === CellKind.Number) return "right";
      if (kind === CellKind.Bool || kind === CellKind.Error) return "center";
      return "left";
  }
}

function baselineY(st: ResolvedStyle, ascent: number, descent: number, y0: number, y1: number, padY: number): number {
  if (st.vAlign === "top") return y0 + padY + ascent;
  if (st.vAlign === "middle") return Math.round((y0 + y1) / 2 + (ascent - descent) / 2);
  return y1 - padY - descent + Math.round(descent * 0.35);
}

/** `sides` bit mask: 1 top, 2 right, 4 bottom, 8 left. */
function drawCellBorders(
  ctx: CanvasRenderingContext2D,
  st: ResolvedStyle,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  lw: number,
  sides: number,
  setFill: (c: string) => void,
): void {
  const side = (b: BorderSpec | null, horizontal: boolean, at: number, from: number, to: number) => {
    if (!b) return;
    const t = BORDER_WIDTH[b.style] * lw;
    const start = at - Math.floor((t - lw) / 2);
    setFill(b.color);
    if (b.style === "dashed" || b.style === "dotted" || b.style === "hair") {
      const dash = (b.style === "dashed" ? 3 : 1) * lw;
      const gap = lw;
      for (let v = from; v < to; v += dash + gap) {
        const len = Math.min(dash, to - v);
        if (horizontal) ctx.fillRect(v, start, len, t);
        else ctx.fillRect(start, v, t, len);
      }
    } else if (b.style === "double") {
      if (horizontal) {
        ctx.fillRect(from, start, to - from, lw);
        ctx.fillRect(from, start + 2 * lw, to - from, lw);
      } else {
        ctx.fillRect(start, from, lw, to - from);
        ctx.fillRect(start + 2 * lw, from, lw, to - from);
      }
    } else if (horizontal) ctx.fillRect(from, start, to - from, t);
    else ctx.fillRect(start, from, t, to - from);
  };
  if (sides & 1) side(st.borderTop, true, y0 - lw, x0 - lw, x1);
  if (sides & 4) side(st.borderBottom, true, y1 - lw, x0 - lw, x1);
  if (sides & 8) side(st.borderLeft, false, x0 - lw, y0 - lw, y1);
  if (sides & 2) side(st.borderRight, false, x1 - lw, y0 - lw, y1);
}
