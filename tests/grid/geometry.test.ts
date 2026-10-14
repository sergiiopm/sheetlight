import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS } from "@/engine/types";
import { SheetGeometry } from "@/grid/geometry/SheetGeometry";
import { MergeIndex } from "@/grid/geometry/MergeIndex";
import {
  blitCompatible,
  colAtX,
  colScreenX,
  computeLayout,
  devX,
  devY,
  forEachVisibleBand,
  overflowColumns,
  paneForCell,
  rowAtY,
  rowScreenY,
  scrollExtent,
} from "@/grid/geometry/layout";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function sheet(frozenRows = 0, frozenCols = 0): SheetGeometry {
  const g = new SheetGeometry();
  g.rows.setSize(3, 45);
  g.rows.setHidden(7, true);
  g.cols.setSize(1, 130);
  g.cols.setHidden(4, true);
  g.setFrozen(frozenRows, frozenCols);
  return g;
}

describe("layout", () => {
  it("builds one pane without frozen panes and four with them", () => {
    const L = computeLayout(sheet(), 800, 600, 1, 1, 0, 0, 40, 20);
    expect(L.panes.map((p) => p.kind)).toEqual(["main"]);
    expect(L.main).toMatchObject({ x: 40, y: 20, w: 760, h: 580, r0: 0, c0: 0 });

    const g = sheet(2, 1);
    const F = computeLayout(g, 800, 600, 1, 1.25, 100, 50, 40, 25);
    expect(F.panes.map((p) => p.kind)).toEqual(["corner", "top", "left", "main"]);
    const [corner, top, left, main] = F.panes;
    expect(corner).toMatchObject({ r0: 0, r1: 1, c0: 0, c1: 0, scrollsX: false, scrollsY: false });
    expect(top).toMatchObject({ r0: 0, r1: 1, scrollsX: true, scrollsY: false });
    expect(left).toMatchObject({ c0: 0, c1: 0, scrollsX: false, scrollsY: true });
    expect(F.frozenW).toBe(64 * 1.25);
    expect(F.frozenH).toBe(40 * 1.25);
    expect(main.x).toBe(40 + 80);
    expect(main.y).toBe(25 + 50);
    // The main pane starts after the frozen area, scrolled by 100 x 50 sheet units.
    expect(main.c0).toBe(g.cols.indexAt(g.cols.offsetOf(1) + 100));
    expect(main.r0).toBe(g.rows.indexAt(g.rows.offsetOf(2) + 50));
    expect(colAtX(g, F, main.x)).toBe(main.c0);
  });

  it("a scroll of N device pixels moves every edge by exactly N (blit invariant)", () => {
    const random = rng(7);
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const zoom of [0.5, 0.75, 1, 1.1, 1.25, 2]) {
        const g = sheet(1, 1);
        const s = zoom * dpr;
        for (let t = 0; t < 20; t++) {
          const sy = Math.round(random() * 50_000 * s) / s;
          const n = 1 + Math.floor(random() * 300);
          const a = computeLayout(g, 900, 700, dpr, zoom, 0, sy, 40, 20);
          const b = computeLayout(g, 900, 700, dpr, zoom, 0, sy + n / s, 40, 20);
          const shift = b.main.scrollDevY - a.main.scrollDevY;
          expect(shift).toBe(n);
          for (let r = a.main.r0; r <= a.main.r1 + 1; r++) {
            const off = g.rows.offsetOf(r);
            expect(devY(a, a.main, off) - devY(b, b.main, off)).toBe(shift);
          }
          // Frozen panes and x edges do not move.
          expect(devX(a, a.main, g.cols.offsetOf(5))).toBe(devX(b, b.main, g.cols.offsetOf(5)));
          expect(devY(a, a.panes[0], g.rows.offsetOf(1))).toBe(devY(b, b.panes[0], g.rows.offsetOf(1)));
        }
      }
    }
  });

  it("hit-testing agrees with screen positions (frozen and scrolled)", () => {
    const random = rng(11);
    const g = sheet(3, 2);
    const L = computeLayout(g, 1000, 700, 1.5, 1.25, 333, 2222, 44, 22);
    for (let i = 0; i < 500; i++) {
      const x = L.headerW + random() * (L.width - L.headerW);
      const y = L.headerH + random() * (L.height - L.headerH);
      const c = colAtX(g, L, x);
      const r = rowAtY(g, L, y);
      const left = colScreenX(g, L, c);
      const top = rowScreenY(g, L, r);
      expect(x).toBeGreaterThanOrEqual(left - 1e-6);
      expect(x).toBeLessThan(left + g.cols.sizeOf(c) * L.zoom + 1e-6);
      expect(y).toBeGreaterThanOrEqual(top - 1e-6);
      expect(y).toBeLessThan(top + g.rows.sizeOf(r) * L.zoom + 1e-6);
      expect(g.cols.isHidden(c)).toBe(false);
      expect(g.rows.isHidden(r)).toBe(false);
      const p = paneForCell(L, g, r, c);
      expect(p.kind).toBe(r < 3 ? (c < 2 ? "corner" : "top") : c < 2 ? "left" : "main");
    }
  });

  it("scroll extent covers the whole sheet minus the visible part", () => {
    const g = sheet(2, 0);
    const e = scrollExtent(g, 800, 600, 1, 40, 20);
    expect(e.viewH).toBe(600 - 20 - 40);
    expect(e.maxY).toBe(g.rows.total() - g.rows.offsetOf(2) - e.viewH);
    expect(e.maxX).toBe(g.cols.total() - (800 - 40));
  });

  it("overflow columns stay inside the pane's column domain", () => {
    const g = sheet(0, 3);
    const L = computeLayout(g, 900, 600, 1, 1, 5000, 0, 40, 20);
    for (const p of L.panes) {
      const { ce0, ce1 } = overflowColumns(g, p, L.zoom);
      expect(ce0).toBeLessThanOrEqual(p.c0);
      expect(ce1).toBeGreaterThanOrEqual(p.c1);
      if (p.scrollsX) {
        expect(ce0).toBeGreaterThanOrEqual(3);
        expect(ce1).toBeLessThanOrEqual(MAX_COLS - 1);
        expect(ce1 - p.c1).toBeLessThanOrEqual(256);
      } else {
        expect(ce0).toBe(0);
        expect(ce1).toBe(2);
      }
    }
  });

  it("visits only bands with visible rows", () => {
    const g = new SheetGeometry();
    for (let r = 64; r < 192; r++) g.rows.setHidden(r, true);
    const bands: number[] = [];
    forEachVisibleBand(g, 0, 300, 64, (br) => bands.push(br));
    expect(bands).toEqual([0, 3, 4]);
    const last: number[] = [];
    forEachVisibleBand(g, MAX_ROWS - 70, MAX_ROWS - 1, 64, (br) => last.push(br));
    expect(last).toEqual([Math.floor((MAX_ROWS - 70) / 64), MAX_ROWS / 64 - 1]);
  });

  it("blitCompatible only differs by scroll", () => {
    const g = sheet(1, 0);
    const a = computeLayout(g, 800, 600, 1, 1, 0, 0, 40, 20);
    expect(blitCompatible(a, computeLayout(g, 800, 600, 1, 1, 30, 70, 40, 20))).toBe(true);
    expect(blitCompatible(a, computeLayout(g, 800, 600, 1, 1.1, 0, 0, 40, 20))).toBe(false);
    expect(blitCompatible(a, computeLayout(g, 800, 600, 1, 1, 0, 0, 48, 20))).toBe(false);
    expect(blitCompatible(a, computeLayout(g, 801, 600, 1, 1, 0, 0, 40, 20))).toBe(false);
  });
});

