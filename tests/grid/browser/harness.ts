import type { EngineOp } from "@/engine/contract";
import type { CellRange } from "@/engine/types";
import type { EditRequest, GridContextMenuEvent, GridProps, GridViewport } from "@/grid/api";
import { Grid } from "@/grid/core/Grid";
import { LIGHT_THEME } from "@/grid/render/theme";
import { createSelectionStore, singleCellSelection, type SelectionState, type SelectionStore } from "@/model/selection";
import { SyntheticEngine, type SyntheticOptions } from "./synthetic-engine";

/**
 * Page-side harness for the headless grid tests (`tests/grid/browser/*.test.ts`).
 * Mounts the real `Grid` over a `SyntheticEngine` and exposes `window.SL`
 * so Playwright can drive it with real input and inspect the canvases.
 */
export interface MountOptions extends SyntheticOptions {
  readonly width?: number;
  readonly height?: number;
  readonly zoom?: number;
  readonly incremental?: boolean;
  readonly readOnly?: boolean;
}

export interface HarnessLog {
  ops: EngineOp[][];
  edits: EditRequest[];
  menus: GridContextMenuEvent[];
  filters: number[];
  keys: string[];
  views: GridViewport[];
  picks: Array<{ range: CellRange; final: boolean }>;
}

/**
 * Skia's analytic anti-aliasing of non-axis-aligned shapes (rotated text)
 * differs by a few levels when the same shape is clipped differently (an
 * incremental strip edge vs. a full pane). Such pixels are counted apart
 * from real differences (missing / misplaced content).
 */
const AA_TOLERANCE = 40;

class Harness {
  grid: Grid | null = null;
  engine: SyntheticEngine | null = null;
  selection: SelectionStore | null = null;
  log: HarnessLog = emptyLog();
  /** Pixels of the last `diffAgainstFullRedraw` (debugging failures). */
  lastDiff: { before: Uint8ClampedArray; after: Uint8ClampedArray; width: number } | null = null;
  private host: HTMLDivElement | null = null;
  private props: GridProps | null = null;

