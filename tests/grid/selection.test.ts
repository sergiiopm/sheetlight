import { describe, expect, it } from "vitest";
import { MAX_COLS, MAX_ROWS, rangeName } from "@/engine/types";
import { createSelectionStore, singleCellSelection } from "@/model/selection";
import { MergeIndex } from "@/grid/geometry/MergeIndex";
import {
  addCell,
  cycleActive,
  extendTo,
  focusOf,
  isSingleCell,
  sameSelection,
  selectAll,
  selectCell,
  selectCols,
  selectedHeaderIndices,
  selectRows,
} from "@/grid/selection/selection";

const SHEET = 1;
const noMerges = new MergeIndex();
const names = (s: { ranges: ReadonlyArray<{ r0: number; c0: number; r1: number; c1: number }> }) => s.ranges.map(rangeName);
const noneHidden = () => false;

describe("selection (pure, Excel semantics)", () => {
  it("click, shift-extend, ctrl-add", () => {
    let s = selectCell(SHEET, { row: 3, col: 2 }, noMerges);
    expect(names(s)).toEqual(["C4"]);
    s = extendTo(s, { row: 6, col: 4 }, noMerges);
    expect(names(s)).toEqual(["C4:E7"]);
    expect(s.active).toEqual({ row: 3, col: 2 });
    expect(focusOf(s)).toEqual({ row: 6, col: 4 });
    s = addCell(s, { row: 10, col: 6 }, noMerges);
    expect(names(s)).toEqual(["C4:E7", "G11"]);
    expect(s.activeRange).toBe(1);
    expect(s.active).toEqual({ row: 10, col: 6 });
  });

  it("focus is the corner opposite the anchor, also when extending up-left", () => {
    let s = selectCell(SHEET, { row: 5, col: 5 }, noMerges);
    s = extendTo(s, { row: 2, col: 1 }, noMerges);
    expect(names(s)).toEqual(["B3:F6"]);
    expect(focusOf(s)).toEqual({ row: 2, col: 1 });
  });

  it("expands to merged cells", () => {
    const merges = new MergeIndex();
    merges.setAll([{ r0: 1, c0: 21, r1: 5, c1: 25 }]);
    const s = selectCell(SHEET, { row: 3, col: 23 }, merges);
    expect(names(s)).toEqual(["V2:Z6"]);
    expect(s.active).toEqual({ row: 1, col: 21 });
    expect(isSingleCell(s, merges)).toBe(true);
    const e = extendTo(selectCell(SHEET, { row: 3, col: 20 }, merges), { row: 3, col: 22 }, merges);
    expect(names(e)).toEqual(["U2:Z6"]);
  });

  it("row/column/all selection", () => {
    const base = selectCell(SHEET, { row: 4, col: 4 }, noMerges);
    const cols = selectCols(base, 3, 3, "replace", 7);
    expect(names(cols)).toEqual([`D1:D${MAX_ROWS}`]);
    expect(cols.active).toEqual({ row: 7, col: 3 });
    expect(cols.kind).toBe("cols");
    const cols2 = selectCols(cols, cols.active.col, 5, "extend", 7);
    expect(names(cols2)).toEqual([`D1:F${MAX_ROWS}`]);
    const rows = selectRows(base, 2, 4, "replace", 0);
    expect(rows.ranges[0]).toEqual({ r0: 2, r1: 4, c0: 0, c1: MAX_COLS - 1 });
    const all = selectAll(base);
    expect(all.kind).toBe("all");
    expect(all.active).toEqual({ row: 4, col: 4 });
    // Shift+arrow after select-all shrinks to cells.
    expect(extendTo(all, { row: 6, col: 6 }, noMerges).kind).toBe("cells");
  });

  it("Tab / Enter cycle the active cell inside the selection", () => {
    let s = extendTo(selectCell(SHEET, { row: 2, col: 3 }, noMerges), { row: 3, col: 4 }, noMerges); // D3:E4
    s = cycleActive(s, false, false, noneHidden, noMerges)!; // Enter: column-major
    expect(s.active).toEqual({ row: 3, col: 3 });
    s = cycleActive(s, false, false, noneHidden, noMerges)!;
    expect(s.active).toEqual({ row: 2, col: 4 });
    s = cycleActive(s, true, false, noneHidden, noMerges)!; // Tab: row-major
    expect(s.active).toEqual({ row: 3, col: 3 });
    s = cycleActive(s, true, true, noneHidden, noMerges)!; // Shift+Tab
    expect(s.active).toEqual({ row: 2, col: 4 });
    expect(names(s)).toEqual(["D3:E4"]);
    expect(cycleActive(selectCell(SHEET, { row: 0, col: 0 }, noMerges), true, false, noneHidden, noMerges)).toBeNull();
  });

  it("cycling skips hidden cells and merge interiors, and wraps across ranges", () => {
    const merges = new MergeIndex();
    merges.setAll([{ r0: 0, c0: 1, r1: 0, c1: 2 }]);
    let s = extendTo(selectCell(SHEET, { row: 0, col: 0 }, merges), { row: 0, col: 3 }, merges); // A1:D1 with B1:C1 merged
    s = cycleActive(s, true, false, noneHidden, merges)!;
    expect(s.active).toEqual({ row: 0, col: 1 });
    s = cycleActive(s, true, false, noneHidden, merges)!;
    expect(s.active).toEqual({ row: 0, col: 3 }); // C1 is inside the merge
    const two = addCell(extendTo(selectCell(SHEET, { row: 0, col: 0 }, noMerges), { row: 1, col: 0 }, noMerges), { row: 5, col: 5 }, noMerges);
    let t = cycleActive(two, false, false, (r) => r === 1, noMerges)!; // A2 hidden; active is F6 (range 1) -> wraps to range 0
    expect(t.active).toEqual({ row: 0, col: 0 });
    t = cycleActive(t, false, false, (r) => r === 1, noMerges)!;
    expect(t.active).toEqual({ row: 5, col: 5 });
  });

  it("selected header indices for multi-header resize", () => {
    let s = selectCols(singleCellSelection(SHEET), 2, 4, "replace", 0);
    s = selectCols(s, 8, 8, "add", 0);
    expect(selectedHeaderIndices(s, "col", 3, 100)).toEqual([2, 3, 4, 8]);
    expect(selectedHeaderIndices(s, "col", 6, 100)).toBeNull();
    expect(selectedHeaderIndices(s, "row", 3, 100)).toBeNull();
  });

  it("works with the model's SelectionStore", () => {
    const store = createSelectionStore(singleCellSelection(SHEET));
    const seen: string[] = [];
    store.subscribe((st) => seen.push(names(st).join(",")));
    const next = extendTo(store.get(), { row: 1, col: 1 }, noMerges);
    store.set(next);
    expect(seen).toEqual(["A1:B2"]);
    expect(sameSelection(store.get(), extendTo(singleCellSelection(SHEET), { row: 1, col: 1 }, noMerges))).toBe(true);
  });
});
