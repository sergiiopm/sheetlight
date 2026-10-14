import { describe, expect, it } from "vitest";
import type { CellValue } from "@/engine/contract";
import { MAX_COLS, MAX_ROWS, type CellRange } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import {
  axisIndices,
  axisSpans,
  dataRangeFor,
  freeSheetName,
  guessHasHeader,
  hintToSelection,
  insertRowsOps,
  mergeOps,
  nextFontSize,
  parseReference,
  selectionForContextClick,
  sheetNameError,
  shiftCellsOps,
  smartStructureOps,
  styleOp,
} from "@/hooks/selection-ops";

const r = (r0: number, c0: number, r1: number, c1: number): CellRange => ({ r0, c0, r1, c1 });

function sel(ranges: CellRange[], kind: SelectionState["kind"] = "cells"): SelectionState {
  const last = ranges[ranges.length - 1];
  return { sheet: 1, ranges, activeRange: ranges.length - 1, active: { row: last.r0, col: last.c0 }, anchor: { row: last.r0, col: last.c0 }, kind };
}

const text = (value: string): CellValue => ({ type: "text", value });
const num = (value: number): CellValue => ({ type: "number", value });

describe("structure ops", () => {
  it("merges spans and applies them bottom-up", () => {
    expect(axisSpans([r(5, 0, 6, 0), r(1, 0, 2, 0), r(3, 0, 3, 0), r(10, 0, 10, 0)], "row")).toEqual([
      { index: 10, count: 1 },
      { index: 5, count: 2 },
      { index: 1, count: 3 },
    ]);
    expect(insertRowsOps(1, [r(2, 0, 3, 5), r(8, 1, 8, 1)])).toEqual([
      { type: "insertRows", sheet: 1, index: 8, count: 1 },
      { type: "insertRows", sheet: 1, index: 2, count: 2 },
    ]);
  });

  it("Ctrl++ acts directly on whole rows/columns and asks for plain cells", () => {
    const rows = sel([r(3, 0, 4, MAX_COLS - 1)], "rows");
    expect(smartStructureOps(rows, true)).toEqual([{ type: "insertRows", sheet: 1, index: 3, count: 2 }]);
    const cols = sel([r(0, 2, MAX_ROWS - 1, 2)], "cols");
    expect(smartStructureOps(cols, false)).toEqual([{ type: "deleteCols", sheet: 1, index: 2, count: 1 }]);
    expect(smartStructureOps(sel([r(1, 1, 2, 2)]), true)).toBeNull();
  });

  it("builds shift-cells ops for the dialog", () => {
    const s = sel([r(1, 1, 2, 2)]);
    expect(shiftCellsOps(s, true, "down")).toEqual([{ type: "insertCells", sheet: 1, range: r(1, 1, 2, 2), shift: "down" }]);
    expect(shiftCellsOps(s, false, "left")).toEqual([{ type: "deleteCells", sheet: 1, range: r(1, 1, 2, 2), shift: "left" }]);
    expect(shiftCellsOps(s, false, "entireRow")).toEqual([{ type: "deleteRows", sheet: 1, index: 1, count: 2 }]);
  });

  it("bounds axis indices for whole-sheet selections", () => {
    expect(axisIndices([r(0, 0, MAX_ROWS - 1, 0)], "row", 5)).toEqual([0, 1, 2, 3, 4]);
    expect(axisIndices([r(4, 0, 5, 0), r(1, 0, 1, 0)], "row", 100)).toEqual([1, 4, 5]);
  });
});

describe("format ops", () => {
  it("applies styles to every selected range", () => {
    const s = sel([r(0, 0, 1, 1), r(5, 5, 5, 5)]);
    expect(styleOp(s, { bold: true })).toEqual({ type: "setStyle", sheet: 1, ranges: s.ranges, patch: { bold: true } });
  });

  it("merges only multi-cell ranges", () => {
    expect(mergeOps(sel([r(0, 0, 0, 0), r(1, 0, 1, 3)]), "mergeCenter")).toEqual([
      { type: "merge", sheet: 1, range: r(1, 0, 1, 3), mode: "mergeCenter" },
    ]);
  });

  it("steps through Excel's font size ladder", () => {
    expect(nextFontSize(11, 1)).toBe(12);
    expect(nextFontSize(12, 1)).toBe(14);
    expect(nextFontSize(13, -1)).toBe(12);
    expect(nextFontSize(8, -1)).toBe(7);
    expect(nextFontSize(72, 1)).toBe(80);
  });
});

