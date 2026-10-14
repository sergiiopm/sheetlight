import { describe, expect, it } from "vitest";
import { AxisModel } from "@/grid/geometry/AxisModel";

/** Deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** Brute-force reference model. */
class Brute {
  sizes: number[];
  hidden: boolean[];
  constructor(n: number, readonly d: number) {
    this.sizes = new Array<number>(n).fill(d);
    this.hidden = new Array<boolean>(n).fill(false);
  }
  eff(i: number): number {
    return this.hidden[i] ? 0 : this.sizes[i];
  }
  nextVisible(i: number, dir: 1 | -1): number {
    for (let j = i; j >= 0 && j < this.sizes.length; j += dir) if (!this.hidden[j]) return j;
    return -1;
  }
  nearestHidden(i: number, dir: 1 | -1): number {
    for (let j = i; j >= 0 && j < this.sizes.length; j += dir) if (this.hidden[j]) return j;
    return -1;
  }
}

function checkAll(a: AxisModel, b: Brute): void {
  let off = 0;
  const n = b.sizes.length;
  for (let k = 0; k < n; k++) {
    const eff = b.eff(k);
    expect(a.offsetOf(k)).toBe(off);
    expect(a.sizeOf(k)).toBe(eff);
    expect(a.isHidden(k)).toBe(b.hidden[k]);
    if (eff > 0) {
      expect(a.indexAt(off)).toBe(k);
      expect(a.indexAt(off + eff - 0.5)).toBe(k);
    }
    expect(a.nextVisible(k, 1)).toBe(b.nextVisible(k, 1));
    expect(a.nextVisible(k, -1)).toBe(b.nextVisible(k, -1));
    expect(a.nearestHidden(k, 1)).toBe(b.nearestHidden(k, 1));
    expect(a.nearestHidden(k, -1)).toBe(b.nearestHidden(k, -1));
    off += eff;
  }
  expect(a.total()).toBe(off);
}

describe("AxisModel", () => {
  it("matches a brute-force model under random edits (sizes, hidden runs)", () => {
    const rnd = rng(42);
    const N = 600;
    const D = 20;
    const a = new AxisModel(N, D);
    const b = new Brute(N, D);
    for (let iter = 0; iter < 1500; iter++) {
      const i = Math.floor(rnd() * N);
      const op = rnd();
      if (op < 0.4) {
        const s = Math.round(1 + rnd() * 80);
        a.setSize(i, s);
        b.sizes[i] = s;
      } else if (op < 0.55) {
        a.setSize(i, D);
        b.sizes[i] = D;
      } else {
        // Hide/unhide runs, so hidden runs of various lengths appear.
        const len = 1 + Math.floor(rnd() * 12);
        const h = rnd() < 0.6;
        for (let j = i; j < Math.min(N, i + len); j++) {
          a.setHidden(j, h);
          b.hidden[j] = h;
        }
      }
      if (iter % 150 === 0) checkAll(a, b);
    }
    checkAll(a, b);
  });

  it("hasHiddenIn agrees with a scan", () => {
    const a = new AxisModel(100, 20);
    for (const i of [5, 6, 7, 40, 99]) a.setHidden(i, true);
    const hidden = new Set([5, 6, 7, 40, 99]);
    for (let x = 0; x < 100; x += 3) {
      for (let y = x; y < 100; y += 7) {
        let expected = false;
        for (let k = x; k <= y; k++) if (hidden.has(k)) expected = true;
        expect(a.hasHiddenIn(x, y)).toBe(expected);
        expect(a.hasHiddenIn(y, x)).toBe(expected);
      }
    }
  });

  it("skips a 900k-row hidden run in O(log k)", () => {
    const a = new AxisModel(1_048_576, 20);
    a.reset(1_048_576, 20, Array.from({ length: 900_000 }, (_, k) => ({ index: 100 + k, hidden: true })));
    expect(a.nextVisible(100, 1)).toBe(900_100);
    expect(a.nextVisible(900_099, -1)).toBe(99);
    expect(a.step(99, 1)).toBe(900_100);
    expect(a.indexAt(a.offsetOf(100))).toBe(900_100);
    const t0 = performance.now();
    for (let k = 0; k < 100_000; k++) a.nextVisible(100 + (k % 900_000), 1);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("reset() accepts unsorted, duplicated overrides", () => {
    const a = new AxisModel(10, 20);
    a.reset(1000, 15, [
      { index: 50, size: 40 },
      { index: 3, hidden: true },
      { index: 50, hidden: true },
      { index: 7, size: 15 },
    ]);
    expect(a.count).toBe(1000);
    expect(a.defaultSize).toBe(15);
    expect(a.overrideCount).toBe(2);
    expect(a.isHidden(50)).toBe(true);
    expect(a.storedSizeOf(50)).toBe(40);
    expect(a.isHidden(3)).toBe(true);
    expect(a.offsetOf(10)).toBe(9 * 15);
  });

  it("shift() moves overrides on insert and delete", () => {
    const a = new AxisModel(100, 20);
    a.setSize(10, 50);
    a.setHidden(20, true);
    a.setSize(30, 5);
    a.shift(15, 3, true);
    expect(a.storedSizeOf(10)).toBe(50);
    expect(a.isHidden(23)).toBe(true);
    expect(a.isHidden(20)).toBe(false);
    expect(a.storedSizeOf(33)).toBe(5);
    a.shift(20, 5, false); // deletes 20..24 (incl. the hidden 23)
    expect(a.isHidden(23)).toBe(false);
    expect(a.overrideCount).toBe(2);
    expect(a.storedSizeOf(28)).toBe(5);
    // Overrides pushed past the end disappear.
    a.setSize(99, 70);
    a.shift(0, 2, true);
    expect(a.storedSizeOf(99)).toBe(20);
  });
});
