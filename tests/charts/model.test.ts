import { describe, expect, it } from "vitest";
import type { ChartSpec, RangeValues } from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import type { CellRange } from "@/engine/types";
import { CommandRegistry } from "@/model/commands";
import { createSelectionStore, singleCellSelection } from "@/model/selection";
import { CHART_INSERT_COMMAND, onChartInsertRequest, registerChartCommands, type ChartInsertRequest } from "@/charts/commands";
import { dragBox, lookOf, toUpdate } from "@/charts/controller";
import { chartDependencies, resolveChartData } from "@/charts/data";
import { anchorNextTo, anchorToBox, boxToAnchor, pointToCell, type GridGeometry } from "@/charts/geometry";
import { currentRegion, inferSeries, trimEmpty } from "@/charts/infer";

/** Fake grid geometry: 64 x 20 px cells, column B 100 px wide, origin scrolled by (sx, sy). */
function fakeGrid(zoom = 1, sx = 0, sy = 0): GridGeometry {
  const colLeft = (c: number) => (c <= 1 ? c * 64 : 64 + 100 + (c - 2) * 64);
  const colW = (c: number) => (c === 1 ? 100 : 64);
  return {
    getViewport: () => ({ topLeft: { row: 0, col: 0 }, zoom }),
    getRangeRect: (r: CellRange) => {
      const x = colLeft(r.c0) * zoom - sx;
      const y = r.r0 * 20 * zoom - sy;
      const w = (colLeft(r.c1) + colW(r.c1) - colLeft(r.c0)) * zoom;
      const h = (r.r1 - r.r0 + 1) * 20 * zoom;
      return new DOMRect(x, y, w, h);
    },
  };
}

// Node has no DOMRect.
if (typeof globalThis.DOMRect === "undefined") {
  class SimpleRect {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
    get left() {
      return this.x;
    }
    get top() {
      return this.y;
    }
    get right() {
      return this.x + this.width;
    }
    get bottom() {
      return this.y + this.height;
    }
  }
  (globalThis as unknown as { DOMRect: unknown }).DOMRect = SimpleRect;
}

function rv(range: CellRange, rows: Array<Array<string | number | null>>): RangeValues {
  return {
    range,
    values: rows.map((r) =>
      r.map((v) => (v === null ? { type: "empty" as const } : typeof v === "number" ? { type: "number" as const, value: v } : { type: "text" as const, value: v })),
    ),
    display: rows.map((r) => r.map((v) => (v === null ? "" : String(v).replace(".", ",")))),
  };
}