describe("MergeIndex", () => {
  it("finds, queries (deduplicated across buckets) and expands", () => {
    const m = new MergeIndex();
    m.setAll([
      { r0: 1, c0: 1, r1: 2, c1: 3 },
      { r0: 60, c0: 0, r1: 130, c1: 1 },
      { r0: 2, c0: 3, r1: 4, c1: 5 },
    ]);
    expect(m.at(2, 2)).toEqual({ r0: 1, c0: 1, r1: 2, c1: 3 });
    expect(m.at(100, 1)).toEqual({ r0: 60, c0: 0, r1: 130, c1: 1 });
    expect(m.at(5, 5)).toBeNull();
    expect(m.query({ r0: 0, c0: 0, r1: 200, c1: 10 })).toHaveLength(3);
    expect(m.query({ r0: 64, c0: 0, r1: 200, c1: 0 })).toHaveLength(1);
    // B2 touches the first merge, which touches the third: the range grows transitively.
    expect(m.expand({ r0: 1, c0: 1, r1: 1, c1: 1 })).toEqual({ r0: 1, c0: 1, r1: 4, c1: 5 });
  });

  it("shifts on structural edits", () => {
    const m = new MergeIndex();
    m.setAll([
      { r0: 5, c0: 0, r1: 8, c1: 2 },
      { r0: 20, c0: 0, r1: 21, c1: 0 },
    ]);
    m.shift("row", 6, 2, true);
    expect(m.all()).toEqual([
      { r0: 5, c0: 0, r1: 10, c1: 2 },
      { r0: 22, c0: 0, r1: 23, c1: 0 },
    ]);
    m.shift("row", 22, 1, false);
    // A two-cell merge losing one row collapses to a single cell and disappears.
    expect(m.all()).toEqual([{ r0: 5, c0: 0, r1: 10, c1: 2 }]);
    m.shift("col", 0, 1, false);
    expect(m.all()).toEqual([{ r0: 5, c0: 0, r1: 10, c1: 1 }]);
  });
});

describe("SheetGeometry", () => {
  it("applies SheetInfo and bumps its version", () => {
    const g = new SheetGeometry();
    const v = g.version;
    g.apply({
      sheet: 1,
      rowCount: MAX_ROWS,
      colCount: MAX_COLS,
      defaultRowHeight: 18,
      defaultColWidth: 70,
      usedRange: null,
      rowOverrides: [{ index: 2, hidden: true }],
      colOverrides: [{ index: 0, size: 100 }],
      merges: [{ r0: 0, c0: 0, r1: 1, c1: 1 }],
      frozenRows: 1,
      frozenCols: 0,
      showGridLines: false,
      autoFilter: null,
      version: 3,
    });
    expect(g.version).not.toBe(v);
    expect(g.rows.defaultSize).toBe(18);
    expect(g.rows.isHidden(2)).toBe(true);
    expect(g.cols.sizeOf(0)).toBe(100);
    expect(g.frozenRows).toBe(1);
    expect(g.showGridLines).toBe(false);
    expect(g.merges.size).toBe(1);
  });
});
