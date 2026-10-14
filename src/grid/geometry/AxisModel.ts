import type { AxisOverride } from "@/engine/contract";

/**
 * One spreadsheet axis (rows or columns): a fixed count of items with a default
 * size plus a sparse, sorted list of overrides (custom size and/or hidden).
 *
 *   offset(i) = i * defaultSize + sum(delta of overrides with index < i)
 *
 * Lookups are O(log k), k = number of overrides (binary search over the
 * override list + lazily rebuilt prefix sums). Updates are O(k) (typed-array
 * insert) and only mark the derived arrays dirty, so bulk edits (autofit of
 * 10k rows, hiding 50k rows) cost a single O(k) rebuild on the next lookup.
 *
 * Hidden items are tracked in runs, so skipping a block of 900k filtered-out
 * rows is O(log k) as well (`nextVisible`).
 *
 * All sizes are in unzoomed CSS pixels ("sheet units").
 */
export class AxisModel {
  private countValue: number;
  private defaultValue: number;

  private idx: Int32Array;
  /** Stored (un-hidden) size, so un-hiding restores it. */
  private size: Float64Array;
  private hidden: Uint8Array;
  private n = 0;
  /** prefix[k] = sum_{j<k} (effective(j) - defaultSize); length n + 1. */
  private prefix: Float64Array;
  /** hiddenBefore[k] = number of hidden overrides in slots < k; length n + 1. */
  private hiddenBefore: Int32Array;
  /** For a hidden slot k: last / first slot of the run of consecutive hidden indices containing k. */
  private runEnd: Int32Array;
  private runStart: Int32Array;
  private derivedDirty = false;
  /** Bumped on every mutation (cache key for consumers). */
  version = 0;

  constructor(count: number, defaultSize: number) {
    if (defaultSize <= 0) throw new Error("defaultSize must be > 0");
    this.countValue = count;
    this.defaultValue = defaultSize;
    this.idx = new Int32Array(16);
    this.size = new Float64Array(16);
    this.hidden = new Uint8Array(16);
    this.prefix = new Float64Array(17);
    this.hiddenBefore = new Int32Array(17);
    this.runEnd = new Int32Array(16);
    this.runStart = new Int32Array(16);
  }

  get count(): number {
    return this.countValue;
  }

  get defaultSize(): number {
    return this.defaultValue;
  }

  get overrideCount(): number {
    return this.n;
  }

  /** Replace everything (sheet load / SheetInfo reload). Overrides may come unsorted. */
  reset(count: number, defaultSize: number, overrides: ReadonlyArray<AxisOverride>): void {
    if (defaultSize <= 0) throw new Error("defaultSize must be > 0");
    this.countValue = count;
    this.defaultValue = defaultSize;
    const sorted = overrides.filter((o) => o.index >= 0 && o.index < count).sort((a, b) => a.index - b.index);
    this.n = 0;
    this.ensureCapacity(sorted.length + 1);
    for (const o of sorted) {
      const size = o.size !== undefined ? Math.max(1, Math.round(o.size)) : defaultSize;
      const hidden = o.hidden === true;
      const last = this.n - 1;
      if (last >= 0 && this.idx[last] === o.index) {
        // Duplicate index: merge.
        if (o.size !== undefined) this.size[last] = size;
        if (hidden) this.hidden[last] = 1;
        continue;
      }
      if (!hidden && size === defaultSize) continue;
      this.idx[this.n] = o.index;
      this.size[this.n] = size;
      this.hidden[this.n] = hidden ? 1 : 0;
      this.n++;
    }
    this.derivedDirty = true;
    this.version++;
  }

