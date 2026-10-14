import type { ChartId, ChartSpec, ChartType, EngineEvent, SheetMeta, WorkbookEngine } from "@/engine/contract";
import { rangesIntersect, type DocumentId, type SheetId } from "@/engine/types";
import type { GridHandle } from "@/grid/api";
import { ChartCanvas, renderChartPng } from "@/charts/chart-canvas";
import { chartDependencies, resolveChartData, type ChartData, type ChartDependency, type ChartLook } from "@/charts/data";
import { anchorToBox, boxToAnchor, type Box } from "@/charts/geometry";

/**
 * Imperative chart layer: one absolutely positioned element per chart inside
 * the grid's overlay host. Positions are updated on every viewport change
 * without React; canvases re-render only when size or data change.
 */
export interface ChartLayerCallbacks {
  /** Double click / "Editar": open the edit dialog. */
  onEdit(chart: ChartSpec): void;
  onContextMenu(chart: ChartSpec, clientX: number, clientY: number): void;
  onSelectionChange?(id: ChartId | null): void;
  /** Spanish, user-facing. */
  onError?(message: string): void;
}

export interface ChartLayerOptions {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  readonly grid: GridHandle;
  readonly readOnly: boolean;
  readonly callbacks: ChartLayerCallbacks;
}

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HANDLES: ReadonlyArray<{ id: Handle; left: string; top: string; cursor: string }> = [
  { id: "nw", left: "0%", top: "0%", cursor: "nwse-resize" },
  { id: "n", left: "50%", top: "0%", cursor: "ns-resize" },
  { id: "ne", left: "100%", top: "0%", cursor: "nesw-resize" },
  { id: "e", left: "100%", top: "50%", cursor: "ew-resize" },
  { id: "se", left: "100%", top: "100%", cursor: "nwse-resize" },
  { id: "s", left: "50%", top: "100%", cursor: "ns-resize" },
  { id: "sw", left: "0%", top: "100%", cursor: "nesw-resize" },
  { id: "w", left: "0%", top: "50%", cursor: "ew-resize" },
];

const MIN_SIZE = 24;
/** Attribute that marks chart UI outside the layer (menus, dialogs): clicks there keep the selection. */
export const CHART_UI_ATTR = "data-chart-ui";

interface Entry {
  spec: ChartSpec;
  data: ChartData | null;
  deps: ChartDependency[];
  readonly root: HTMLDivElement;
  readonly view: ChartCanvas;
  box: Box;
  dataGen: number;
  lookKey: string;
  dataKey: string;
}

interface DragState {
  readonly entry: Entry;
  readonly mode: "move" | Handle;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startBox: Box;
  box: Box;
  moved: boolean;
}

export function lookOf(spec: ChartSpec): ChartLook {
  return {
    type: spec.type,
    grouping: spec.grouping,
    title: spec.title,
    legend: spec.legend,
    xAxisTitle: spec.xAxisTitle,
    yAxisTitle: spec.yAxisTitle,
  };
}

/** `updateChart` payload: everything except `fromFile`. */
export function toUpdate(spec: ChartSpec): Omit<ChartSpec, "fromFile"> {
  const { fromFile: _fromFile, ...rest } = spec;
  void _fromFile;
  return rest;
}