  async mount(o: MountOptions = {}): Promise<void> {
    this.unmount();
    this.log = emptyLog();
    const engine = new SyntheticEngine(o);
    const info = await engine.newDocument();
    const sheet = info.activeSheet;
    const host = document.createElement("div");
    Object.assign(host.style, { position: "absolute", left: "0", top: "0", width: `${o.width ?? 800}px`, height: `${o.height ?? 500}px` });
    document.body.appendChild(host);
    const selection = createSelectionStore(singleCellSelection(sheet));
    const log = this.log;
    const props: GridProps = {
      engine,
      doc: info.doc,
      sheet,
      selection,
      readOnly: o.readOnly,
      initialView: o.zoom ? { topLeft: { row: o.frozenRows ?? 0, col: o.frozenCols ?? 0 }, zoom: o.zoom } : undefined,
      onApply: (ops) => log.ops.push(ops),
      onEditRequest: (r) => log.edits.push(r),
      onUnhandledKey: (e) => log.keys.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.key}`),
      onContextMenu: (e) => log.menus.push(e),
      onFilterButton: (col) => log.filters.push(col),
      onViewportChange: (v) => log.views.push(v),
    };
    const grid = new Grid(host, props, { incrementalRender: o.incremental !== false, theme: LIGHT_THEME });
    this.props = props;
    this.host = host;
    this.grid = grid;
    this.engine = engine;
    this.selection = selection;
    await grid.ready;
    await this.settle();
    // Chromium moves a canvas from GPU to CPU raster after the first readback;
    // read once now so every frame compared later uses the same rasterizer.
    this.pixels(this.baseCanvas());
    grid.scheduler.reset();
    await this.settle();
  }

  unmount(): void {
    this.grid?.dispose();
    this.host?.remove();
    this.grid = null;
    this.host = null;
  }

  private g(): Grid {
    if (!this.grid) throw new Error("not mounted");
    return this.grid;
  }

  /** Wait until no frame is pending, no block is in flight and the viewport is fully loaded. */
  async settle(maxFrames = 600): Promise<void> {
    const grid = this.g();
    let quiet = 0;
    for (let i = 0; i < maxFrames; i++) {
      await nextFrame();
      await new Promise((r) => setTimeout(r, 0));
      const busy = grid.scheduler.framePending || grid.cache().stats.inflight > 0;
      quiet = busy ? 0 : quiet + 1;
      if (quiet >= 3) return;
    }
    throw new Error("grid did not settle");
  }

  /** Scroll by sheet units through the grid (the same path as wheel/keyboard). */
  async scrollBy(dx: number, dy: number): Promise<void> {
    const vp = this.g().viewport;
    const s = vp.getScroll();
    vp.setScroll(s.x + dx, s.y + dy);
    await this.settle();
  }

  async setZoom(z: number): Promise<void> {
    this.g().setZoom(z);
    await this.settle();
  }

  private baseCanvas(): HTMLCanvasElement {
    const c = this.g().root.querySelector<HTMLCanvasElement>("canvas.sl-grid-base");
    if (!c) throw new Error("no base canvas");
    return c;
  }

  private pixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no ctx");
    return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /**
   * Compare the current (incrementally produced) cell layer with a full
   * redraw of the same state: `differing` pixels (real differences) and
   * `antialias` pixels (edge coverage within `AA_TOLERANCE`).
   */
  async diffAgainstFullRedraw(): Promise<{ differing: number; antialias: number; incremental: number; full: number; box: [number, number, number, number] | null }> {
    const grid = this.g();
    const canvas = this.baseCanvas();
    const before = this.pixels(canvas).slice();
    const counts = { ...grid.scheduler.renderCounts };
    grid.scheduler.reset();
    await this.settle();
    const after = this.pixels(canvas);
    this.lastDiff = { before, after, width: canvas.width };
    let differing = 0;
    let antialias = 0;
    let box: [number, number, number, number] | null = null;
    for (let i = 0; i < before.length; i += 4) {
      const d = Math.max(Math.abs(before[i] - after[i]), Math.abs(before[i + 1] - after[i + 1]), Math.abs(before[i + 2] - after[i + 2]), Math.abs(before[i + 3] - after[i + 3]));
      if (d === 0) continue;
      if (d <= AA_TOLERANCE) {
        antialias++;
        continue;
      }
      const x = (i / 4) % canvas.width;
      const y = Math.floor(i / 4 / canvas.width);
      box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
      differing++;
    }
    return { differing, antialias, incremental: counts.incremental, full: counts.full, box };
  }

  /** RGBA of a canvas pixel at CSS coordinates (base or overlay layer). */
  pixelAt(layer: "base" | "overlay", x: number, y: number): [number, number, number, number] {
    const sel = layer === "base" ? "canvas.sl-grid-base" : "canvas.sl-grid-overlay";
    const c = this.g().root.querySelector<HTMLCanvasElement>(sel);
    if (!c) throw new Error("no canvas");
    const dpr = window.devicePixelRatio || 1;
    const d = c.getContext("2d")?.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
    if (!d) throw new Error("no ctx");
    return [d[0], d[1], d[2], d[3]];
  }

  /** Center of a cell in page coordinates (null when not visible). */
  cellCenter(row: number, col: number): { x: number; y: number } | null {
    const r = this.g().getCellRect({ row, col });
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  }

  cellRect(row: number, col: number): { left: number; top: number; right: number; bottom: number } | null {
    const r = this.g().getCellRect({ row, col });
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }

  sel(): SelectionState {
    return this.g().selection();
  }

  view(): GridViewport {
    return this.g().getViewport();
  }

  layout(): { headerW: number; headerH: number; frozenW: number; frozenH: number } {
    const L = this.g().viewport.layout();
    return { headerW: L.headerW, headerH: L.headerH, frozenW: L.frozenW, frozenH: L.frozenH };
  }

  colWidth(col: number): number {
    return this.g().geom.cols.sizeOf(col);
  }

  a11y(): { announcement: string; role: string | null; active: string | null; label: string | null } {
    const grid = this.g();
    const id = grid.scroller.getAttribute("aria-activedescendant");
    const cell = id ? document.getElementById(id) : null;
    return { announcement: grid.a11yAnnouncement, role: grid.scroller.getAttribute("role"), active: id, label: cell?.getAttribute("aria-label") ?? null };
  }

  /** Frame cost summary (ms). */
  frameStats(): { avgMs: number; maxMs: number; frames: number } {
    return this.g().scheduler.stats.summary();
  }

  setPicker(on: boolean): void {
    const log = this.log;
    this.g().setReferencePicker(on ? { onPick: (range, final) => log.picks.push({ range, final }) } : null);
  }

  setMarquee(r: CellRange | null): void {
    this.g().setCopyMarquee(r);
  }

  setHighlights(on: boolean): void {
    this.g().setRefHighlights(on ? [{ range: { r0: 1, c0: 1, r1: 3, c1: 2 }, color: "#e11d48" }] : []);
  }

  overlayHostRect(): { left: number; top: number; width: number; height: number } {
    const r = this.g().getOverlayHost().getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  rangeRect(r: CellRange): { x: number; y: number; width: number; height: number } {
    const d = this.g().getRangeRect(r);
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }

  async autofit(cols: number[]): Promise<ReadonlyArray<number>> {
    return this.g().measureAutofit(cols);
  }

  focus(): void {
    this.g().focus();
  }

  /** Add a sheet to the document and show it (the `sheet` prop changes). */
  async switchToNewSheet(view?: GridViewport): Promise<number> {
    const engine = this.engine;
    const props = this.props;
    if (!engine || !props || !this.selection) throw new Error("not mounted");
    const res = await engine.apply(props.doc, [{ type: "addSheet" }]);
    const sheet = res.created[0];
    this.selection.set(singleCellSelection(sheet, { row: 5, col: 2 }));
    this.props = { ...props, sheet, initialView: view };
    this.g().update(this.props);
    await new Promise((r) => setTimeout(r, 50));
    await this.settle();
    return sheet;
  }

  dataSheet(): number | null {
    return this.g().data()?.sheet ?? null;
  }
}

function emptyLog(): HarnessLog {
  return { ops: [], edits: [], menus: [], filters: [], keys: [], views: [], picks: [] };
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

declare global {
  interface Window {
    SL: Harness;
  }
}

window.SL = new Harness();
document.title = "ready";
