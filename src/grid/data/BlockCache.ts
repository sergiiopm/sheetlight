import { BLOCK_COLS, BLOCK_ROWS, type BlockKey } from "@/engine/contract";
import type { CellRange } from "@/engine/types";
import { blockKeyOf, shiftBlocks, type GridBlock } from "./GridBlock";

export interface BlockCacheStats {
  requestedBlocks: number;
  loadedBlocks: number;
  /** Blocks the engine reported unchanged (knownVersions hit). */
  unchangedBlocks: number;
  inflight: number;
  cached: number;
  evicted: number;
  /** Sum of request->arrival latency, for averaging. */
  latencySumMs: number;
}

/**
 * Fetches blocks for the cache. `knownVersions` (parallel to `keys`) lets the
 * engine skip unchanged blocks: those are simply absent from the result.
 */
export type BlockFetcher = (keys: ReadonlyArray<BlockKey>, knownVersions: ReadonlyArray<number> | undefined, priority: 0 | 1) => Promise<GridBlock[]>;

/**
 * Synchronous, bounded LRU cache of cell blocks in front of the async engine.
 * The render loop only ever calls `get` (sync, never blocks); `ensure`
 * schedules fetches for whatever is missing or stale and `onLoaded` asks the
 * grid to repaint when data arrives. Stale blocks keep being served
 * (last-known data) until the refresh lands.
 */
export class BlockCache {
  private blocks = new Map<number, GridBlock>();
  private readonly inflight = new Set<number>();
  private readonly stale = new Set<number>();
  /** Invalidated while a fetch was in flight: the arriving data may predate the change. */
  private readonly restale = new Set<number>();
  /** Bumped by structural shifts: responses of an older epoch are dropped. */
  private epoch = 0;
  private disposed = false;
  readonly stats: BlockCacheStats = {
    requestedBlocks: 0,
    loadedBlocks: 0,
    unchangedBlocks: 0,
    inflight: 0,
    cached: 0,
    evicted: 0,
    latencySumMs: 0,
  };
  /** Bounds of blocks that can contain data; everything else is known-empty. */
  private maxBr = -1;
  private maxBc = -1;

  constructor(
    private readonly fetcher: BlockFetcher,
    private readonly capacity: number,
    private readonly onLoaded: (keys: ReadonlyArray<BlockKey>) => void,
  ) {}

  /** Blocks outside this range are known to be empty and never requested. */
  setUsedRange(used: CellRange | null): void {
    this.maxBr = used ? Math.floor(used.r1 / BLOCK_ROWS) : -1;
    this.maxBc = used ? Math.floor(used.c1 / BLOCK_COLS) : -1;
  }

  /** Grow the data bounds (a `cells` event may write beyond the known used range). */
  growUsedRange(r: CellRange): void {
    this.maxBr = Math.max(this.maxBr, Math.floor(r.r1 / BLOCK_ROWS));
    this.maxBc = Math.max(this.maxBc, Math.floor(r.c1 / BLOCK_COLS));
  }

  /** True if the block lies outside the used range (no fetch needed, all empty). */
  isKnownEmpty(br: number, bc: number): boolean {
    return br > this.maxBr || bc > this.maxBc;
  }

  get(br: number, bc: number): GridBlock | undefined {
    return this.blocks.get(blockKeyOf(br, bc));
  }

  /** All cached blocks (style refresh, tests). */
  values(): IterableIterator<GridBlock> {
    return this.blocks.values();
  }

  isStale(br: number, bc: number): boolean {
    return this.stale.has(blockKeyOf(br, bc));
  }

  /**
   * Make sure the given blocks are present: touch cached ones (LRU), request
   * missing / stale ones. Called once per frame with the visible set and
   * again with the prefetch set.
   */
  ensure(keys: ReadonlyArray<BlockKey>, priority: 0 | 1): void {
    let missing: BlockKey[] | null = null;
    let refresh: BlockKey[] | null = null;
    let versions: number[] | null = null;
    for (const k of keys) {
      if (this.isKnownEmpty(k.br, k.bc)) continue;
      const key = blockKeyOf(k.br, k.bc);
      const b = this.blocks.get(key);
      if (b && priority === 0) {
        // LRU touch: move to the end of insertion order.
        this.blocks.delete(key);
        this.blocks.set(key, b);
      }
      if ((!b || this.stale.has(key)) && !this.inflight.has(key)) {
        this.inflight.add(key);
        if (b && b.version >= 0) {
          (refresh ??= []).push(k);
          (versions ??= []).push(b.version);
        } else {
          (missing ??= []).push(k);
        }
      }
    }
    if (missing) this.fetch(missing, undefined, priority);
    if (refresh && versions) this.fetch(refresh, versions, priority);
  }

