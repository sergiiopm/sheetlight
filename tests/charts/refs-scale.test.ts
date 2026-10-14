import { describe, expect, it } from "vitest";
import { formatRef, parseRef, quoteSheetName, resolveRef } from "@/charts/refs";
import { formatNumber, formatPercent, formatTick, niceScale, percentScale } from "@/charts/scale";
import { MAX_ROWS } from "@/engine/types";
import type { SheetMeta } from "@/engine/contract";

const sheets: SheetMeta[] = [
  { id: 1, name: "Hoja1", hidden: false },
  { id: 2, name: "Mi hoja", hidden: false },
  { id: 3, name: "O'Brien", hidden: false },
];

describe("chart references", () => {
  it("parses qualified, quoted and unqualified refs", () => {
    expect(parseRef("Hoja1!$B$2:$B$13")).toEqual([
      { sheetName: "Hoja1", range: { r0: 1, c0: 1, r1: 12, c1: 1 }, wholeCols: false, wholeRows: false },
    ]);
    expect(parseRef("'Mi hoja'!A1:A5")?.[0]).toMatchObject({ sheetName: "Mi hoja", range: { r0: 0, c0: 0, r1: 4, c1: 0 } });
    expect(parseRef("'O''Brien'!$C$3")?.[0]).toMatchObject({ sheetName: "O'Brien", range: { r0: 2, c0: 2, r1: 2, c1: 2 } });
    expect(parseRef("=B2:B13")?.[0]).toMatchObject({ sheetName: null, range: { r0: 1, c0: 1, r1: 12, c1: 1 } });
    // Reversed corners are normalized.
    expect(parseRef("C5:A1")?.[0].range).toEqual({ r0: 0, c0: 0, r1: 4, c1: 2 });
  });

  it("parses whole columns/rows and unions", () => {
    const [col] = parseRef("Hoja1!$B:$B")!;
    expect(col).toMatchObject({ wholeCols: true, range: { r0: 0, c0: 1, r1: MAX_ROWS - 1, c1: 1 } });
    const [row] = parseRef("2:3")!;
    expect(row).toMatchObject({ wholeRows: true, range: { r0: 1, r1: 2 } });
    const union = parseRef("(Hoja1!$A$1:$A$3,'Mi hoja'!$A$5:$A$7)")!;
    expect(union.map((a) => a.sheetName)).toEqual(["Hoja1", "Mi hoja"]);
  });

  it("rejects garbage", () => {
    for (const bad of ["", "Hoja1!", "!A1", "A1:", "ZZZZ1", "A0", "hola mundo", "'Mi hoja!A1", "B"]) {
      expect(parseRef(bad), bad).toBeNull();
    }
  });

  it("quotes sheet names like Excel and round-trips formatRef", () => {
    expect(quoteSheetName("Hoja1")).toBe("Hoja1");
    expect(quoteSheetName("Año")).toBe("Año");
    expect(quoteSheetName("Mi hoja")).toBe("'Mi hoja'");
    expect(quoteSheetName("O'Brien")).toBe("'O''Brien'");
    expect(quoteSheetName("A1")).toBe("'A1'");
    expect(quoteSheetName("R1C1")).toBe("'R1C1'");
    expect(quoteSheetName("2025")).toBe("'2025'");
    const ref = formatRef("Mi hoja", { r0: 1, c0: 1, r1: 12, c1: 1 });
    expect(ref).toBe("'Mi hoja'!$B$2:$B$13");
    expect(formatRef("Hoja1", { r0: 0, c0: 0, r1: 0, c1: 0 })).toBe("Hoja1!$A$1");
    expect(resolveRef(ref, sheets, 1)).toEqual([{ sheet: 2, range: { r0: 1, c0: 1, r1: 12, c1: 1 }, wholeCols: false, wholeRows: false }]);
  });

  it("resolves sheet names case-insensitively and defaults unqualified refs", () => {
    expect(resolveRef("hoja1!A1", sheets, 2)?.[0].sheet).toBe(1);
    expect(resolveRef("A1:A3", sheets, 2)?.[0].sheet).toBe(2);
    expect(resolveRef("Nada!A1", sheets, 1)).toBeNull();
  });
});

describe("axis scale", () => {
  it("starts at zero and adds headroom like Excel", () => {
    const s = niceScale(0, 100, 6);
    expect(s.min).toBe(0);
    expect(s.max).toBe(120);
    expect(s.step).toBe(20);
    expect(s.ticks).toEqual([0, 20, 40, 60, 80, 100, 120]);
  });

  it("keeps zero for typical sales data and picks 1/2/5 steps", () => {
    const s = niceScale(1000, 2250, 7);
    expect(s.min).toBe(0);
    expect([200, 500]).toContain(s.step);
    expect(s.max).toBeGreaterThanOrEqual(2250);
    expect((s.max - s.min) / s.step).toBeLessThanOrEqual(7);
  });

  it("does not force zero for a narrow band far from it", () => {
    const s = niceScale(980, 1010, 6);
    expect(s.min).toBeGreaterThan(900);
    expect(s.min).toBeLessThanOrEqual(980);
    expect(s.max).toBeGreaterThanOrEqual(1010);
  });

  it("handles negatives, mixed signs and degenerate ranges", () => {
    const neg = niceScale(-50, -10, 5);
    expect(neg.max).toBe(0);
    expect(neg.min).toBeLessThanOrEqual(-50);
    const mixed = niceScale(-30, 70, 5);
    expect(mixed.min).toBeLessThanOrEqual(-30);
    expect(mixed.ticks).toContain(0);
    expect(niceScale(0, 0, 5)).toMatchObject({ min: 0, max: 1 });
    expect(niceScale(5, 5, 5).min).toBe(0);
    const tiny = niceScale(0, 0.37, 5);
    expect(tiny.step).toBe(0.1);
    expect(tiny.decimals).toBe(1);
    expect(tiny.ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
  });

  it("never exceeds the requested number of intervals", () => {
    for (const [lo, hi] of [
      [0, 7],
      [0, 999],
      [-1234, 5678],
      [0.001, 0.009],
      [12_000_000, 13_500_000],
    ]) {
      for (const max of [1, 2, 3, 5, 8, 12]) {
        const s = niceScale(lo, hi, max);
        expect(s.ticks.length - 1, `${lo}..${hi} / ${max}`).toBeLessThanOrEqual(max);
        expect(s.min).toBeLessThanOrEqual(lo);
        expect(s.max).toBeGreaterThanOrEqual(hi);
      }
    }
  });

  it("uses a fixed 0–100% scale for 100% stacked charts", () => {
    expect(percentScale(10).ticks).toHaveLength(11);
    expect(percentScale(6).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe("Spanish tick labels", () => {
  it("formats numbers with es-ES separators", () => {
    expect(formatNumber(1234.5, 1)).toBe("1234,5");
    expect(formatNumber(12345, 0)).toBe("12.345");
    expect(formatNumber(-0.25, 2)).toBe("-0,25");
    expect(formatPercent(0.25)).toBe("25%");
    const s = niceScale(0, 0.37, 5);
    expect(s.ticks.map((t) => formatTick(t, s, false))).toEqual(["0,0", "0,1", "0,2", "0,3", "0,4"]);
    const p = percentScale(5);
    expect(p.ticks.map((t) => formatTick(t, p, true))).toEqual(["0%", "20%", "40%", "60%", "80%", "100%"]);
  });
});
