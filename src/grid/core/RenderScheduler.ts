import { BLOCK_COLS, BLOCK_ROWS, type BlockKey } from "@/engine/contract";
import type { BlockCache } from "../data/BlockCache";
import { devY, forEachVisibleBand, overflowColumns, paneDeviceRect } from "../geometry/layout";
import type { DeviceRect, GridLayout } from "../geometry/layout";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import type { BaseRenderer } from "../render/BaseRenderer";
import type { CanvasLayer } from "../render/CanvasLayer";
import type { OverlayRenderer, OverlayState } from "../render/OverlayRenderer";
import { FrameStats } from "./FrameStats";
import type { Viewport } from "./Viewport";

/** Cell layer must be fully repainted. */
export const LAYER_BASE = 1;
export const LAYER_OVERLAY = 2;
/** Cell layer changed only by scrolling (blit + exposed strips). */
export const LAYER_SCROLL = 4;
/** Some blocks arrived (repaint their rows only). */
export const LAYER_BLOCKS = 8;
/** Data went stale: re-ensure visible blocks (no repaint until they arrive). */
export const LAYER_DATA = 16;
export const LAYER_ALL = LAYER_BASE | LAYER_OVERLAY;
const BASE_ANY = LAYER_BASE | LAYER_SCROLL | LAYER_BLOCKS;

export interface SchedulerHost {
  readonly viewport: Viewport;
  readonly geom: SheetGeometry;
  cache(): BlockCache;
  overlayState(): OverlayState;
  /** Input animations (smooth wheel, auto-scroll, marquee). Return true to keep frames coming. */
  beforeFrame(now: number): boolean;
  /** After a frame that touched any layer. */
  afterFrame(L: GridLayout, drewBase: boolean, missingBlocks: number): void;
}

/**
 * Damage tracking + the rAF render loop. Decides per frame between a full
 * repaint, an incremental one (scroll blit + exposed strips + rows of
 * arrived blocks) or nothing, and keeps the block cache fed (visible set +
 * one screen of prefetch in the scroll direction).
 */
export class RenderScheduler {
  readonly stats = new FrameStats();
  /** How cell-layer frames were produced (diagnostics / benchmarks / tests). */
  readonly renderCounts = { full: 0, incremental: 0, skipped: 0 };
  /** Incremental cell-layer rendering. false forces full redraws (A/B benchmarks). */
  incremental = true;
  private dirty = LAYER_ALL;
  private rafId = 0;
  private disposed = false;
  private lastBaseLayout: GridLayout | null = null;
  private lastBaseGeomVersion = -1;
  private loadedKeys: BlockKey[] = [];
  /** Fires after each frame that drew the cell layer (benchmarks / readiness). */
  onFrameRendered: ((missingBlocks: number) => void) | null = null;

  constructor(
    private readonly host: SchedulerHost,
    private readonly baseLayer: CanvasLayer,
    private readonly overlayLayer: CanvasLayer,
    private readonly baseRenderer: BaseRenderer,
    private readonly overlayRenderer: OverlayRenderer,
  ) {}

  invalidate(layers: number = LAYER_ALL): void {
    if (this.disposed) return;
    this.dirty |= layers;
    this.requestFrame();
  }

  blocksLoaded(keys: ReadonlyArray<BlockKey>): void {
    for (const k of keys) this.loadedKeys.push(k);
    this.invalidate(keys.length > 0 ? LAYER_BLOCKS : LAYER_DATA);
  }

  /** A frame is scheduled (readiness checks in tests / benchmarks). */
  get framePending(): boolean {
    return this.rafId !== 0;
  }

  requestFrame(): void {
    if (this.rafId === 0 && !this.disposed) this.rafId = requestAnimationFrame(this.frame);
  }

  /** Forget the last painted layout (canvas content invalid). */
  reset(): void {
    this.lastBaseLayout = null;
    this.loadedKeys = [];
    this.invalidate(LAYER_ALL);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
  }

  // ------------------------------------------------------------- blocks