describe("series inference (Excel rules)", () => {
  it("first row names the series, first column holds categories", () => {
    const data = rv({ r0: 0, c0: 0, r1: 3, c1: 2 }, [
      ["Mes", "Ventas", "Costes"],
      ["Ene", 100, 60],
      ["Feb", 120, 70],
      ["Mar", 90, 50],
    ]);
    const inf = inferSeries(data, "Hoja1");
    expect(inf).toMatchObject({ headerRow: true, headerCol: true, orientation: "cols" });
    expect(inf.series).toEqual([
      { nameRef: "Hoja1!$B$1", name: "Ventas", categoriesRef: "Hoja1!$A$2:$A$4", valuesRef: "Hoja1!$B$2:$B$4", color: null },
      { nameRef: "Hoja1!$C$1", name: "Costes", categoriesRef: "Hoja1!$A$2:$A$4", valuesRef: "Hoja1!$C$2:$C$4", color: null },
    ]);
  });

  it("empty top-left cell means both headers; wide blocks go by rows", () => {
    const data = rv({ r0: 4, c0: 2, r1: 6, c1: 7 }, [
      [null, "Ene", "Feb", "Mar", "Abr", "May"],
      ["Norte", 1, 2, 3, 4, 5],
      ["Sur", 5, 4, 3, 2, 1],
    ]);
    const inf = inferSeries(data, "Mi hoja");
    expect(inf.orientation).toBe("rows");
    expect(inf.series).toHaveLength(2);
    expect(inf.series[0]).toMatchObject({
      nameRef: "'Mi hoja'!$C$6",
      categoriesRef: "'Mi hoja'!$D$5:$H$5",
      valuesRef: "'Mi hoja'!$D$6:$H$6",
    });
    const byCols = inferSeries(data, "Mi hoja", { orientation: "cols" });
    expect(byCols.series).toHaveLength(5);
    expect(byCols.series[0]).toMatchObject({ nameRef: "'Mi hoja'!$D$5", categoriesRef: "'Mi hoja'!$C$6:$C$7" });
  });

  it("numbers only: no headers, categories 1..n", () => {
    const inf = inferSeries(rv({ r0: 0, c0: 0, r1: 2, c1: 1 }, [[1, 2], [3, 4], [5, 6]]), "Hoja1");
    expect(inf.headerRow || inf.headerCol).toBe(false);
    expect(inf.series.map((s) => s.categoriesRef)).toEqual([null, null]);
    expect(inf.series[0].name).toBeNull();
  });

  it("treats a first column of dates as categories", () => {
    const data: RangeValues = {
      range: { r0: 0, c0: 0, r1: 2, c1: 1 },
      values: [
        [{ type: "text", value: "Fecha" }, { type: "text", value: "Importe" }],
        [{ type: "number", value: 45658 }, { type: "number", value: 10 }],
        [{ type: "number", value: 45659 }, { type: "number", value: 12 }],
      ],
      display: [
        ["Fecha", "Importe"],
        ["01/01/2025", "10"],
        ["02/01/2025", "12"],
      ],
    };
    const inf = inferSeries(data, "Hoja1");
    expect(inf.headerCol).toBe(true);
    expect(inf.series).toHaveLength(1);
    expect(inf.series[0].categoriesRef).toBe("Hoja1!$A$2:$A$3");
  });

  it("scatter uses the first numeric column as X", () => {
    const data = rv({ r0: 0, c0: 0, r1: 3, c1: 2 }, [
      ["X", "Y1", "Y2"],
      [1, 2, 3],
      [2, 4, 6],
      [3, 6, 9],
    ]);
    const inf = inferSeries(data, "Hoja1", { chartType: "scatter" });
    expect(inf.series).toHaveLength(2);
    expect(inf.series[0]).toMatchObject({ categoriesRef: "Hoja1!$A$2:$A$4", valuesRef: "Hoja1!$B$2:$B$4", nameRef: "Hoja1!$B$1" });
  });

  it("trims empty borders", () => {
    const data = rv({ r0: 0, c0: 0, r1: 3, c1: 3 }, [
      [null, null, null, null],
      [null, "a", 1, null],
      [null, "b", 2, null],
      [null, null, null, null],
    ]);
    expect(trimEmpty(data)).toEqual({ r0: 1, c0: 1, r1: 2, c1: 2 });
  });
});

async function seeded() {
  const engine = new MemoryEngine();
  const info = await engine.newDocument();
  const sheet = info.activeSheet;
  const rows = [
    ["Mes", "Ventas", "Costes"],
    ["Ene", "100", "60"],
    ["Feb", "120", "70"],
    ["Mar", "", "#N/A"],
    ["Abr", "texto", "80"],
  ];
  await engine.apply(info.doc, [
    {
      type: "setCells",
      sheet,
      cells: rows.flatMap((r, row) => r.map((input, col) => ({ row: row + 2, col: col + 1, input }))),
    },
  ]);
  return { engine, doc: info.doc, sheet, sheets: (await engine.getDocumentInfo(info.doc)).sheets };
}

