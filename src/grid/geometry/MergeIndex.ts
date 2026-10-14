import { rangesIntersect, rangeUnion, type CellRange } from "@/engine/types";

const BUCKET_SHIFT = 6; // 64 rows per bucket

/** What selection logic needs from merges (keeps the pure selection functions testable). */
export interface MergeLookup {
  /** Merge containing (row, col), if any. */
  at(row: number, col: number): CellRange | null;
  /** Grow a range until it fully contains every merge it touches. */
  expand(range: CellRange): CellRange;
}

/**
 * Spatial index of merged ranges, bucketed by row band. Typical sheets have
 * few merges; lookups touch only the buckets of the rows involved.
 */
export class MergeIndex implements MergeLookup {
  private list: CellRange[] = [];
  private buckets = new Map<number, number[]>();
  version = 0;

  get size(): number {
    return this.list.length;
  }

  all(): ReadonlyArray<CellRange> {
    return this.list;
  }

  setAll(ranges: ReadonlyArray<CellRange>): void {
    this.list = [];
    this.buckets.clear();
    for (const r of ranges) this.insert(r);
    this.version++;
  }

  add(r: CellRange): void {
    this.insert(r);
    this.version++;
  }

  private insert(r: CellRange): void {
    const id = this.list.length;
    this.list.push(r);
    for (let b = r.r0 >> BUCKET_SHIFT; b <= r.r1 >> BUCKET_SHIFT; b++) {
      let arr = this.buckets.get(b);
      if (!arr) this.buckets.set(b, (arr = []));
      arr.push(id);
    }
  }

  /** Merge containing (row, col), if any. */
  at(row: number, col: number): CellRange | null {
    const arr = this.buckets.get(row >> BUCKET_SHIFT);
    if (!arr) return null;
    for (const id of arr) {
      const m = this.list[id];
      if (row >= m.r0 && row <= m.r1 && col >= m.c0 && col <= m.c1) return m;
    }
    return null;
  }

  /** All merges intersecting the range (deduplicated). */
  query(range: CellRange, out: CellRange[] = []): CellRange[] {
    const b0 = range.r0 >> BUCKET_SHIFT;
    const b1 = range.r1 >> BUCKET_SHIFT;
    if (b1 - b0 + 1 > this.list.length) {
      for (const m of this.list) if (rangesIntersect(m, range)) out.push(m);
      return out;
    }
    let seen: Set<number> | null = null;
    for (let b = b0; b <= b1; b++) {
      const arr = this.buckets.get(b);
      if (!arr) continue;
      for (const id of arr) {
        const m = this.list[id];
        if (!rangesIntersect(m, range)) continue;
        if (m.r0 >> BUCKET_SHIFT !== m.r1 >> BUCKET_SHIFT) {
          seen ??= new Set();
          if (seen.has(id)) continue;
          seen.add(id);
        }
        out.push(m);
      }
    }
    return out;
  }

  /** Grow a range until it fully contains every merge it touches (Excel selection rule). */
  expand(range: CellRange): CellRange {
    if (this.list.length === 0) return range;
    let r = range;
    for (;;) {
      let grown = r;
      for (const m of this.query(r)) grown = rangeUnion(grown, m);
      if (grown.r0 === r.r0 && grown.r1 === r.r1 && grown.c0 === r.c0 && grown.c1 === r.c1) return r;
      r = grown;
    }
  }

  /**
   * Structural edit (rows/cols inserted or deleted): move merges locally until
   * the engine sends the authoritative list. Merges fully inside a deleted
   * band disappear; merges crossing it shrink; insertions inside a merge grow it.
   */
  shift(axis: "row" | "col", index: number, count: number, insert: boolean): void {
    const out: CellRange[] = [];
    for (const m of this.list) {
      const a0 = axis === "row" ? m.r0 : m.c0;
      const a1 = axis === "row" ? m.r1 : m.c1;
      let n0 = a0;
      let n1 = a1;
      if (insert) {
        if (a0 >= index) n0 += count;
        if (a1 >= index) n1 += count;
      } else {
        const end = index + count; // exclusive
        const map0 = a0 < index ? a0 : a0 >= end ? a0 - count : index;
        const map1 = a1 < index ? a1 : a1 >= end ? a1 - count : index - 1;
        n0 = map0;
        n1 = map1;
        if (n1 < n0) continue;
      }
      const r = axis === "row" ? { r0: n0, r1: n1, c0: m.c0, c1: m.c1 } : { r0: m.r0, r1: m.r1, c0: n0, c1: n1 };
      if (r.r0 === r.r1 && r.c0 === r.c1) continue;
      out.push(r);
    }
    this.setAll(out);
  }
}