  private visibleBlocks(L: GridLayout, prefetch: boolean): BlockKey[] {
    const keys: BlockKey[] = [];
    const { geom, viewport } = this.host;
    const ext = viewport.extent();
    for (const p of L.panes) {
      if (p.r1 < p.r0 || p.c1 < p.c0) continue;
      let r0 = p.r0;
      let r1 = p.r1;
      let { ce0: c0, ce1: c1 } = overflowColumns(geom, p, L.zoom);
      if (prefetch) {
        if (!p.scrollsY && !p.scrollsX) continue;
        const dy = viewport.lastDy;
        const dx = viewport.lastDx;
        // One screen ahead in the direction of the last scroll movement.
        if (p.scrollsY && dy !== 0) {
          const ahead = geom.rows.indexAt(geom.rows.offsetOf(dy > 0 ? p.r1 : p.r0) + Math.sign(dy) * ext.viewH);
          if (dy > 0) {
            r0 = p.r1 + 1;
            r1 = ahead;
          } else {
            r1 = p.r0 - 1;
            r0 = ahead;
          }
        } else if (p.scrollsX && dx !== 0) {
          const ahead = geom.cols.indexAt(geom.cols.offsetOf(dx > 0 ? p.c1 : p.c0) + Math.sign(dx) * ext.viewW);
          if (dx > 0) {
            c0 = p.c1 + 1;
            c1 = ahead;
          } else {
            c1 = p.c0 - 1;
            c0 = ahead;
          }
        } else {
          continue;
        }
        if (r1 < r0 || c1 < c0) continue;
      }
      const bc0 = Math.floor(c0 / BLOCK_COLS);
      const bc1 = Math.floor(c1 / BLOCK_COLS);
      forEachVisibleBand(geom, r0, r1, BLOCK_ROWS, (br) => {
        for (let bc = bc0; bc <= bc1; bc++) keys.push({ br, bc });
      });
    }
    return keys;
  }

  /** Visible blocks that are still loading (readiness metrics). */
  private countMissing(L: GridLayout): number {
    const cache = this.host.cache();
    let n = 0;
    for (const p of L.panes) {
      if (p.r1 < p.r0 || p.c1 < p.c0) continue;
      const bc0 = Math.floor(p.c0 / BLOCK_COLS);
      const bc1 = Math.floor(p.c1 / BLOCK_COLS);
      forEachVisibleBand(this.host.geom, p.r0, p.r1, BLOCK_ROWS, (br) => {
        for (let bc = bc0; bc <= bc1; bc++) if (!cache.isKnownEmpty(br, bc) && !cache.get(br, bc)) n++;
      });
    }
    return n;
  }

  /**
   * Device rects to repaint for newly loaded blocks: the block's rows across
   * the full pane width (text from the block may overflow sideways), grown to
   * fully cover any merged cell touching those rows (a merge's content comes
   * from its top-left block but paints over all its rows).
   */
  private blockDamage(L: GridLayout, keys: ReadonlyArray<BlockKey>): DeviceRect[] {
    const rects: DeviceRect[] = [];
    const { geom } = this.host;
    const { rows } = geom;
    const lastCol = geom.cols.count - 1;
    for (const k of keys) {
      let r0 = k.br * BLOCK_ROWS;
      let r1 = r0 + BLOCK_ROWS - 1;
      let hasMerges = false;
      if (geom.merges.size > 0) {
        for (;;) {
          let g0 = r0;
          let g1 = r1;
          for (const m of geom.merges.query({ r0, c0: 0, r1, c1: lastCol })) {
            hasMerges = true;
            if (m.r0 < g0) g0 = m.r0;
            if (m.r1 > g1) g1 = m.r1;
          }
          if (g0 === r0 && g1 === r1) break;
          r0 = g0;
          r1 = g1;
        }
      }
      for (const p of L.panes) {
        const a = Math.max(r0, p.r0);
        const b = Math.min(r1, p.r1);
        if (a > b) continue;
        const { ce0, ce1 } = overflowColumns(geom, p, L.zoom);
        const c0 = k.bc * BLOCK_COLS;
        // Not in this pane's columns (merges may still carry its data into the pane).
        if (!hasMerges && (c0 > ce1 || c0 + BLOCK_COLS - 1 < ce0)) continue;
        const pr = paneDeviceRect(L, p);
        const y0 = Math.max(pr.y0, devY(L, p, rows.offsetOf(a)));
        const y1 = Math.min(pr.y1, devY(L, p, rows.endOf(b)));
        if (y1 > y0) addRect(rects, { x0: pr.x0, x1: pr.x1, y0, y1 });
      }
    }
    return rects;
  }