describe("chart data from the engine", () => {
  it("expands a single cell to the current region", async () => {
    const { engine, doc, sheet } = await seeded();
    expect(await currentRegion(engine, doc, sheet, { row: 4, col: 2 })).toEqual({ r0: 2, c0: 1, r1: 6, c1: 3 });
    expect(await currentRegion(engine, doc, sheet, { row: 20, col: 20 })).toEqual({ r0: 20, c0: 20, r1: 20, c1: 20 });
  });

  it("resolves series values, names, categories, gaps and text as zero", async () => {
    const { engine, doc, sheet, sheets } = await seeded();
    const range = { r0: 2, c0: 1, r1: 6, c1: 3 };
    const inf = inferSeries(await engine.getRangeValues(doc, sheet, range), "Hoja1");
    const data = await resolveChartData(engine, doc, { sheet, type: "column", series: inf.series }, sheets);
    expect(data.categories).toEqual(["Ene", "Feb", "Mar", "Abr"]);
    expect(data.series.map((s) => s.name)).toEqual(["Ventas", "Costes"]);
    expect(data.series[0].values).toEqual([100, 120, null, 0]);
    expect(data.series[1].values).toEqual([60, 70, null, 80]);
    expect(data.series[0].color).toBe("#4472C4");
    expect(data.series[1].color).toBe("#ED7D31");
  });

  it("falls back to 1..n categories and SerieN names; unknown sheets give empty series", async () => {
    const { engine, doc, sheet, sheets } = await seeded();
    const data = await resolveChartData(
      engine,
      doc,
      {
        sheet,
        type: "line",
        series: [
          { nameRef: null, name: null, categoriesRef: null, valuesRef: "C4:C5", color: "#123456" },
          { nameRef: null, name: null, categoriesRef: null, valuesRef: "Otra!A1:A3", color: null, chartType: "column" },
        ],
      },
      sheets,
    );
    expect(data.categories).toEqual(["1", "2"]);
    expect(data.series[0]).toMatchObject({ name: "Serie1", values: [100, 120], color: "#123456", type: "line" });
    expect(data.series[1]).toMatchObject({ name: "Serie2", values: [], type: "column" });
  });

  it("clamps whole-column references to the used range", async () => {
    const { engine, doc, sheet, sheets } = await seeded();
    const data = await resolveChartData(
      engine,
      doc,
      { sheet, type: "column", series: [{ nameRef: null, name: "x", categoriesRef: null, valuesRef: "Hoja1!$C:$C", color: null }] },
      sheets,
    );
    expect(data.series[0].values).toEqual([0, 100, 120, null, 0]);
  });

  it("lists dependencies per sheet for change tracking", async () => {
    const { sheets, sheet } = await seeded();
    const deps = chartDependencies(
      { sheet, series: [{ nameRef: "Hoja1!$B$1", name: null, categoriesRef: "A2:A4", valuesRef: "Hoja1!$B$2:$B$4", color: null }] },
      sheets,
    );
    expect(deps).toEqual([
      { sheet, range: { r0: 1, c0: 1, r1: 3, c1: 1 } },
      { sheet, range: { r0: 1, c0: 0, r1: 3, c1: 0 } },
      { sheet, range: { r0: 0, c0: 1, r1: 0, c1: 1 } },
    ]);
  });
});

