import { MAX_COLS, MAX_ROWS, normRange, rangeContains, type CellAddress, type CellRange, type SheetId } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import type { MergeLookup } from "../geometry/MergeIndex";
import { sameCell, sameRange } from "../core/util";

/**
 * Excel selection semantics as pure functions over `SelectionState`
 * (`src/model/selection.ts`). Every function returns a new state; the grid
 * writes it to the `SelectionStore`. Ranges are always expanded to fully
 * contain any merged cell they touch.
 */

export type SelectMode = "replace" | "add" | "extend";

const ALL: CellRange = { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 };

/** Top-left of the merge containing the cell (or the cell itself). */
export function anchorCell(merges: MergeLookup, cell: CellAddress): CellAddress {
  const m = merges.at(cell.row, cell.col);
  return m ? { row: m.r0, col: m.c0 } : cell;
}

/**
 * The moving corner of the active range (what Shift+Arrow moves): the corner
 * opposite the anchor.
 */
export function focusOf(s: SelectionState): CellAddress {
  const r = s.ranges[s.activeRange] ?? s.ranges[0];
  const a = s.anchor;
  const row = a.row === r.r0 ? r.r1 : a.row === r.r1 ? r.r0 : r.r1;
  const col = a.col === r.c0 ? r.c1 : a.col === r.c1 ? r.c0 : r.c1;
  if (s.kind === "rows") return { row, col: s.active.col };
  if (s.kind === "cols") return { row: s.active.row, col };
  return { row, col };
}

/** Plain click / arrow move: single cell (or its merge). */
export function selectCell(sheet: SheetId, cell: CellAddress, merges: MergeLookup): SelectionState {
  const a = anchorCell(merges, cell);
  return {
    sheet,
    ranges: [merges.expand({ r0: a.row, c0: a.col, r1: a.row, c1: a.col })],
    activeRange: 0,
    active: a,
    anchor: a,
    kind: "cells",
  };
}

/** Ctrl+click: start an additional range. */
export function addCell(s: SelectionState, cell: CellAddress, merges: MergeLookup): SelectionState {
  const a = anchorCell(merges, cell);
  const ranges = [...s.ranges, merges.expand({ r0: a.row, c0: a.col, r1: a.row, c1: a.col })];
  return { sheet: s.sheet, ranges, activeRange: ranges.length - 1, active: a, anchor: a, kind: "cells" };
}

/** Shift+click / drag / Shift+arrow: the active range spans anchor..cell. */
export function extendTo(s: SelectionState, cell: CellAddress, merges: MergeLookup): SelectionState {
  let r: CellRange;
  const a = s.anchor;
  if (s.kind === "rows") r = { r0: Math.min(a.row, cell.row), r1: Math.max(a.row, cell.row), c0: 0, c1: MAX_COLS - 1 };
  else if (s.kind === "cols") r = { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(a.col, cell.col), c1: Math.max(a.col, cell.col) };
  else r = merges.expand(normRange(a, cell));
  const ranges = s.ranges.slice();
  ranges[s.activeRange] = r;
  const kind = s.kind === "all" && !sameRange(r, ALL) ? "cells" : s.kind;
  return { ...s, ranges, kind };
}

/** Row header click/drag. The active cell keeps `activeCol` (Excel: first visible column). */
export function selectRows(s: SelectionState, r0: number, r1: number, mode: SelectMode, activeCol: number): SelectionState {
  if (mode === "extend" && s.kind === "rows") return extendTo(s, { row: r1, col: s.active.col }, NO_MERGES);
  const range: CellRange = { r0: Math.min(r0, r1), r1: Math.max(r0, r1), c0: 0, c1: MAX_COLS - 1 };
  const ranges = mode === "add" ? [...s.ranges, range] : [range];
  const active = { row: r0, col: activeCol };
  return { sheet: s.sheet, ranges, activeRange: ranges.length - 1, active, anchor: active, kind: "rows" };
}

/** Column header click/drag. */
export function selectCols(s: SelectionState, c0: number, c1: number, mode: SelectMode, activeRow: number): SelectionState {
  if (mode === "extend" && s.kind === "cols") return extendTo(s, { row: s.active.row, col: c1 }, NO_MERGES);
  const range: CellRange = { r0: 0, r1: MAX_ROWS - 1, c0: Math.min(c0, c1), c1: Math.max(c0, c1) };
  const ranges = mode === "add" ? [...s.ranges, range] : [range];
  const active = { row: activeRow, col: c0 };
  return { sheet: s.sheet, ranges, activeRange: ranges.length - 1, active, anchor: active, kind: "cols" };
}

