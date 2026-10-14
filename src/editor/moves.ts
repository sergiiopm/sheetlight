import { MAX_COLS, MAX_ROWS, rangeCellCount, type CellAddress, type Direction } from "@/engine/types";
import type { SelectionState } from "@/model/selection";

/** One cell in a direction, clamped to the sheet. */
export function moveCell(cell: CellAddress, dir: Direction): CellAddress {
  switch (dir) {
    case "up":
      return { row: Math.max(0, cell.row - 1), col: cell.col };
    case "down":
      return { row: Math.min(MAX_ROWS - 1, cell.row + 1), col: cell.col };
    case "left":
      return { row: cell.row, col: Math.max(0, cell.col - 1) };
    case "right":
      return { row: cell.row, col: Math.min(MAX_COLS - 1, cell.col + 1) };
  }
}

/** True when the selection spans more than the active cell (Enter/Tab then move inside it). */
export function isMultiCellSelection(sel: SelectionState): boolean {
  return sel.ranges.length > 1 || (sel.ranges.length === 1 && rangeCellCount(sel.ranges[0]) > 1);
}

/**
 * Excel's Enter/Tab inside a multi-cell selection: the active cell walks the
 * selection (Enter by columns, Tab by rows), wrapping to the next range and
 * back to the first; the selection itself is kept.
 */
export function nextInSelection(sel: SelectionState, dir: Direction): SelectionState {
  const byRows = dir === "left" || dir === "right";
  const forward = dir === "down" || dir === "right";
  let rangeIdx = sel.activeRange;
  let r = sel.ranges[rangeIdx];
  let { row, col } = sel.active;
  if (byRows) {
    col += forward ? 1 : -1;
    if (col > r.c1) {
      col = r.c0;
      row += 1;
    } else if (col < r.c0) {
      col = r.c1;
      row -= 1;
    }
  } else {
    row += forward ? 1 : -1;
    if (row > r.r1) {
      row = r.r0;
      col += 1;
    } else if (row < r.r0) {
      row = r.r1;
      col -= 1;
    }
  }
  const outside = row < r.r0 || row > r.r1 || col < r.c0 || col > r.c1;
  if (outside) {
    rangeIdx = (rangeIdx + (forward ? 1 : sel.ranges.length - 1)) % sel.ranges.length;
    r = sel.ranges[rangeIdx];
    row = forward ? r.r0 : r.r1;
    col = forward ? r.c0 : r.c1;
  }
  return { ...sel, activeRange: rangeIdx, active: { row, col } };
}