/** Resize/move math for a drag (pure, exported for tests). */
export function dragBox(start: Box, mode: "move" | Handle, dx: number, dy: number, keepRatio: boolean): Box {
  if (mode === "move") return { x: start.x + dx, y: start.y + dy, w: start.w, h: start.h };
  let x0 = start.x;
  let y0 = start.y;
  let x1 = start.x + start.w;
  let y1 = start.y + start.h;
  if (mode.includes("w")) x0 = Math.min(x1 - MIN_SIZE, x0 + dx);
  if (mode.includes("e")) x1 = Math.max(x0 + MIN_SIZE, x1 + dx);
  if (mode.includes("n")) y0 = Math.min(y1 - MIN_SIZE, y0 + dy);
  if (mode.includes("s")) y1 = Math.max(y0 + MIN_SIZE, y1 + dy);
  if (keepRatio && mode.length === 2 && start.h > 0) {
    const ratio = start.w / start.h;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w / h > ratio) {
      const nw = h * ratio;
      if (mode.includes("w")) x0 = x1 - nw;
      else x1 = x0 + nw;
    } else {
      const nh = w / ratio;
      if (mode.includes("n")) y0 = y1 - nh;
      else y1 = y0 + nh;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export class ChartLayerController {
  private readonly entries = new Map<ChartId, Entry>();
  private sheets: ReadonlyArray<SheetMeta> = [];
  private selected: ChartId | null = null;
  private pendingSelect: ChartId | null = null;
  private drag: DragState | null = null;
  private loadGen = 0;
  private disposed = false;
  private readonly stale = new Set<ChartId>();
  private refreshFrame = 0;
  private positionFrame = 0;
  private readonly unsubs: Array<() => void> = [];
  private readonly frameEl: HTMLDivElement;

  constructor(private readonly opts: ChartLayerOptions) {
    this.frameEl = this.createFrame();
  }

  start(): void {
    const { engine, grid } = this.opts;
    this.unsubs.push(engine.subscribe(this.onEngineEvent));
    this.unsubs.push(grid.subscribeViewport(() => this.positionAll()));
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    this.unsubs.push(() => document.removeEventListener("pointerdown", this.onDocumentPointerDown, true));
    void this.reload();
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.refreshFrame) cancelAnimationFrame(this.refreshFrame);
    if (this.positionFrame) cancelAnimationFrame(this.positionFrame);
    for (const e of this.entries.values()) this.removeEntry(e);
    this.entries.clear();
  }

  getChart(id: ChartId): ChartSpec | null {
    return this.entries.get(id)?.spec ?? null;
  }

  getSelected(): ChartId | null {
    return this.selected;
  }

  getSheets(): ReadonlyArray<SheetMeta> {
    return this.sheets;
  }

  // ----- loading ---------------------------------------------------------

  async reload(): Promise<void> {
    const gen = ++this.loadGen;
    const { engine, doc, sheet } = this.opts;
    try {
      const [charts, info] = await Promise.all([engine.getCharts(doc, sheet), engine.getDocumentInfo(doc)]);
      if (gen !== this.loadGen || this.disposed) return;
      this.sheets = info.sheets;
      this.sync(charts);
    } catch {
      // Document closed or engine gone: keep what is shown.
    }
  }

  private sync(charts: ReadonlyArray<ChartSpec>): void {
    const seen = new Set<ChartId>();
    for (const spec of charts) {
      seen.add(spec.id);
      let entry = this.entries.get(spec.id);
      if (!entry) {
        entry = this.createEntry(spec);
        this.entries.set(spec.id, entry);
      }
      this.setSpec(entry, spec);
    }
    for (const [id, entry] of this.entries) {
      if (seen.has(id)) continue;
      this.removeEntry(entry);
      this.entries.delete(id);
      if (this.selected === id) this.select(null);
    }
    if (this.pendingSelect !== null && this.entries.has(this.pendingSelect)) {
      const id = this.pendingSelect;
      this.pendingSelect = null;
      this.select(id);
    }
    this.positionAll();
  }

  private setSpec(entry: Entry, spec: ChartSpec): void {
    entry.spec = spec;
    const lookKey = JSON.stringify(lookOf(spec));
    const dataKey = JSON.stringify([spec.sheet, spec.type, spec.series]);
    entry.deps = chartDependencies(spec, this.sheets);
    if (dataKey !== entry.dataKey) {
      entry.dataKey = dataKey;
      entry.lookKey = lookKey;
      entry.view.setContent(lookOf(spec), entry.data);
      void this.refreshData(entry);
    } else if (lookKey !== entry.lookKey) {
      entry.lookKey = lookKey;
      entry.view.setContent(lookOf(spec), entry.data);
    }
    entry.root.setAttribute("aria-label", spec.title ? `Gráfico: ${spec.title}` : "Gráfico");
  }

  private async refreshData(entry: Entry): Promise<void> {
    const gen = ++entry.dataGen;
    const { engine, doc } = this.opts;
    try {
      const data = await resolveChartData(engine, doc, entry.spec, this.sheets);
      if (gen !== entry.dataGen || this.disposed) return;
      entry.data = data;
      entry.view.setContent(lookOf(entry.spec), data);
    } catch {
      // Leave the previous data on screen.
    }
  }

  private markStale(id: ChartId): void {
    this.stale.add(id);
    if (this.refreshFrame) return;
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = 0;
      for (const sid of this.stale) {
        const e = this.entries.get(sid);
        if (e) void this.refreshData(e);
      }
      this.stale.clear();
    });
  }

  private readonly onEngineEvent = (event: EngineEvent): void => {
    if (this.disposed || event.doc !== this.opts.doc) return;
    switch (event.type) {
      case "charts":
        if (event.sheet === this.opts.sheet) void this.reload();
        break;
      case "cells":
        for (const e of this.entries.values()) {
          if (e.deps.some((d) => d.sheet === event.sheet && event.ranges.some((r) => rangesIntersect(r, d.range)))) {
            this.markStale(e.spec.id);
          }
        }
        break;
      case "sheetData":
        for (const e of this.entries.values()) {
          if (e.deps.some((d) => d.sheet === event.sheet)) this.markStale(e.spec.id);
        }
        break;
      case "sheets":
        this.sheets = event.sheets;
        for (const e of this.entries.values()) {
          e.deps = chartDependencies(e.spec, this.sheets);
          this.markStale(e.spec.id);
        }
        break;
      case "structure":
        // The engine moves anchors and rewrites refs; it also emits `charts`.
        void this.reload();
        break;
      case "sheetInfo":
        if (event.sheet === this.opts.sheet) this.schedulePosition();
        break;
      default:
        break;
    }
  };

  // ----- DOM -------------------------------------------------------------

  private createEntry(spec: ChartSpec): Entry {
    const root = document.createElement("div");
    root.className = "sl-chart";
    root.tabIndex = -1;
    root.setAttribute("role", "img");
    const s = root.style;
    s.position = "absolute";
    s.left = "0";
    s.top = "0";
    s.pointerEvents = "auto";
    s.userSelect = "none";
    s.touchAction = "none";
    s.outline = "none";
    s.background = "#FFFFFF";
    s.willChange = "transform";
    const view = new ChartCanvas();
    root.appendChild(view.canvas);
    const entry: Entry = {
      spec,
      data: null,
      deps: [],
      root,
      view,
      box: { x: 0, y: 0, w: 0, h: 0 },
      dataGen: 0,
      lookKey: "",
      dataKey: "",
    };
    root.addEventListener("pointerdown", (e) => this.onPointerDown(entry, e));
    root.addEventListener("pointermove", (e) => this.onPointerMove(e));
    root.addEventListener("pointerup", (e) => this.onPointerUp(e));
    root.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
    root.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.opts.readOnly) this.opts.callbacks.onEdit(entry.spec);
    });
    root.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.select(entry.spec.id);
      this.opts.callbacks.onContextMenu(entry.spec, e.clientX, e.clientY);
    });
    root.addEventListener("keydown", (e) => this.onKeyDown(entry, e));
    this.opts.grid.getOverlayHost().appendChild(root);
    return entry;
  }

  private removeEntry(entry: Entry): void {
    entry.view.dispose();
    entry.root.remove();
  }

  private createFrame(): HTMLDivElement {
    const frame = document.createElement("div");
    const s = frame.style;
    s.position = "absolute";
    s.inset = "0";
    s.border = "1px solid #A6A6A6";
    s.pointerEvents = "none";
    for (const h of HANDLES) {
      const el = document.createElement("div");
      el.dataset.handle = h.id;
      const hs = el.style;
      hs.position = "absolute";
      hs.left = h.left;
      hs.top = h.top;
      hs.width = "8px";
      hs.height = "8px";
      hs.margin = "-5px 0 0 -5px";
      hs.borderRadius = "50%";
      hs.background = "#FFFFFF";
      hs.border = "1px solid #7F7F7F";
      hs.boxShadow = "0 0 1px rgba(0,0,0,0.25)";
      hs.cursor = h.cursor;
      hs.pointerEvents = "auto";
      frame.appendChild(el);
    }
    return frame;
  }

  private schedulePosition(): void {
    if (this.positionFrame) return;
    this.positionFrame = requestAnimationFrame(() => {
      this.positionFrame = 0;
      this.positionAll();
    });
  }

  /** Recomputes every chart's box from its anchor (cheap: two rect lookups per chart). */
  positionAll(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (this.drag && this.drag.entry === entry) continue;
      this.applyBox(entry, anchorToBox(this.opts.grid, entry.spec.anchor));
    }
  }

  private applyBox(entry: Entry, box: Box): void {
    entry.box = box;
    const host = this.opts.grid.getOverlayHost();
    const s = entry.root.style;
    const offscreen =
      box.x > host.clientWidth + 8 || box.y > host.clientHeight + 8 || box.x + box.w < -8 || box.y + box.h < -8;
    const visible = !offscreen || this.drag?.entry === entry;
    s.display = visible ? "block" : "none";
    if (!visible) return;
    s.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
    const w = Math.max(1, Math.round(box.w));
    const h = Math.max(1, Math.round(box.h));
    s.width = `${w}px`;
    s.height = `${h}px`;
    entry.view.setSize(w, h, this.opts.grid.getViewport().zoom);
  }

  // ----- selection & interaction ------------------------------------------

  select(id: ChartId | null): void {
    if (this.selected === id) return;
    const prev = this.selected !== null ? this.entries.get(this.selected) : undefined;
    if (prev) prev.root.style.cursor = "";
    this.frameEl.remove();
    this.selected = id;
    const entry = id !== null ? this.entries.get(id) : undefined;
    if (entry) {
      entry.root.appendChild(this.frameEl);
      entry.root.style.cursor = this.opts.readOnly ? "default" : "move";
      // Bring to front while selected (Excel keeps z-order; this only helps hit-testing).
      entry.root.style.zIndex = "1";
      entry.root.focus({ preventScroll: true });
    }
    if (prev && prev !== entry) prev.root.style.zIndex = "";
    this.opts.callbacks.onSelectionChange?.(id);
  }

  private readonly onDocumentPointerDown = (e: PointerEvent): void => {
    if (this.selected === null) return;
    const target = e.target as Element | null;
    if (!target || !(target instanceof Element)) return;
    if (target.closest(".sl-chart") || target.closest(`[${CHART_UI_ATTR}]`)) return;
    this.select(null);
  };

  private onPointerDown(entry: Entry, e: PointerEvent): void {
    e.stopPropagation();
    if (e.button === 2) {
      this.select(entry.spec.id);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    this.select(entry.spec.id);
    if (this.opts.readOnly) return;
    const handle = (e.target as HTMLElement).dataset?.handle as Handle | undefined;
    entry.root.setPointerCapture(e.pointerId);
    this.drag = {
      entry,
      mode: handle ?? "move",
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startBox: entry.box,
      box: entry.box,
      moved: false,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.moved = true;
    drag.box = dragBox(drag.startBox, drag.mode, dx, dy, e.shiftKey);
    this.applyBox(drag.entry, drag.box);
  }

  private onPointerUp(e: PointerEvent, cancelled = false): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (drag.entry.root.hasPointerCapture(e.pointerId)) drag.entry.root.releasePointerCapture(e.pointerId);
    if (cancelled || !drag.moved) {
      this.applyBox(drag.entry, anchorToBox(this.opts.grid, drag.entry.spec.anchor));
      return;
    }
    const anchor = boxToAnchor(this.opts.grid, drag.box);
    const next: ChartSpec = { ...drag.entry.spec, anchor, fromFile: false };
    // Optimistic: keep the new position while the engine confirms.
    drag.entry.spec = next;
    this.applyBox(drag.entry, anchorToBox(this.opts.grid, anchor));
    void this.commit([{ type: "updateChart", chart: toUpdate(next) }]);
  }

  private onKeyDown(entry: Entry, e: KeyboardEvent): void {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (!this.opts.readOnly) void this.deleteChart(entry.spec.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.select(null);
      this.opts.grid.focus();
    } else if (e.key === "Enter" && !this.opts.readOnly) {
      e.preventDefault();
      e.stopPropagation();
      this.opts.callbacks.onEdit(entry.spec);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = entry.root.getBoundingClientRect();
      this.opts.callbacks.onContextMenu(entry.spec, r.left + 20, r.top + 20);
    }
  }

  // ----- mutations ---------------------------------------------------------

  private async commit(ops: Parameters<WorkbookEngine["apply"]>[1]): Promise<number[]> {
    try {
      const result = await this.opts.engine.apply(this.opts.doc, ops);
      return [...result.created];
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo modificar el gráfico.";
      this.opts.callbacks.onError?.(message);
      void this.reload();
      return [];
    }
  }

  async addChart(chart: Omit<ChartSpec, "id" | "fromFile">): Promise<ChartId | null> {
    const created = await this.commit([{ type: "addChart", chart }]);
    const id = created[0] ?? null;
    if (id !== null) {
      if (this.entries.has(id)) this.select(id);
      else this.pendingSelect = id;
    }
    return id;
  }

  async updateChart(spec: ChartSpec): Promise<void> {
    const entry = this.entries.get(spec.id);
    const next: ChartSpec = { ...spec, fromFile: false };
    if (entry) this.setSpec(entry, next);
    await this.commit([{ type: "updateChart", chart: toUpdate(next) }]);
  }

  async changeType(id: ChartId, type: ChartType, grouping: ChartSpec["grouping"]): Promise<void> {
    const spec = this.getChart(id);
    if (!spec) return;
    await this.updateChart({ ...spec, type, grouping });
  }

  async deleteChart(id: ChartId): Promise<void> {
    if (this.selected === id) this.select(null);
    this.opts.grid.focus();
    await this.commit([{ type: "deleteChart", sheet: this.opts.sheet, id }]);
  }

  /** Copies the chart as a PNG image to the system clipboard. */
  async copyAsImage(id: ChartId): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const zoom = this.opts.grid.getViewport().zoom || 1;
    const data = entry.data ?? (await resolveChartData(this.opts.engine, this.opts.doc, entry.spec, this.sheets));
    const blob = await renderChartPng(lookOf(entry.spec), data, entry.box.w / zoom, entry.box.h / zoom, 2);
    if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      this.opts.callbacks.onError?.("No se pudo copiar el gráfico como imagen.");
      return false;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch {
      this.opts.callbacks.onError?.("No se pudo copiar el gráfico como imagen.");
      return false;
    }
  }
}
