import type { SheetGeometry } from "../geometry/SheetGeometry";
import type { GridLayout } from "../geometry/layout";
import { colAtX, colScreenX, rowAtY, rowScreenY } from "../geometry/layout";

export type HitTarget =
  | { readonly type: "corner" }
  | { readonly type: "colHeader"; readonly col: number }
  | { readonly type: "rowHeader"; readonly row: number }
  /** Pointer on a header border: resizing `index`. */
  | { readonly type: "colBorder"; readonly col: number }
  | { readonly type: "rowBorder"; readonly row: number }
  | { readonly type: "cell"; readonly row: number; readonly col: number }
  | { readonly type: "none" };

/** CSS px tolerance around header borders. */
const BORDER_GRAB = 4;

export function hitTest(geom: SheetGeometry, L: GridLayout, x: number, y: number): HitTarget {
  if (x < 0 || y < 0 || x > L.width || y > L.height) return { type: "none" };
  const inColHeader = y < L.headerH;
  const inRowHeader = x < L.headerW;
  if (inColHeader && inRowHeader) return { type: "corner" };
  if (inColHeader) {
    const col = colAtX(geom, L, x);
    const left = colScreenX(geom, L, col);
    const right = left + geom.cols.sizeOf(col) * L.zoom;
    if (right - x <= BORDER_GRAB) return { type: "colBorder", col };
    if (x - left <= BORDER_GRAB) {
      // Just right of a hidden-column marker: grab the hidden column (unhide by drag, Excel).
      if (col > 0 && geom.cols.isHidden(col - 1) && x - left >= 1 && (col - 1 >= geom.frozenCols || col <= geom.frozenCols)) {
        return { type: "colBorder", col: col - 1 };
      }
      const prev = geom.cols.nextVisible(col - 1, -1);
      // Don't grab across the frozen boundary into a column that is scrolled away.
      if (prev >= 0 && (prev >= geom.frozenCols || col <= geom.frozenCols)) return { type: "colBorder", col: prev };
    }
    return { type: "colHeader", col };
  }
  if (inRowHeader) {
    const row = rowAtY(geom, L, y);
    const top = rowScreenY(geom, L, row);
    const bottom = top + geom.rows.sizeOf(row) * L.zoom;
    if (bottom - y <= BORDER_GRAB) return { type: "rowBorder", row };
    if (y - top <= BORDER_GRAB) {
      if (row > 0 && geom.rows.isHidden(row - 1) && y - top >= 1 && (row - 1 >= geom.frozenRows || row <= geom.frozenRows)) {
        return { type: "rowBorder", row: row - 1 };
      }
      const prev = geom.rows.nextVisible(row - 1, -1);
      if (prev >= 0 && (prev >= geom.frozenRows || row <= geom.frozenRows)) return { type: "rowBorder", row: prev };
    }
    return { type: "rowHeader", row };
  }
  return { type: "cell", row: rowAtY(geom, L, y), col: colAtX(geom, L, x) };
}
