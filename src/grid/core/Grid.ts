import type { BlockKey, EngineOp, SheetInfo } from "@/engine/contract";
import { rangeName, type CellAddress, type CellRange, type SheetId } from "@/engine/types";
import { singleCellSelection, type SelectionState, type SelectionStore } from "@/model/selection";
import type { EditRequest, GridContextMenuEvent, GridHandle, GridProps, GridViewport, RefHighlight, ReferencePicker } from "../api";
import { A11yLayer } from "../a11y/A11yLayer";
import { EngineDataSource } from "../data/DataSource";
import { BlockCache } from "../data/BlockCache";
import type { GridLayout } from "../geometry/layout";
import { SheetGeometry } from "../geometry/SheetGeometry";
import { GridInteractions, type InteractionHost } from "../input/GridInteractions";
import { handleKeyDown, type KeyboardContext } from "../input/keyboard";
import { NativeScrollbars } from "../input/NativeScrollbars";
import { PointerController, type PointerHost } from "../input/PointerController";
import { SmoothScroller } from "../input/SmoothScroller";
import { BaseRenderer } from "../render/BaseRenderer";
import { CanvasLayer } from "../render/CanvasLayer";
import { OverlayRenderer, withAlpha, type OverlayState, type ResolvedHighlight } from "../render/OverlayRenderer";
import { StyleResolver } from "../render/StyleResolver";
import { TextMeasurer } from "../render/TextMeasurer";
import { currentAppTheme, type GridTheme } from "../render/theme";
import { isSingleCell, sameSelection } from "../selection/selection";
import { visibleCell } from "../selection/navigation";
import { LAYER_ALL, LAYER_BASE, LAYER_DATA, LAYER_OVERLAY, LAYER_SCROLL, RenderScheduler, type SchedulerHost } from "./RenderScheduler";
import { Viewport } from "./Viewport";

export interface GridOptions {
  /** Incremental cell-layer rendering (scroll blit + dirty rows). Default true. */
  readonly incrementalRender?: boolean;
  /** Max cached blocks (64x16 cells each). Default 768. */
  readonly blockCacheCapacity?: number;
  /** Fixed theme; default follows the app (`dark` class on `<html>`). */
  readonly theme?: GridTheme;
}

const EMPTY_HIGHLIGHTS: ReadonlyArray<ResolvedHighlight> = [];

/**
 * Composition root of the grid: owns the DOM (two canvases + native
 * scroller + overlay host + a11y layer) and wires the parts together:
 * `EngineDataSource` (blocks, styles, SheetInfo, events), `Viewport`
 * (scroll/zoom/layout), `RenderScheduler` (damage + rAF), `GridInteractions`
 * + `PointerController` + keyboard (input), the `SelectionStore` (selection
 * lives in the model; the grid renders it and writes new states).
 * Implements the public `GridHandle`.
 */
export class Grid implements GridHandle, InteractionHost, PointerHost, SchedulerHost, KeyboardContext {
  /** Test/benchmark hook: called with every new grid (never used by the app). */
  static onCreate: ((grid: Grid) => void) | null = null;