describe("anchor geometry", () => {
  const anchor = { from: { row: 1, col: 2, dx: 10, dy: 5 }, to: { row: 10, col: 6, dx: 0, dy: 0 } };

  it("converts anchors to boxes with zoom and scroll", () => {
    expect(anchorToBox(fakeGrid(), anchor)).toEqual({ x: 174, y: 25, w: 246, h: 175 });
    const zoomed = anchorToBox(fakeGrid(2, 100, 40), anchor);
    expect(zoomed).toEqual({ x: 174 * 2 - 100, y: 25 * 2 - 40, w: 246 * 2, h: 175 * 2 });
  });

  it("round-trips boxes to anchors (offsets at 100%)", () => {
    for (const g of [fakeGrid(), fakeGrid(1.5, 33, 17), fakeGrid(0.5)]) {
      const box = anchorToBox(g, anchor);
      const back = boxToAnchor(g, box);
      expect(back.from).toMatchObject({ row: 1, col: 2 });
      expect(back.from.dx).toBeCloseTo(10, 1);
      expect(back.from.dy).toBeCloseTo(5, 1);
      expect(back.to).toMatchObject({ row: 10, col: 6 });
    }
  });

  it("finds the cell under a point, clamping before the first cell", () => {
    expect(pointToCell(fakeGrid(), 64 + 99, 39)).toEqual({ row: 1, col: 1, dx: 99, dy: 19 });
    expect(pointToCell(fakeGrid(), -20, -5)).toEqual({ row: 0, col: 0, dx: 0, dy: 0 });
  });

  it("places new charts two columns right of the data, 480x288", () => {
    const g = fakeGrid();
    const a = anchorNextTo(g, { r0: 3, c0: 0, r1: 12, c1: 2 });
    expect(a.from).toEqual({ row: 3, col: 4, dx: 0, dy: 0 });
    const box = anchorToBox(g, a);
    expect(box.w).toBeCloseTo(480, 0);
    expect(box.h).toBeCloseTo(288, 0);
    expect(anchorNextTo(null, { r0: 0, c0: 0, r1: 5, c1: 1 }).from).toEqual({ row: 0, col: 3, dx: 0, dy: 0 });
  });

  it("moves and resizes boxes from handles (min size, aspect ratio)", () => {
    const start = { x: 100, y: 100, w: 200, h: 100 };
    expect(dragBox(start, "move", 15, -5, false)).toEqual({ x: 115, y: 95, w: 200, h: 100 });
    expect(dragBox(start, "se", 50, 20, false)).toEqual({ x: 100, y: 100, w: 250, h: 120 });
    expect(dragBox(start, "nw", 20, 10, false)).toEqual({ x: 120, y: 110, w: 180, h: 90 });
    expect(dragBox(start, "e", -500, 0, false).w).toBe(24);
    const ratio = dragBox(start, "se", 100, 0, true);
    expect(ratio.w / ratio.h).toBeCloseTo(2);
  });
});

describe("chart commands", () => {
  it("registers chart.insert and forwards the selection to the mounted layer", async () => {
    const registry = new CommandRegistry();
    const engine = new MemoryEngine();
    const info = await engine.newDocument();
    const selection = createSelectionStore(singleCellSelection(info.activeSheet, { row: 3, col: 1 }));
    let readOnly = false;
    registerChartCommands(registry, () => ({ engine, doc: info.doc, sheet: info.activeSheet, selection, readOnly }));
    const cmd = registry.get(CHART_INSERT_COMMAND);
    expect(cmd?.label).toBe("Insertar gráfico");
    const got: ChartInsertRequest[] = [];
    const off = onChartInsertRequest(info.doc, (r) => got.push(r));
    expect(await registry.run(CHART_INSERT_COMMAND)).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ doc: info.doc, sheet: info.activeSheet, active: { row: 3, col: 1 } });
    readOnly = true;
    expect(await registry.run(CHART_INSERT_COMMAND)).toBe(false);
    off();
  });

  it("builds updateChart payloads without fromFile", () => {
    const spec: ChartSpec = {
      id: 4,
      sheet: 1,
      type: "column",
      title: "T",
      series: [],
      anchor: { from: { row: 0, col: 0, dx: 0, dy: 0 }, to: { row: 5, col: 5, dx: 0, dy: 0 } },
      legend: "right",
      grouping: "clustered",
      xAxisTitle: null,
      yAxisTitle: null,
      fromFile: true,
    };
    expect("fromFile" in toUpdate(spec)).toBe(false);
    expect(lookOf(spec)).toEqual({ type: "column", grouping: "clustered", title: "T", legend: "right", xAxisTitle: null, yAxisTitle: null });
  });
});
