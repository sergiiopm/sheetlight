import { BLOCK_COLS, BLOCK_ROWS, CellKind, type BlockKey, type CellBlock, type CellStyle, type EngineEvent, type SheetInfo, type TextSample, type WorkbookEngine } from "@/engine/contract";
import { rangeUnion, type CellAddress, type CellRange, type Direction, type DocumentId, type SheetId, type StyleId } from "@/engine/types";
import { BlockCache } from "./BlockCache";
import { visibleDataEdge, type EdgeAxis } from "./dataEdge";
import { cellIndex, toGridBlock, type GridBlock } from "./GridBlock";

/** What the grid wants to hear about data changes. */
export interface DataSourceListener {
  /** Blocks arrived (repaint their rows). Empty list = cache state changed, just re-ensure. */
  onBlocksLoaded(keys: ReadonlyArray<BlockKey>): void;
  /** Cached blocks went stale (edit/recalc): repaint & refetch what is visible. */
  onDataInvalidated(): void;
  /** SheetInfo changed (sizes, hidden, merges, frozen, gridlines, autofilter, used range). */
  onSheetInfo(info: SheetInfo, previous: SheetInfo | null): void;
  /** Rows/cols inserted or deleted; geometry must shift before the refetch. */
  onStructure(axis: "row" | "col", insert: boolean, index: number, count: number): void;
  /** Style definitions changed meaning. */
  onStylesChanged(): void;
}

export interface DataSourceOptions {
  /** Max cached blocks (64x16 cells each). */
  readonly blockCacheCapacity?: number;
}

const DEFAULT_STYLE: CellStyle = Object.freeze({});

/**
 * Adapter between the grid and one sheet of a `WorkbookEngine` document:
 * block cache (with `knownVersions`), style table, SheetInfo (re)loading,
 * engine events filtered by doc/sheet, data-edge and autofit queries.
 * DOM-free (unit-tested against `MemoryEngine`).
 */
export class EngineDataSource {
  readonly cache: BlockCache;
  private readonly styles = new Map<StyleId, CellStyle>([[0, DEFAULT_STYLE]]);
  private readonly pendingStyles = new Map<StyleId, Promise<void>>();
  private infoValue: SheetInfo | null = null;
  private usedRange: CellRange | null = null;
  private reloadRunning = false;
  private reloadAgain = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  /** Number of style refreshes so far (lets consumers drop resolved-style caches). */
  stylesVersion = 0;

  constructor(
    readonly engine: WorkbookEngine,
    readonly doc: DocumentId,
    readonly sheet: SheetId,
    private readonly listener: DataSourceListener,
    options: DataSourceOptions = {},
  ) {
    this.cache = new BlockCache(
      (keys, knownVersions, priority) => this.fetch(keys, knownVersions, priority),
      options.blockCacheCapacity ?? 768,
      (keys) => this.listener.onBlocksLoaded(keys),
    );
    this.unsubscribe = engine.subscribe((e) => this.onEvent(e));
  }

  get info(): SheetInfo | null {
    return this.infoValue;
  }

  /** Bounding box of data as far as the grid knows (SheetInfo + later `cells` events). */
  get used(): CellRange | null {
    return this.usedRange;
  }

  /** Initial load of the sheet's SheetInfo. */
  async load(): Promise<SheetInfo> {
    const info = await this.engine.getSheetInfo(this.doc, this.sheet);
    if (!this.disposed) this.setInfo(info);
    return info;
  }

  private setInfo(info: SheetInfo): void {
    const previous = this.infoValue;
    this.infoValue = info;
    this.usedRange = info.usedRange;
    this.cache.setUsedRange(info.usedRange);
    this.listener.onSheetInfo(info, previous);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.cache.dispose();
  }

  // ---------------------------------------------------------------- styles

  style(id: StyleId): CellStyle {
    return this.styles.get(id) ?? DEFAULT_STYLE;
  }

  hasStyle(id: StyleId): boolean {
    return this.styles.has(id);
  }

  /** Loads unknown style definitions (deduplicated across concurrent calls). */
  async ensureStyles(ids: Iterable<StyleId>): Promise<void> {
    const wait: Promise<void>[] = [];
    const missing: StyleId[] = [];
    for (const id of ids) {
      if (this.styles.has(id)) continue;
      const p = this.pendingStyles.get(id);
      if (p) wait.push(p);
      else missing.push(id);
    }
    if (missing.length > 0) {
      const p = this.engine.getStyles(this.doc, missing).then(
        (entries) => {
          for (const [id, st] of entries) this.styles.set(id, st);
          // Unknown to the engine: remember as default so we don't ask again.
          for (const id of missing) if (!this.styles.has(id)) this.styles.set(id, DEFAULT_STYLE);
        },
        () => undefined,
      ).finally(() => {
        for (const id of missing) this.pendingStyles.delete(id);
      });
      for (const id of missing) this.pendingStyles.set(id, p);
      wait.push(p);
    }
    if (wait.length > 0) await Promise.all(wait);
  }

  private async refreshStyles(): Promise<void> {
    const ids = [...this.styles.keys()].filter((id) => id !== 0);
    if (ids.length === 0) return;
    const entries = await this.engine.getStyles(this.doc, ids);
    if (this.disposed) return;
    for (const [id, st] of entries) this.styles.set(id, st);
    this.stylesVersion++;
    this.listener.onStylesChanged();
  }

  // ---------------------------------------------------------------- blocks