  /** First override slot with idx >= i. */
  private lowerBound(i: number): number {
    let lo = 0;
    let hi = this.n;
    const idx = this.idx;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (idx[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private effective(k: number): number {
    return this.hidden[k] ? 0 : this.size[k];
  }

  private ensureDerived(): void {
    if (!this.derivedDirty) return;
    const n = this.n;
    const p = this.prefix;
    const hb = this.hiddenBefore;
    const d = this.defaultValue;
    p[0] = 0;
    hb[0] = 0;
    for (let k = 0; k < n; k++) {
      p[k + 1] = p[k] + this.effective(k) - d;
      hb[k + 1] = hb[k] + this.hidden[k];
    }
    const idx = this.idx;
    const hid = this.hidden;
    for (let k = n - 1; k >= 0; k--) {
      this.runEnd[k] = hid[k] && k + 1 < n && hid[k + 1] && idx[k + 1] === idx[k] + 1 ? this.runEnd[k + 1] : k;
    }
    for (let k = 0; k < n; k++) {
      this.runStart[k] = hid[k] && k > 0 && hid[k - 1] && idx[k - 1] === idx[k] - 1 ? this.runStart[k - 1] : k;
    }
    this.derivedDirty = false;
  }

  private ensureCapacity(needed: number): void {
    if (needed < this.idx.length) return;
    let cap = this.idx.length;
    while (cap <= needed) cap *= 2;
    const idx = new Int32Array(cap);
    idx.set(this.idx.subarray(0, this.n));
    const size = new Float64Array(cap);
    size.set(this.size.subarray(0, this.n));
    const hidden = new Uint8Array(cap);
    hidden.set(this.hidden.subarray(0, this.n));
    this.idx = idx;
    this.size = size;
    this.hidden = hidden;
    this.prefix = new Float64Array(cap + 1);
    this.hiddenBefore = new Int32Array(cap + 1);
    this.runEnd = new Int32Array(cap);
    this.runStart = new Int32Array(cap);
    this.derivedDirty = true;
  }

  private removeSlots(k: number, count: number): void {
    this.idx.copyWithin(k, k + count, this.n);
    this.size.copyWithin(k, k + count, this.n);
    this.hidden.copyWithin(k, k + count, this.n);
    this.n -= count;
  }

  private upsert(i: number, size: number, hidden: boolean): void {
    const k = this.lowerBound(i);
    const exists = k < this.n && this.idx[k] === i;
    const isDefault = !hidden && size === this.defaultValue;
    if (exists) {
      if (isDefault) {
        this.removeSlots(k, 1);
      } else {
        if (this.size[k] === size && (this.hidden[k] === 1) === hidden) return;
        this.size[k] = size;
        this.hidden[k] = hidden ? 1 : 0;
      }
    } else if (!isDefault) {
      this.ensureCapacity(this.n + 1);
      this.idx.copyWithin(k + 1, k, this.n);
      this.size.copyWithin(k + 1, k, this.n);
      this.hidden.copyWithin(k + 1, k, this.n);
      this.idx[k] = i;
      this.size[k] = size;
      this.hidden[k] = hidden ? 1 : 0;
      this.n++;
    } else {
      return;
    }
    this.derivedDirty = true;
    this.version++;
  }

  /** Stored size (ignores hidden). */
  storedSizeOf(i: number): number {
    const k = this.lowerBound(i);
    return k < this.n && this.idx[k] === i ? this.size[k] : this.defaultValue;
  }

  /** Effective size (0 when hidden). */
  sizeOf(i: number): number {
    const k = this.lowerBound(i);
    return k < this.n && this.idx[k] === i ? this.effective(k) : this.defaultValue;
  }

  isHidden(i: number): boolean {
    const k = this.lowerBound(i);
    return k < this.n && this.idx[k] === i && this.hidden[k] === 1;
  }

  /** True if any index in [a, b] (inclusive, any order) is hidden. O(log k). */
  hasHiddenIn(a: number, b: number): boolean {
    if (this.n === 0) return false;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    this.ensureDerived();
    return this.hiddenBefore[this.lowerBound(hi + 1)] - this.hiddenBefore[this.lowerBound(lo)] > 0;
  }

  /** Nearest hidden index >= i (dir=1) or <= i (dir=-1); -1 if none. O(log k). */
  nearestHidden(i: number, dir: 1 | -1): number {
    if (this.n === 0) return -1;
    this.ensureDerived();
    const hb = this.hiddenBefore;
    if (dir === 1) {
      const k0 = this.lowerBound(i);
      if (hb[this.n] - hb[k0] === 0) return -1;
      // Smallest slot j >= k0 with hb[j + 1] > hb[k0].
      let lo = k0;
      let hi = this.n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (hb[mid + 1] > hb[k0]) hi = mid;
        else lo = mid + 1;
      }
      return this.idx[lo];
    }
    const k1 = this.lowerBound(i + 1); // slots < k1 have idx <= i
    if (hb[k1] === 0) return -1;
    // Largest slot j < k1 with hb[j] < hb[k1] (i.e. slot j is hidden and the last one).
    let lo = 0;
    let hi = k1 - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (hb[mid] < hb[k1]) lo = mid;
      else hi = mid - 1;
    }
    return this.idx[lo];
  }

  setSize(i: number, size: number): void {
    this.upsert(i, Math.max(1, Math.round(size)), this.isHidden(i));
  }

  setHidden(i: number, hidden: boolean): void {
    this.upsert(i, this.storedSizeOf(i), hidden);
  }

  /**
   * Insert (`count` default-sized items at `index`, later items move up) or
   * delete (`count` items starting at `index`, later items move down).
   */
  shift(index: number, count: number, insert: boolean): void {
    if (count <= 0) return;
    const k = this.lowerBound(index);
    if (insert) {
      let end = this.n;
      for (let j = k; j < this.n; j++) {
        const v = this.idx[j] + count;
        if (v >= this.countValue) {
          end = j;
          break;
        }
        this.idx[j] = v;
      }
      this.n = end;
    } else {
      const kEnd = this.lowerBound(index + count);
      this.removeSlots(k, kEnd - k);
      for (let j = k; j < this.n; j++) this.idx[j] -= count;
    }
    this.derivedDirty = true;
    this.version++;
  }

  /** Start offset of item i (i may equal count => total size). */
  offsetOf(i: number): number {
    this.ensureDerived();
    const k = this.lowerBound(i);
    return i * this.defaultValue + this.prefix[k];
  }

  /** End offset (exclusive) of item i. */
  endOf(i: number): number {
    return this.offsetOf(i) + this.sizeOf(i);
  }

  total(): number {
    this.ensureDerived();
    return this.countValue * this.defaultValue + this.prefix[this.n];
  }

  /**
   * Index of the visible item containing `offset`. Hidden items are never
   * returned. Offsets outside [0, total) clamp to the first/last visible item.
   */
  indexAt(offset: number): number {
    this.ensureDerived();
    const d = this.defaultValue;
    if (offset <= 0) return Math.max(0, this.nextVisible(0, 1));
    if (offset >= this.total()) return Math.max(0, this.nextVisible(this.countValue - 1, -1));
    const idx = this.idx;
    const p = this.prefix;
    // Largest k such that start(k) <= offset.
    let lo = 0;
    let hi = this.n - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (idx[mid] * d + p[mid] <= offset) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k < 0) return Math.floor(offset / d);
    const start = idx[k] * d + p[k];
    const eff = this.effective(k);
    if (offset < start + eff) return idx[k];
    // Overrides after k start beyond `offset`, so item i is a default-sized (visible) item.
    const i = idx[k] + 1 + Math.floor((offset - start - eff) / d);
    return Math.min(i, this.countValue - 1);
  }

  /** First visible index >= i (dir=1) or <= i (dir=-1); -1 if none. O(log k). */
  nextVisible(i: number, dir: 1 | -1): number {
    if (i < 0 || i >= this.countValue) return -1;
    const k = this.lowerBound(i);
    if (!(k < this.n && this.idx[k] === i && this.hidden[k] === 1)) return i;
    this.ensureDerived();
    if (dir === 1) {
      const j = this.idx[this.runEnd[k]] + 1;
      return j < this.countValue ? j : -1;
    }
    const j = this.idx[this.runStart[k]] - 1;
    return j >= 0 ? j : -1;
  }

  /** One visible step from i in dir; stays put at the boundary. */
  step(i: number, dir: 1 | -1): number {
    const j = this.nextVisible(i + dir, dir);
    return j < 0 ? i : j;
  }

  /** Last visible index (or 0). */
  lastVisible(): number {
    return Math.max(0, this.nextVisible(this.countValue - 1, -1));
  }

  *overrides(): IterableIterator<{ index: number; size: number; hidden: boolean }> {
    for (let k = 0; k < this.n; k++) {
      yield { index: this.idx[k], size: this.size[k], hidden: this.hidden[k] === 1 };
    }
  }
}
