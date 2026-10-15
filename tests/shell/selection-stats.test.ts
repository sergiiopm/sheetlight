import { describe, expect, it } from "vitest";
import { rangeSelection } from "@/hooks/selection-ops";
import {
  formatStatNumber,
  loadLabel,
  loadPercent,
  selectionCellCount,
  statItems,
  statSummary,
  wantsStats,
} from "@/hooks/selection-stats";
import { singleCellSelection } from "@/model/selection";
import { controllerSetup } from "./helpers";

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("status bar statistics", () => {
  it("counts cells and only wants stats for more than one cell", () => {
    expect(selectionCellCount([{ r0: 0, c0: 0, r1: 2, c1: 1 }])).toBe(6);
    expect(wantsStats(singleCellSelection(1))).toBe(false);
    expect(wantsStats(rangeSelection(1, { r0: 0, c0: 0, r1: 1, c1: 0 }))).toBe(true);
    const multi = { ...singleCellSelection(1), ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }, { r0: 3, c0: 3, r1: 3, c1: 3 }] };
    expect(wantsStats(multi)).toBe(true);
  });

  it("formats numbers with Spanish separators", () => {
    expect(formatStatNumber(1234.5)).toBe("1234,5".replace("1234", "1.234"));
    expect(formatStatNumber(-0.25)).toBe("-0,25");
    expect(formatStatNumber(2 / 3)).toBe("0,6666666667");
    expect(formatStatNumber(1e20)).toBe("1,00000E+20");
    expect(formatStatNumber(Number.NaN)).toBe("#¡NUM!");
  });

  it("lists Promedio, Recuento and Suma like Excel", () => {
    const numbers = { count: 3, numericCount: 3, sum: 6, average: 2, min: 1, max: 3 };
    expect(statItems(numbers).map((i) => `${i.label}=${i.value}`)).toEqual(["Promedio=2", "Recuento=3", "Suma=6"]);
    expect(statSummary(numbers)).toBe("Promedio: 2 · Recuento: 3 · Suma: 6");
    const text = { count: 4, numericCount: 0, sum: 0, average: null, min: null, max: null };
    expect(statItems(text).map((i) => i.label)).toEqual(["Recuento"]);
    expect(statItems({ ...text, count: 0 })).toEqual([]);
    expect(statItems(null)).toEqual([]);
  });

  it("describes CSV loading progress", () => {
    const load = { rowsLoaded: 120000, bytesRead: 35, bytesTotal: 100, done: false, error: null };
    expect(loadPercent(load)).toBe(35);
    expect(loadLabel(load)).toBe("Cargando… 120.000 filas (35 %)");
    expect(loadLabel({ ...load, rowsLoaded: 1, bytesTotal: 0 })).toBe("Cargando… 1 fila");
    expect(loadLabel({ ...load, done: true })).toBeNull();
    expect(loadLabel({ ...load, error: "disco lleno" })).toBe("Error al cargar: disco lleno");
    expect(loadLabel(null)).toBeNull();
  });

  it("tracks the active selection through the engine", async () => {
    const { controller, session, engine } = await controllerSetup();
    await engine.apply(session.doc, [
      {
        type: "setCells",
        sheet: session.activeSheet,
        cells: [
          { row: 0, col: 0, input: "1" },
          { row: 1, col: 0, input: "2" },
          { row: 2, col: 0, input: "texto" },
        ],
      },
    ]);
    session.selection.set(rangeSelection(session.activeSheet, { r0: 0, c0: 0, r1: 3, c1: 0 }));
    await flush();
    expect(controller.stats.stats.get()).toMatchObject({ count: 3, numericCount: 2, sum: 3, average: 1.5 });
    session.selection.set(singleCellSelection(session.activeSheet));
    await flush();
    expect(controller.stats.stats.get()).toBeNull();
  });

  it("resets when another workbook becomes active", async () => {
    const { controller, session } = await controllerSetup();
    session.selection.set(rangeSelection(session.activeSheet, { r0: 0, c0: 0, r1: 3, c1: 0 }));
    await flush();
    expect(controller.stats.stats.get()).toMatchObject({ count: 0 });
    await controller.manager.newWorkbook();
    expect(controller.stats.stats.get()).toBeNull();
  });
});