  private async fetch(keys: ReadonlyArray<BlockKey>, knownVersions: ReadonlyArray<number> | undefined, priority: 0 | 1): Promise<GridBlock[]> {
    const blocks = await this.engine.fetchBlocks(this.doc, { sheet: this.sheet, keys, knownVersions, priority });
    const own = blocks.filter((b) => b.sheet === this.sheet);
    const unknown = new Set<StyleId>();
    for (const b of own) collectUnknownStyles(b, this.styles, unknown);
    // Hold the blocks until their styles are known: no flash of unstyled content.
    if (unknown.size > 0) await this.ensureStyles(unknown);
    return own.map(toGridBlock);
  }

  /** One block straight from the engine (data-edge probing), bypassing the cache. */
  private async probeBlock(br: number, bc: number): Promise<GridBlock | null> {
    const cached = this.cache.get(br, bc);
    if (cached && !this.cache.isStale(br, bc)) return cached;
    if (this.cache.isKnownEmpty(br, bc)) return null;
    const blocks = await this.engine.fetchBlocks(this.doc, { sheet: this.sheet, keys: [{ br, bc }], priority: 0 });
    const b = blocks.find((x) => x.br === br && x.bc === bc && x.sheet === this.sheet);
    return b ? toGridBlock(b) : (cached ?? null);
  }

  /** Display text of a cell if its block is cached (null if empty or not loaded). */
  cellText(row: number, col: number): string | null {
    const b = this.cache.get(Math.floor(row / BLOCK_ROWS), Math.floor(col / BLOCK_COLS));
    return b ? b.texts[cellIndex(row, col)] : null;
  }

  /** True when the cell's block is loaded (or known empty). */
  isCellLoaded(row: number, col: number): boolean {
    const br = Math.floor(row / BLOCK_ROWS);
    const bc = Math.floor(col / BLOCK_COLS);
    return this.cache.isKnownEmpty(br, bc) || this.cache.get(br, bc) !== undefined;
  }

  // --------------------------------------------------------------- queries

  /** Excel Ctrl+Arrow target, skipping hidden rows/cols. */
  findDataEdge(from: CellAddress, dir: Direction, rows: EdgeAxis, cols: EdgeAxis): Promise<CellAddress> {
    return visibleDataEdge(
      {
        rawEdge: (f, d) => this.engine.findDataEdge(this.doc, this.sheet, f, d),
        filled: async (row, col) => {
          const b = await this.probeBlock(Math.floor(row / BLOCK_ROWS), Math.floor(col / BLOCK_COLS));
          if (!b) return false;
          const i = cellIndex(row, col);
          return b.texts[i] !== null || (b.kinds[i] !== CellKind.Empty && b.kinds[i] !== CellKind.Pending);
        },
      },
      rows,
      cols,
      from,
      dir,
    );
  }

  /** Longest display strings of a column (autofit), with their styles loaded. */
  async columnSamples(col: number, limit: number): Promise<TextSample[]> {
    const samples = await this.engine.getColumnTextSamples(this.doc, this.sheet, col, limit);
    await this.ensureStyles(samples.map((s) => s.styleId));
    return samples;
  }

  // ---------------------------------------------------------------- events

  private onEvent(e: EngineEvent): void {
    if (this.disposed || !("doc" in e) || e.doc !== this.doc) return;
    switch (e.type) {
      case "cells":
        if (e.sheet !== this.sheet) return;
        if (e.ranges.length === 0) return;
        for (const r of e.ranges) {
          this.cache.growUsedRange(r);
          this.usedRange = this.usedRange ? rangeUnion(this.usedRange, r) : r;
        }
        this.cache.invalidate(e.ranges);
        this.listener.onDataInvalidated();
        return;
      case "sheetData":
        if (e.sheet !== this.sheet) return;
        this.cache.invalidateAll();
        this.listener.onDataInvalidated();
        this.scheduleReload();
        return;
      case "sheetInfo":
        if (e.sheet !== this.sheet) return;
        if (this.infoValue && e.version === this.infoValue.version) return;
        this.scheduleReload();
        return;
      case "structure": {
        if (e.sheet !== this.sheet) return;
        const insert = e.op === "insert";
        const axisCount = e.axis === "row" ? (this.infoValue?.rowCount ?? 1_048_576) : (this.infoValue?.colCount ?? 16_384);
        this.cache.shift(e.axis, e.index, e.count, insert, axisCount);
        if (insert && this.usedRange) {
          const u = this.usedRange;
          const grow = (e.axis === "row" ? u.r1 : u.c1) >= e.index;
          if (grow) this.usedRange = e.axis === "row" ? { ...u, r1: u.r1 + e.count } : { ...u, c1: u.c1 + e.count };
        }
        this.listener.onStructure(e.axis, insert, e.index, e.count);
        this.listener.onDataInvalidated();
        this.scheduleReload();
        return;
      }
      case "styles":
        void this.refreshStyles();
        return;
      default:
        return;
    }
  }

  /** Coalesced `getSheetInfo` reload (several events in a burst = one call). */
  private scheduleReload(): void {
    if (this.reloadRunning) {
      this.reloadAgain = true;
      return;
    }
    this.reloadRunning = true;
    queueMicrotask(() => void this.reload());
  }

  private async reload(): Promise<void> {
    try {
      do {
        this.reloadAgain = false;
        const info = await this.engine.getSheetInfo(this.doc, this.sheet);
        if (this.disposed) return;
        if (!this.reloadAgain) this.setInfo(info);
      } while (this.reloadAgain && !this.disposed);
    } catch {
      // Sheet deleted / document closed: keep the last known state.
    } finally {
      this.reloadRunning = false;
    }
  }
}

function collectUnknownStyles(b: CellBlock, known: ReadonlyMap<StyleId, CellStyle>, out: Set<StyleId>): void {
  const ids = b.styleIds;
  let last = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id === last) continue;
    last = id;
    if (!known.has(id)) out.add(id);
  }
}