  readonly geom = new SheetGeometry();
  readonly viewport: Viewport;
  readonly scheduler: RenderScheduler;
  readonly actions: GridInteractions;
  readonly root: HTMLDivElement;
  readonly scroller: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly overlayHost: HTMLDivElement;
  private readonly baseLayer: CanvasLayer;
  private readonly overlayLayer: CanvasLayer;
  private readonly scrollbars: NativeScrollbars;
  private readonly smooth: SmoothScroller;
  private readonly pointer: PointerController;
  private readonly measurer = new TextMeasurer();
  private readonly styles: StyleResolver;
  private readonly baseRenderer: BaseRenderer;
  private readonly overlayRenderer: OverlayRenderer;
  private readonly a11y: A11yLayer;
  private readonly resizeObserver: ResizeObserver;
  private readonly cleanups: Array<() => void> = [];
  private themeValue: GridTheme;
  private props: GridProps;
  private dataSource: EngineDataSource | null = null;
  private loadToken = 0;
  private unsubscribeSelection: (() => void) | null = null;
  private writingSelection = false;
  private highlights: ReadonlyArray<ResolvedHighlight> = EMPTY_HIGHLIGHTS;
  private pickerValue: ReferencePicker | null = null;
  private marquee: CellRange | null = null;
  private marqueePhase = 0;
  private marqueeTimer = 0;
  private cursorModeValue: "default" | "formatPainter" = "default";
  private resizeGuide: { axis: "col" | "row"; index: number } | null = null;
  private fillPreview: CellRange | null = null;
  private pickRange: CellRange | null = null;
  private readonly viewportListeners = new Set<(view: GridViewport) => void>();
  private lastNotifiedLayout: GridLayout | null = null;
  private lastViewport: GridViewport | null = null;
  private hostRect = { x: -1, y: -1, w: -1, h: -1 };
  private disposed = false;
  /** Resolves when the first sheet's SheetInfo is loaded and applied. */
  readonly ready: Promise<void>;