describe("selection helpers", () => {
  it("turns engine hints into selections", () => {
    expect(hintToSelection({ sheet: 2, ranges: [r(1, 1, 3, 3)], active: { row: 2, col: 2 } })).toEqual({
      sheet: 2,
      ranges: [r(1, 1, 3, 3)],
      activeRange: 0,
      active: { row: 2, col: 2 },
      anchor: { row: 2, col: 2 },
      kind: "cells",
    });
    expect(hintToSelection({ sheet: 1, ranges: [], active: { row: 4, col: 0 } }).ranges).toEqual([r(4, 0, 4, 0)]);
  });

  it("moves the selection on right click outside it", () => {
    const s = sel([r(0, 0, 3, 3)]);
    expect(selectionForContextClick(s, "cell", { row: 1, col: 1 })).toBeNull();
    expect(selectionForContextClick(s, "cell", { row: 9, col: 9 })?.ranges).toEqual([r(9, 9, 9, 9)]);
    const row = selectionForContextClick(s, "rowHeader", { row: 7, col: 0 });
    expect(row?.kind).toBe("rows");
    expect(row?.ranges).toEqual([r(7, 0, 7, MAX_COLS - 1)]);
    expect(selectionForContextClick(row!, "rowHeader", { row: 7, col: 0 })).toBeNull();
  });

  it("expands single cells to the used range for sort/filter", () => {
    const used = r(0, 0, 99, 4);
    expect(dataRangeFor(r(5, 2, 5, 2), used)).toEqual(used);
    expect(dataRangeFor(r(1, 1, 3, 3), used)).toEqual(r(1, 1, 3, 3));
    expect(dataRangeFor(r(0, 2, MAX_ROWS - 1, 2), used)).toEqual(r(0, 2, 99, 2));
    expect(dataRangeFor(r(5, 2, 5, 2), null)).toBeNull();
  });

  it("guesses header rows", () => {
    const range = r(0, 0, 1, 1);
    expect(guessHasHeader({ range, values: [[text("Nombre"), text("Importe")], [text("Ana"), num(5)]], display: [] })).toBe(true);
    expect(guessHasHeader({ range, values: [[text("b"), text("x")], [text("a"), text("y")]], display: [] })).toBe(false);
    expect(guessHasHeader({ range, values: [[num(1), text("x")], [num(2), num(3)]], display: [] })).toBe(false);
  });
});

describe("references and sheet names", () => {
  const sheets = [
    { id: 1, name: "Hoja1", hidden: false },
    { id: 7, name: "Mi hoja", hidden: false },
  ];

  it("parses Ir a references", () => {
    expect(parseReference("b7", sheets)).toEqual({ sheet: null, range: r(6, 1, 6, 1) });
    expect(parseReference("$A$1:$C$3", sheets)).toEqual({ sheet: null, range: r(0, 0, 2, 2) });
    expect(parseReference("'Mi hoja'!B2", sheets)).toEqual({ sheet: 7, range: r(1, 1, 1, 1) });
    expect(parseReference("hoja1!A1:A2", sheets)).toEqual({ sheet: 1, range: r(0, 0, 1, 0) });
    expect(parseReference("C:D", sheets)).toEqual({ sheet: null, range: r(0, 2, MAX_ROWS - 1, 3) });
    expect(parseReference("3:5", sheets)).toEqual({ sheet: null, range: r(2, 0, 4, MAX_COLS - 1) });
    expect(parseReference("Nada!A1", sheets)).toBeNull();
    expect(parseReference("hola", sheets)).toBeNull();
  });

  it("validates sheet names like Excel", () => {
    expect(sheetNameError("Ventas", sheets, null)).toBeNull();
    expect(sheetNameError("hoja1", sheets, null)).toBe("Ya existe una hoja con ese nombre.");
    expect(sheetNameError("hoja1", sheets, 1)).toBeNull();
    expect(sheetNameError("a/b", sheets, null)).not.toBeNull();
    expect(sheetNameError("", sheets, null)).not.toBeNull();
    expect(sheetNameError("x".repeat(32), sheets, null)).not.toBeNull();
    expect(freeSheetName(sheets)).toBe("Hoja3");
  });
});
