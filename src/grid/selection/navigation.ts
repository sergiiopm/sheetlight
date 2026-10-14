import type { CellAddress, Direction } from "@/engine/types";
import type { SheetGeometry } from "../geometry/SheetGeometry";

/** One visible step in `dir`, jumping over merged areas and hidden rows/cols. */
export function stepCell(geom: SheetGeometry, cell: CellAddress, dir: Direction): CellAddress {
  const m = geom.merges.at(cell.row, cell.col);
  let { row, col } = cell;
  switch (dir) {
    case "down":
      row = geom.rows.step(m ? m.r1 : row, 1);
      break;
    case "up":
      row = geom.rows.step(m ? m.r0 : row, -1);
      break;
    case "right":
      col = geom.cols.step(m ? m.c1 : col, 1);
      break;
    case "left":
      col = geom.cols.step(m ? m.c0 : col, -1);
      break;
  }
  return { row, col };
}

/** Make sure a cell is not hidden (moves forward, then backward). */
export function visibleCell(geom: SheetGeometry, cell: CellAddress): CellAddress {
  let row = geom.rows.nextVisible(cell.row, 1);
  if (row < 0) row = Math.max(0, geom.rows.nextVisible(cell.row, -1));
  let col = geom.cols.nextVisible(cell.col, 1);
  if (col < 0) col = Math.max(0, geom.cols.nextVisible(cell.col, -1));
  return { row, col };
}