  constructor(host: HTMLElement, props: GridProps, private readonly options: GridOptions = {}) {
    this.props = props;
    this.themeValue = options.theme ?? currentAppTheme();
    const theme = this.themeValue;
    this.styles = new StyleResolver(theme, (id) => this.dataSource?.style(id) ?? {});

    // DOM: root > [base canvas, overlay canvas, scroller > spacer, overlay host, a11y]
    this.root = document.createElement("div");
    this.root.className = "sl-grid";
    Object.assign(this.root.style, { position: "absolute", inset: "0", overflow: "hidden", background: theme.background, contain: "strict" });
    host.appendChild(this.root);
    this.baseLayer = new CanvasLayer(this.root, true, "sl-grid-base");
    this.overlayLayer = new CanvasLayer(this.root, false, "sl-grid-overlay");
    this.scroller = document.createElement("div");
    this.scroller.className = "sl-grid-scroller";
    this.scroller.tabIndex = 0;
    Object.assign(this.scroller.style, { position: "absolute", inset: "0", overflow: "scroll", outline: "none", cursor: "cell", overflowAnchor: "none", colorScheme: theme.name });
    this.spacer = document.createElement("div");
    Object.assign(this.spacer.style, { width: "1px", height: "1px", pointerEvents: "none" });
    this.scroller.appendChild(this.spacer);
    this.root.appendChild(this.scroller);
    this.overlayHost = document.createElement("div");
    this.overlayHost.className = "sl-grid-overlay-host";
    Object.assign(this.overlayHost.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", overflow: "hidden", pointerEvents: "none" });
    this.root.appendChild(this.overlayHost);
    this.a11y = new A11yLayer(this.root, this.scroller);
    this.a11y.setReadOnly(props.readOnly === true);

    this.scrollbars = new NativeScrollbars(this.scroller, this.spacer);
    this.viewport = new Viewport(this.geom, this.scrollbars, this.measurer, this.styles, theme, (what) =>
      this.scheduler.invalidate(what === "scroll" ? LAYER_SCROLL | LAYER_OVERLAY : LAYER_ALL),
    );
    this.baseRenderer = new BaseRenderer({ geom: this.geom, cache: () => this.cache(), styles: this.styles, measurer: this.measurer }, theme);
    this.overlayRenderer = new OverlayRenderer(this.geom, theme);
    this.scheduler = new RenderScheduler(this, this.baseLayer, this.overlayLayer, this.baseRenderer, this.overlayRenderer);
    this.scheduler.incremental = options.incrementalRender !== false;
    this.smooth = new SmoothScroller(this.viewport);
    this.actions = new GridInteractions(this);
    this.pointer = new PointerController(this);

    this.listen(this.scroller, "scroll", () => {
      if (this.viewport.readNative()) this.smooth.cancel();
    }, { passive: true });
    this.listen(this.scroller, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(this.overlayHost, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(this.scroller, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    this.cleanups.push(this.pointer.attach(this.scroller));
    this.resizeObserver = new ResizeObserver(() => this.scheduler.invalidate(LAYER_ALL));
    this.resizeObserver.observe(this.root);
    this.watchDpr();
    if (!options.theme) this.watchAppTheme();

    this.subscribeSelection(props.selection);
    this.ready = this.loadSheet(props.sheet, props.initialView ?? null);
    this.scheduler.invalidate(LAYER_ALL);
    Grid.onCreate?.(this);
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  private watchDpr(): void {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onChange = () => {
      this.scheduler.invalidate(LAYER_ALL);
      this.watchDpr();
    };
    mq.addEventListener("change", onChange, { once: true });
    this.cleanups.push(() => mq.removeEventListener("change", onChange));
  }

  private watchAppTheme(): void {
    const obs = new MutationObserver(() => this.setTheme(currentAppTheme()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    this.cleanups.push(() => obs.disconnect());
  }

  setTheme(theme: GridTheme): void {
    if (theme === this.themeValue) return;
    this.themeValue = theme;
    this.styles.setTheme(theme);
    this.baseRenderer.setTheme(theme);
    this.overlayRenderer.setTheme(theme);
    this.viewport.setTheme(theme);
    this.root.style.background = theme.background;
    this.scroller.style.colorScheme = theme.name;
    this.scheduler.invalidate(LAYER_ALL);
  }

  get theme(): GridTheme {
    return this.themeValue;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    this.resizeObserver.disconnect();
    window.clearInterval(this.marqueeTimer);
    for (const c of this.cleanups) c();
    this.unsubscribeSelection?.();
    this.dataSource?.dispose();
    this.a11y.dispose();
    this.root.remove();
    this.viewportListeners.clear();
  }

  // ------------------------------------------------------------- props

  /** New props from the React host. Engine/doc changes need a new Grid (the host remounts). */
  update(next: GridProps): void {
    const prev = this.props;
    this.props = next;
    if (next.selection !== prev.selection) {
      this.subscribeSelection(next.selection);
      this.onSelectionChanged(true);
    }
    if (next.sheet !== prev.sheet) void this.loadSheet(next.sheet, next.initialView ?? null);
    if ((next.readOnly === true) !== (prev.readOnly === true)) {
      this.a11y.setReadOnly(next.readOnly === true);
      this.scheduler.invalidate(LAYER_OVERLAY);
    }
  }

  get sheet(): SheetId {
    return this.props.sheet;
  }

  get readOnly(): boolean {
    return this.props.readOnly === true;
  }

  data(): EngineDataSource | null {
    return this.dataSource;
  }

  cache(): BlockCache {
    return this.dataSource?.cache ?? EMPTY_CACHE;
  }

  /**
   * Load a sheet: build its data source, fetch SheetInfo, then swap
   * atomically (the previous sheet stays on screen until the new one is ready).
   */
  private async loadSheet(sheet: SheetId, view: GridViewport | null): Promise<void> {
    const token = ++this.loadToken;
    const source: EngineDataSource = new EngineDataSource(this.props.engine, this.props.doc, sheet, {
      onBlocksLoaded: (keys) => this.onBlocksLoaded(source, keys),
      onDataInvalidated: () => {
        if (source === this.dataSource) this.scheduler.invalidate(LAYER_DATA);
      },
      onSheetInfo: (info) => {
        if (source === this.dataSource) this.applyInfo(info, false);
      },
      onStructure: (axis, insert, index, count) => {
        if (source === this.dataSource) this.onStructure(axis, insert, index, count);
      },
      onStylesChanged: () => {
        if (source !== this.dataSource) return;
        this.styles.reset();
        this.scheduler.invalidate(LAYER_ALL);
      },
    }, { blockCacheCapacity: this.options.blockCacheCapacity });
    let info: SheetInfo;
    try {
      info = await source.load();
    } catch {
      source.dispose();
      return;
    }
    if (this.disposed || token !== this.loadToken) {
      source.dispose();
      return;
    }
    const old = this.dataSource;
    this.dataSource = source;
    old?.dispose();
    this.applyInfo(info, true);
    if (view) {
      this.viewport.setZoom(view.zoom);
      this.viewport.scrollToTopLeft(view.topLeft);
    } else {
      this.viewport.scrollToTopLeft({ row: 0, col: 0 });
    }
    this.scheduler.reset();
    this.onSelectionChanged(false);
  }

  private applyInfo(info: SheetInfo, initial: boolean): void {
    this.geom.apply(info);
    const used = info.usedRange;
    this.viewport.setUsedEnd(used ? { row: used.r1, col: used.c1 } : { row: 0, col: 0 });
    this.viewport.invalidateLayout();
    if (!initial) this.scheduler.invalidate(LAYER_ALL);
  }

  private onStructure(axis: "row" | "col", insert: boolean, index: number, count: number): void {
    (axis === "row" ? this.geom.rows : this.geom.cols).shift(index, count, insert);
    this.geom.merges.shift(axis, index, count, insert);
    this.geom.touch();
    this.scheduler.reset();
  }

  private onBlocksLoaded(source: EngineDataSource, keys: ReadonlyArray<BlockKey>): void {
    if (source !== this.dataSource) return;
    this.scheduler.blocksLoaded(keys);
    this.updateA11y();
  }

  // ----------------------------------------------------------- selection

  private subscribeSelection(store: SelectionStore): void {
    this.unsubscribeSelection?.();
    this.unsubscribeSelection = store.subscribe(() => this.onSelectionChanged(!this.writingSelection));
  }

  /** The selection of this sheet (a default when the store holds another sheet's state). */
  selection(): SelectionState {
    const s = this.props.selection.get();
    if (s.sheet === this.sheet && s.ranges.length > 0) return s;
    return singleCellSelection(this.sheet, visibleCell(this.geom, { row: this.geom.frozenRows, col: this.geom.frozenCols }));
  }

  setSelection(next: SelectionState): void {
    const cur = this.props.selection.get();
    if (sameSelection(cur, next)) return;
    this.writingSelection = true;
    try {
      this.props.selection.set(next);
    } finally {
      this.writingSelection = false;
    }
  }

  private onSelectionChanged(external: boolean): void {
    if (this.disposed) return;
    const s = this.props.selection.get();
    if (external && s.sheet === this.sheet) this.viewport.ensureVisible(s.active);
    this.scheduler.invalidate(LAYER_OVERLAY);
    this.updateA11y();
  }

  private updateA11y(): void {
    const s = this.selection();
    const a = s.active;
    const data = this.dataSource;
    const text = data && data.isCellLoaded(a.row, a.col) ? (data.cellText(a.row, a.col) ?? "") : null;
    const r = s.ranges[s.activeRange];
    const label = s.ranges.length > 1 ? `${s.ranges.length} rangos seleccionados` : r && !isSingleCell(s, this.geom.merges) ? `${rangeName(r)} seleccionado` : null;
    this.a11y.update(a, text, label);
  }

  /** Last announced text (tests). */
  get a11yAnnouncement(): string {
    return this.a11y.announcement;
  }

  // ------------------------------------------------- interaction host API

  picker(): ReferencePicker | null {
    return this.pickerValue;
  }

  apply(ops: EngineOp[]): void {
    if (ops.length > 0) this.props.onApply(ops);
  }

  editRequest(req: EditRequest): void {
    this.props.onEditRequest(req);
  }

  unhandledKey(e: KeyboardEvent): void {
    this.props.onUnhandledKey?.(e);
  }

  contextMenu(e: GridContextMenuEvent): void {
    this.props.onContextMenu?.(e);
  }

  filterButton(col: number, anchor: DOMRect): void {
    this.props.onFilterButton?.(col, anchor);
  }

  resizeAxis(axis: "row" | "col", index: number, size: number): void {
    (axis === "col" ? this.geom.cols : this.geom.rows).setSize(index, Math.max(1, size));
    this.viewport.invalidateLayout();
    this.scheduler.invalidate(LAYER_ALL);
  }

  unhideLocally(axis: "row" | "col", index: number): void {
    const a = axis === "col" ? this.geom.cols : this.geom.rows;
    if (a.isHidden(index)) a.setHidden(index, false);
  }

  setResizeGuide(guide: { axis: "col" | "row"; index: number } | null): void {
    this.resizeGuide = guide;
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  setFillPreview(range: CellRange | null): void {
    this.fillPreview = range;
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  setPick(range: CellRange | null): void {
    this.pickRange = range;
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  cursorMode(): "default" | "formatPainter" {
    return this.cursorModeValue;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  requestFrame(): void {
    this.scheduler.requestFrame();
  }

  revealActive(): void {
    this.viewport.ensureVisible(this.selection().active);
  }

  contextMenuAtActive(): void {
    const s = this.selection();
    const rect = this.getCellRect(s.active);
    const r = this.root.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : r.left + 40;
    const y = rect ? rect.top + rect.height / 2 : r.top + 20;
    this.actions.contextMenuAt("cell", s.active, x, y);
  }

  // ------------------------------------------------------ scheduler host

  overlayState(): OverlayState {
    const sel = this.selection();
    return {
      selection: sel,
      resize: this.resizeGuide,
      fillPreview: this.fillPreview,
      highlights: this.highlights,
      pick: this.pickRange,
      marquee: this.marquee,
      marqueePhase: this.marqueePhase,
      showFillHandle: !this.readOnly && !this.pickerValue && sel.ranges.length === 1 && sel.kind === "cells",
    };
  }

  beforeFrame(now: number): boolean {
    const a = this.smooth.step(now);
    const b = this.pointer.stepAutoScroll(now);
    return a || b;
  }

  afterFrame(L: GridLayout): void {
    // Overlay host: the cell area below the headers, excluding the native scrollbars.
    const hr = this.hostRect;
    const w = Math.max(0, L.width - L.headerW);
    const h = Math.max(0, L.height - L.headerH);
    if (hr.x !== L.headerW || hr.y !== L.headerH || hr.w !== w || hr.h !== h) {
      this.hostRect = { x: L.headerW, y: L.headerH, w, h };
      Object.assign(this.overlayHost.style, { left: `${L.headerW}px`, top: `${L.headerH}px`, width: `${w}px`, height: `${h}px` });
    }
    if (L !== this.lastNotifiedLayout) {
      this.lastNotifiedLayout = L;
      const view = this.getViewport();
      for (const l of this.viewportListeners) l(view);
      const last = this.lastViewport;
      if (!last || last.zoom !== view.zoom || last.topLeft.row !== view.topLeft.row || last.topLeft.col !== view.topLeft.col) {
        this.lastViewport = view;
        this.props.onViewportChange?.(view);
      }
    }
  }

  // ------------------------------------------------------------- input

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) {
      const step = e.deltaY < 0 ? 0.1 : -0.1;
      this.setZoom(Math.round((this.viewport.zoom + step) * 10) / 10);
      return;
    }
    this.smooth.onWheel(e, performance.now());
    this.scheduler.requestFrame();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.pointer.dragging) {
      e.preventDefault();
      return;
    }
    const result = handleKeyDown(this, e);
    if (result === "handled") {
      e.preventDefault();
      this.smooth.cancel();
    } else if (result === "unhandled") {
      this.unhandledKey(e);
    }
  }

  // ------------------------------------------------------- GridHandle

  focus(): void {
    this.scroller.focus({ preventScroll: true });
  }

  getCellRect(cell: CellAddress): DOMRect | null {
    const r = this.viewport.cellRect(cell);
    if (!r) return null;
    const b = this.root.getBoundingClientRect();
    return new DOMRect(b.left + r.x, b.top + r.y, r.w, r.h);
  }

  scrollIntoView(cell: CellAddress): void {
    this.smooth.cancel();
    this.viewport.ensureVisible(cell);
  }

  getViewport(): GridViewport {
    return { topLeft: this.viewport.topLeft(), zoom: this.viewport.zoom };
  }

  setZoom(zoom: number): void {
    this.smooth.cancel();
    this.viewport.setZoom(zoom);
  }

  setRefHighlights(highlights: ReadonlyArray<RefHighlight>): void {
    this.highlights = highlights.length === 0 ? EMPTY_HIGHLIGHTS : highlights.map((h) => ({ range: h.range, border: h.color, fill: withAlpha(h.color, 0.12) }));
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  setReferencePicker(picker: ReferencePicker | null): void {
    this.pickerValue = picker;
    if (!picker) this.pickRange = null;
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  setCopyMarquee(range: CellRange | null): void {
    this.marquee = range;
    window.clearInterval(this.marqueeTimer);
    this.marqueeTimer = 0;
    if (range) {
      // Marching ants: only the overlay layer repaints, ~12 times per second.
      this.marqueeTimer = window.setInterval(() => {
        this.marqueePhase = (this.marqueePhase + 2 * (window.devicePixelRatio || 1)) % 64;
        this.scheduler.invalidate(LAYER_OVERLAY);
      }, 80);
    }
    this.scheduler.invalidate(LAYER_OVERLAY);
  }

  setCursorMode(mode: "default" | "formatPainter"): void {
    if (mode === this.cursorModeValue) return;
    this.cursorModeValue = mode;
    this.pointer.resetCursor(this.scroller);
  }

  async measureAutofit(cols: ReadonlyArray<number>): Promise<ReadonlyArray<number>> {
    const data = this.dataSource;
    if (!data) return cols.map((c) => this.geom.cols.storedSizeOf(c));
    const theme = this.themeValue;
    const unit = new StyleResolver(theme, (id) => data.style(id));
    unit.setScale(1);
    const af = this.geom.autoFilter;
    const out: number[] = [];
    for (const col of cols) {
      const samples = await data.columnSamples(col, 64);
      if (samples.length === 0) {
        out.push(this.geom.cols.defaultSize);
        continue;
      }
      let max = 0;
      for (const s of samples) max = Math.max(max, this.measurer.measure(unit.get(s.styleId).font, s.text));
      const button = af && col >= af.range.c0 && col <= af.range.c1 ? 18 : 0;
      out.push(Math.ceil(max + 2 * theme.cellPaddingX + 3 + button));
    }
    return out;
  }

  getRangeRect(range: CellRange): DOMRect {
    const r = this.viewport.rangeRect(range);
    const L = this.viewport.layout();
    return new DOMRect(r.x - L.headerW, r.y - L.headerH, r.w, r.h);
  }

  getOverlayHost(): HTMLElement {
    return this.overlayHost;
  }

  subscribeViewport(listener: (view: GridViewport) => void): () => void {
    this.viewportListeners.add(listener);
    return () => {
      this.viewportListeners.delete(listener);
    };
  }

  // --------------------------------------------------- invalidation API

  /** Full repaint (tests / benchmarks). */
  invalidate(): void {
    this.scheduler.invalidate(LAYER_BASE | LAYER_OVERLAY);
  }
}

/** Used before the first sheet is loaded: everything is known-empty (blank grid). */
const EMPTY_CACHE = new BlockCache(async () => [], 1, () => undefined);