  /** Full or incremental repaint of the cell layer, depending on what changed. */
  private drawBase(L: GridLayout): void {
    const ctx = this.baseLayer.ctx;
    const prev = this.lastBaseLayout;
    const geomVersion = this.host.geom.version;
    const full = (this.dirty & LAYER_BASE) !== 0 || prev === null || !this.incremental || this.lastBaseGeomVersion !== geomVersion;
    const loaded = this.loadedKeys;
    this.loadedKeys = [];
    const rc = this.renderCounts;
    if (full) {
      this.baseRenderer.render(ctx, L);
      rc.full++;
    } else {
      const rects = loaded.length > 0 ? this.blockDamage(L, loaded) : [];
      const scrolled = prev !== L && (prev.scrollX !== L.scrollX || prev.scrollY !== L.scrollY);
      if (!scrolled && rects.length === 0) {
        rc.skipped++;
      } else if (this.baseRenderer.renderIncremental(ctx, prev, L, rects)) {
        rc.incremental++;
      } else {
        this.baseRenderer.render(ctx, L);
        rc.full++;
      }
    }
    this.lastBaseLayout = L;
    this.lastBaseGeomVersion = geomVersion;
  }

  private readonly frame = (now: number): void => {
    this.rafId = 0;
    if (this.disposed) return;
    const t0 = performance.now();
    const { viewport } = this.host;
    // Pick up a scrollbar drag that happened since the last scroll event, so
    // syncScrollbars() below never overwrites newer user input.
    viewport.readNative();
    const again = this.host.beforeFrame(now);

    let baseMs = 0;
    let overlayMs = 0;
    let missing = 0;
    let texts = 0;
    let drewBase = false;
    let L: GridLayout | null = null;
    if (this.dirty !== 0) {
      L = viewport.layout();
      const baseResized = this.baseLayer.resize(L.width, L.height, L.dpr);
      const overlayResized = this.overlayLayer.resize(L.width, L.height, L.dpr);
      if (baseResized || overlayResized) this.dirty |= LAYER_ALL;
      viewport.syncScrollbars();
      const cache = this.host.cache();
      if (this.dirty & (BASE_ANY | LAYER_DATA)) {
        const tb = performance.now();
        cache.ensure(this.visibleBlocks(L, false), 0);
        if (this.dirty & BASE_ANY) {
          this.drawBase(L);
          drewBase = true;
          if (this.baseRenderer.missing.length > 0) cache.ensure(this.baseRenderer.missing, 0);
          texts = this.baseRenderer.stats.texts;
        }
        cache.ensure(this.visibleBlocks(L, true), 1);
        baseMs = performance.now() - tb;
        missing = this.countMissing(L);
      }
      if (this.dirty & (LAYER_OVERLAY | BASE_ANY)) {
        const to = performance.now();
        this.overlayRenderer.render(this.overlayLayer.ctx, L, this.host.overlayState());
        overlayMs = performance.now() - to;
      }
      this.dirty = 0;
    }
    this.stats.record({ t: now, totalMs: performance.now() - t0, baseMs, overlayMs, missingBlocks: missing, texts, baseDrawn: drewBase });
    if (L) this.host.afterFrame(L, drewBase, missing);
    if (drewBase) this.onFrameRendered?.(missing);
    if (again) this.requestFrame();
  };
}

/** Add a full-width rect, merging with an existing one of the same columns when they overlap or touch. */
function addRect(rects: DeviceRect[], r: DeviceRect): void {
  for (let i = 0; i < rects.length; i++) {
    const q = rects[i];
    if (q.x0 === r.x0 && q.x1 === r.x1 && r.y0 <= q.y1 && q.y0 <= r.y1) {
      rects[i] = { x0: q.x0, x1: q.x1, y0: Math.min(q.y0, r.y0), y1: Math.max(q.y1, r.y1) };
      return;
    }
  }
  rects.push(r);
}