  private fetch(keys: BlockKey[], knownVersions: number[] | undefined, priority: 0 | 1): void {
    const t0 = performance.now();
    const epoch = this.epoch;
    this.stats.requestedBlocks += keys.length;
    this.stats.inflight = this.inflight.size;
    this.fetcher(keys, knownVersions, priority).then(
      (blocks) => {
        if (this.disposed) return;
        if (epoch !== this.epoch) {
          // A structural shift happened meanwhile: keys no longer mean the same cells.
          for (const k of keys) this.inflight.delete(blockKeyOf(k.br, k.bc));
          this.stats.inflight = this.inflight.size;
          this.onLoaded([]);
          return;
        }
        const dt = performance.now() - t0;
        const arrived = new Set<number>();
        for (const b of blocks) {
          const key = blockKeyOf(b.br, b.bc);
          arrived.add(key);
          this.blocks.delete(key);
          this.blocks.set(key, b);
          this.stats.loadedBlocks++;
          this.stats.latencySumMs += dt;
        }
        for (const k of keys) {
          const key = blockKeyOf(k.br, k.bc);
          this.inflight.delete(key);
          if (!arrived.has(key) && knownVersions && this.blocks.has(key)) this.stats.unchangedBlocks++;
          if (arrived.has(key) || knownVersions) this.stale.delete(key);
          if (this.restale.has(key)) {
            this.restale.delete(key);
            if (this.blocks.has(key)) this.stale.add(key);
          }
        }
        this.evict();
        this.stats.inflight = this.inflight.size;
        this.stats.cached = this.blocks.size;
        this.onLoaded(keys);
      },
      () => {
        if (this.disposed) return;
        for (const k of keys) {
          const key = blockKeyOf(k.br, k.bc);
          this.inflight.delete(key);
          this.restale.delete(key);
        }
        this.stats.inflight = this.inflight.size;
      },
    );
  }

  private evict(): void {
    const over = this.blocks.size - this.capacity;
    if (over <= 0) return;
    let i = 0;
    for (const key of this.blocks.keys()) {
      if (i++ >= over) break;
      this.blocks.delete(key);
      this.stale.delete(key);
      this.stats.evicted++;
    }
  }

  /** Mark blocks intersecting the ranges stale; they keep rendering until refreshed. */
  invalidate(ranges: ReadonlyArray<CellRange>): void {
    for (const r of ranges) {
      const br0 = Math.floor(r.r0 / BLOCK_ROWS);
      const br1 = Math.floor(r.r1 / BLOCK_ROWS);
      const bc0 = Math.floor(r.c0 / BLOCK_COLS);
      const bc1 = Math.floor(r.c1 / BLOCK_COLS);
      if ((br1 - br0 + 1) * (bc1 - bc0 + 1) > this.blocks.size + this.inflight.size) {
        // Huge range (whole columns/rows): walk the cache instead of the range.
        for (const b of this.blocks.values()) {
          if (b.br >= br0 && b.br <= br1 && b.bc >= bc0 && b.bc <= bc1) this.markStale(blockKeyOf(b.br, b.bc));
        }
        for (const key of this.inflight) {
          const br = Math.floor(key / 2048);
          const bc = key % 2048;
          if (br >= br0 && br <= br1 && bc >= bc0 && bc <= bc1) this.restale.add(key);
        }
        continue;
      }
      for (let br = br0; br <= br1; br++) {
        for (let bc = bc0; bc <= bc1; bc++) this.markStale(blockKeyOf(br, bc));
      }
    }
  }

  private markStale(key: number): void {
    if (this.blocks.has(key)) this.stale.add(key);
    if (this.inflight.has(key)) this.restale.add(key);
  }

  invalidateAll(): void {
    for (const key of this.blocks.keys()) this.stale.add(key);
    for (const key of this.inflight) this.restale.add(key);
  }

  /** Rows/cols inserted or deleted: move cached data locally, then everything refetches. */
  shift(axis: "row" | "col", index: number, count: number, insert: boolean, axisCount: number): void {
    this.epoch++;
    this.blocks = shiftBlocks(this.blocks, axis, index, count, insert, axisCount, (br, bc) => this.isKnownEmpty(br, bc));
    this.inflight.clear();
    this.restale.clear();
    this.stale.clear();
    for (const key of this.blocks.keys()) this.stale.add(key);
    if (insert) {
      if (axis === "row" && this.maxBr >= 0) this.maxBr += Math.ceil(count / BLOCK_ROWS);
      if (axis === "col" && this.maxBc >= 0) this.maxBc += Math.ceil(count / BLOCK_COLS);
    }
    this.stats.inflight = 0;
    this.stats.cached = this.blocks.size;
  }

  dispose(): void {
    this.disposed = true;
    this.blocks.clear();
    this.inflight.clear();
  }
}