/** Corner click / Ctrl+A: whole sheet; the active cell stays. */
export function selectAll(s: SelectionState): SelectionState {
  return { sheet: s.sheet, ranges: [ALL], activeRange: 0, active: s.active, anchor: s.active, kind: "all" };
}

/** A single cell or exactly one merged cell. */
export function isSingleCell(s: SelectionState, merges: MergeLookup): boolean {
  if (s.ranges.length !== 1) return false;
  const r = s.ranges[0];
  const m = merges.at(r.r0, r.c0);
  if (m) return sameRange(m, r);
  return r.r0 === r.r1 && r.c0 === r.c1;
}

/**
 * Tab / Enter inside a multi-cell selection: move the active cell through
 * the active range (row-major for Tab, column-major for Enter), wrapping to
 * the next range; hidden cells and merge interiors are skipped. Returns null
 * if the selection is a single cell (the caller moves instead).
 */
export function cycleActive(
  s: SelectionState,
  byRow: boolean,
  backwards: boolean,
  isHidden: (row: number, col: number) => boolean,
  merges: MergeLookup,
): SelectionState | null {
  if (isSingleCell(s, merges)) return null;
  const ranges = s.ranges;
  let { row, col } = s.active;
  let idx = s.activeRange;
  const step = backwards ? -1 : 1;
  // Bounded search (whole-column ranges are huge).
  for (let guard = 0; guard < 100_000; guard++) {
    const r = ranges[idx];
    if (byRow) {
      col += step;
      if (col > r.c1 || col < r.c0) {
        col = backwards ? r.c1 : r.c0;
        row += step;
        if (row > r.r1 || row < r.r0) {
          idx = (idx + step + ranges.length) % ranges.length;
          const n = ranges[idx];
          row = backwards ? n.r1 : n.r0;
          col = backwards ? n.c1 : n.c0;
        }
      }
    } else {
      row += step;
      if (row > r.r1 || row < r.r0) {
        row = backwards ? r.r1 : r.r0;
        col += step;
        if (col > r.c1 || col < r.c0) {
          idx = (idx + step + ranges.length) % ranges.length;
          const n = ranges[idx];
          row = backwards ? n.r1 : n.r0;
          col = backwards ? n.c1 : n.c0;
        }
      }
    }
    if (isHidden(row, col)) continue;
    const m = merges.at(row, col);
    if (m && (m.r0 !== row || m.c0 !== col)) continue;
    break;
  }
  const active = { row, col };
  return { ...s, activeRange: idx, active, anchor: active };
}

export function sameSelection(a: SelectionState, b: SelectionState): boolean {
  if (a === b) return true;
  if (a.sheet !== b.sheet || a.kind !== b.kind || a.activeRange !== b.activeRange) return false;
  if (!sameCell(a.active, b.active) || !sameCell(a.anchor, b.anchor)) return false;
  if (a.ranges.length !== b.ranges.length) return false;
  for (let i = 0; i < a.ranges.length; i++) if (!sameRange(a.ranges[i], b.ranges[i])) return false;
  return true;
}

export function selectionContains(s: SelectionState, row: number, col: number): boolean {
  for (const r of s.ranges) if (rangeContains(r, row, col)) return true;
  return false;
}

/** Whole columns selected by header that contain `col` (multi-header resize). */
export function selectedHeaderIndices(s: SelectionState, axis: "row" | "col", index: number, limit: number): number[] | null {
  const kindOk = axis === "col" ? s.kind === "cols" || s.kind === "all" : s.kind === "rows" || s.kind === "all";
  if (!kindOk) return null;
  const hit = s.ranges.some((r) => (axis === "col" ? index >= r.c0 && index <= r.c1 : index >= r.r0 && index <= r.r1));
  if (!hit) return null;
  const set = new Set<number>();
  for (const r of s.ranges) {
    const a = axis === "col" ? r.c0 : r.r0;
    const b = Math.min(axis === "col" ? r.c1 : r.r1, limit);
    for (let i = a; i <= b; i++) set.add(i);
  }
  set.add(index);
  return [...set].sort((x, y) => x - y);
}

const NO_MERGES: MergeLookup = { at: () => null, expand: (r) => r };
