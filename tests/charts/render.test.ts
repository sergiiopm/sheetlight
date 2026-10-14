import { describe, expect, it } from "vitest";
import type { ChartData, ChartLook } from "@/charts/data";
import { fitText, layoutChart, renderChart } from "@/charts/render";
import { OFFICE_PALETTE } from "@/charts/theme";
import { FakeContext } from "./fake-canvas";

const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun"];

function data(type: ChartData["series"][number]["type"], seriesCount = 2, categories = months): ChartData {
  return {
    categories,
    series: Array.from({ length: seriesCount }, (_, s) => ({
      name: `Serie ${s + 1}`,
      values: categories.map((_, i) => (i + 1) * 100 + s * 50),
      xValues: null,
      color: OFFICE_PALETTE[s],
      type,
    })),
  };
}

function look(partial: Partial<ChartLook> = {}): ChartLook {
  return { type: "column", grouping: "clustered", title: "Ventas", legend: "bottom", xAxisTitle: null, yAxisTitle: null, ...partial };
}

describe("chart layout", () => {
  it("reserves title, legend and axis label space inside the chart", () => {
    const ctx = new FakeContext();
    const l = layoutChart(ctx, 480, 288, look({ yAxisTitle: "Euros", xAxisTitle: "Mes" }), data("column"));
    expect(l.title?.lines).toEqual(["Ventas"]);
    expect(l.legend?.items.map((i) => i.label)).toEqual(["Serie 1", "Serie 2"]);
    // Legend at the bottom, below the plot.
    expect(l.legend!.rect.y).toBeGreaterThan(l.plot.y + l.plot.h);
    // Plot is inside the chart with room for value labels on the left.
    expect(l.plot.x).toBeGreaterThan(30);
    expect(l.plot.x + l.plot.w).toBeLessThanOrEqual(480);
    expect(l.plot.y).toBeGreaterThan(20);
    expect(l.plot.y + l.plot.h).toBeLessThan(l.legend!.rect.y);
    expect(l.valueScale?.min).toBe(0);
    expect(l.valueScale!.max).toBeGreaterThanOrEqual(650);
    expect(l.categoryAxis).toMatchObject({ rotation: 0, every: 1 });
  });

  it("rotates and skips crowded category labels", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Categoría número ${i + 1}`);
    const l = layoutChart(new FakeContext(), 480, 288, look(), data("column", 1, many));
    expect(l.categoryAxis?.rotation).toBe(-45);
    expect(l.categoryAxis!.every).toBeGreaterThan(1);
    // Rotated labels never take more than 40% of the height.
    expect(l.plot.h).toBeGreaterThan(288 * 0.3);
  });

  it("wraps two-word labels instead of rotating when that fits", () => {
    const cats = ["Zona norte", "Zona sur", "Zona este"];
    const l = layoutChart(new FakeContext(), 300, 288, look({ legend: "none" }), data("column", 1, cats));
    expect(l.categoryAxis?.rotation).toBe(0);
    expect(l.categoryAxis?.lines.length).toBe(3);
  });

  it("puts a right legend beside the plot and gives up the plot width", () => {
    const l = layoutChart(new FakeContext(), 480, 288, look({ legend: "right" }), data("line"));
    expect(l.legend!.rect.x).toBeGreaterThan(l.plot.x + l.plot.w);
    expect(l.legend!.items[0].kind).toBe("line");
  });

  it("uses a 0–100% axis for 100% stacked and stacks totals otherwise", () => {
    const pct = layoutChart(new FakeContext(), 480, 288, look({ grouping: "percentStacked" }), data("column"));
    expect(pct.percent).toBe(true);
    expect(pct.valueScale).toMatchObject({ min: 0, max: 1 });
    const stacked = layoutChart(new FakeContext(), 480, 288, look({ grouping: "stacked" }), data("column"));
    // Last category: 600 + 650 = 1250.
    expect(stacked.valueScale!.max).toBeGreaterThanOrEqual(1250);
  });

  it("lays out horizontal bars with categories on the left", () => {
    const l = layoutChart(new FakeContext(), 480, 288, look({ type: "bar" }), data("bar"));
    expect(l.horizontal).toBe(true);
    expect(l.plot.x).toBeGreaterThan(10);
    expect(l.categoryAxis?.lines.map((x) => x[0])).toEqual(months);
  });

  it("pie legends list categories; scatter gets two numeric scales", () => {
    const pie = layoutChart(new FakeContext(), 400, 300, look({ type: "pie", legend: "right" }), data("pie", 1));
    expect(pie.legend?.items.map((i) => i.label)).toEqual(months);
    expect(pie.valueScale).toBeNull();
    const sc: ChartData = {
      categories: [],
      series: [{ name: "S", values: [1, 5, 3], xValues: [10, 20, 35], color: "#4472C4", type: "scatter" }],
    };
    const l = layoutChart(new FakeContext(), 480, 288, look({ type: "scatter", legend: "none" }), sc);
    expect(l.xScale!.min).toBeLessThanOrEqual(10);
    expect(l.xScale!.max).toBeGreaterThanOrEqual(35);
    expect(l.valueScale!.max).toBeGreaterThanOrEqual(5);
  });

  it("truncates long texts with an ellipsis", () => {
    const ctx = new FakeContext();
    ctx.font = "10px x";
    expect(fitText(ctx, "abcdefghij", 100)).toBe("abcdefghij");
    const t = fitText(ctx, "abcdefghijklmnopqrstuvwxyz", 50);
    expect(t.endsWith("…")).toBe(true);
    expect(ctx.measureText(t).width).toBeLessThanOrEqual(50);
  });
});

describe("chart drawing", () => {
  it("draws clustered columns side by side with the series colors", () => {
    const ctx = new FakeContext();
    const l = renderChart(ctx, 480, 288, look({ legend: "none" }), data("column"));
    const blue = ctx.rects(OFFICE_PALETTE[0]).filter(([, , w]) => w < 100);
    const orange = ctx.rects(OFFICE_PALETTE[1]).filter(([, , w]) => w < 100);
    expect(blue).toHaveLength(6);
    expect(orange).toHaveLength(6);
    // Same slot, orange right of blue; bars grow upwards from the baseline.
    expect(orange[0][0]).toBeGreaterThan(blue[0][0]);
    const base = l.plot.y + l.plot.h;
    expect(Math.abs(blue[0][1] + blue[0][3] - base)).toBeLessThan(1);
    // Taller value -> taller bar.
    expect(blue[5][3]).toBeGreaterThan(blue[0][3]);
    // White background first, Spanish tick labels, category labels.
    expect(ctx.calls[0]).toMatchObject({ op: "fillRect", fillStyle: "#FFFFFF" });
    expect(ctx.texts()).toEqual(expect.arrayContaining(["0", "Ene", "Jun", "Ventas"]));
  });

  it("stacks columns on top of each other", () => {
    const ctx = new FakeContext();
    renderChart(ctx, 480, 288, look({ grouping: "stacked", legend: "none" }), data("column"));
    const blue = ctx.rects(OFFICE_PALETTE[0]).filter(([, , w]) => w < 100);
    const orange = ctx.rects(OFFICE_PALETTE[1]).filter(([, , w]) => w < 100);
    expect(orange[0][0]).toBeCloseTo(blue[0][0]);
    expect(orange[0][1] + orange[0][3]).toBeCloseTo(blue[0][1]);
  });

  it("draws horizontal bars with the first category at the bottom", () => {
    const ctx = new FakeContext();
    renderChart(ctx, 480, 288, look({ type: "bar", legend: "none" }), data("bar", 1));
    const bars = ctx.rects(OFFICE_PALETTE[0]).filter(([, , , h]) => h < 100);
    expect(bars).toHaveLength(6);
    expect(bars[0][1]).toBeGreaterThan(bars[5][1]);
    expect(bars[5][2]).toBeGreaterThan(bars[0][2]);
  });

  it("draws lines with markers, breaking at gaps", () => {
    const ctx = new FakeContext();
    const d: ChartData = {
      categories: months,
      series: [{ name: "L", values: [1, 2, null, 4, 5, 6], xValues: null, color: "#ED7D31", type: "line" }],
    };
    renderChart(ctx, 480, 288, look({ type: "line", grouping: "standard", legend: "none" }), d);
    const markers = ctx.calls.filter((c) => c.op === "arc" && c.fillStyle === "#ED7D31");
    expect(markers).toHaveLength(5);
    const moves = ctx.calls.filter((c) => c.op === "moveTo" && c.strokeStyle === "#ED7D31");
    expect(moves.length).toBeGreaterThanOrEqual(2);
  });

  it("draws pie slices with percentage labels", () => {
    const ctx = new FakeContext();
    const d: ChartData = {
      categories: ["A", "B"],
      series: [{ name: "P", values: [75, 25], xValues: null, color: "#000000", type: "pie" }],
    };
    renderChart(ctx, 400, 300, look({ type: "pie", grouping: "standard" }), d);
    expect(ctx.texts()).toEqual(expect.arrayContaining(["75%", "25%", "A", "B"]));
    const slices = ctx.calls.filter((c) => c.op === "fill" && OFFICE_PALETTE.slice(0, 2).includes(c.fillStyle));
    expect(slices).toHaveLength(2);
  });

  it("compact mode draws no text", () => {
    const ctx = new FakeContext();
    renderChart(ctx, 92, 56, look({ yAxisTitle: "Y" }), data("column"), { compact: true });
    expect(ctx.texts()).toEqual([]);
  });

  it("survives empty and degenerate data", () => {
    for (const type of ["column", "bar", "line", "area", "pie", "doughnut", "scatter"] as const) {
      const ctx = new FakeContext();
      expect(() => renderChart(ctx, 200, 120, look({ type }), { categories: [], series: [] })).not.toThrow();
      expect(() => renderChart(ctx, 10, 10, look({ type }), data(type))).not.toThrow();
    }
  });
});
