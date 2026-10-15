import type { ChartAnchor } from "@/engine/contract";
import { MAX_COLS, MAX_ROWS, type CellRange } from "@/engine/types";
import type { GridHandle } from "@/grid/api";

/**
 * Anchor <-> pixel conversions. Positions are in overlay-host coordinates
 * (`GridHandle.getRangeRect`); anchor offsets are CSS px at 100% zoom.
 */
export type GridGeometry = Pick<GridHandle, "getRangeRect" | "getViewport">;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function cellRect(grid: GridGeometry, row: number, col: number): DOMRect {
  const range: CellRange = { r0: row, c0: col, r1: row, c1: col };
  return grid.getRangeRect(range);
}

export function anchorToBox(grid: GridGeometry, anchor: ChartAnchor): Box {
  const zoom = grid.getViewport().zoom;
  const a = cellRect(grid, anchor.from.row, anchor.from.col);
  const b = cellRect(grid, anchor.to.row, anchor.to.col);
  const x0 = a.left + anchor.from.dx * zoom;
  const y0 = a.top + anchor.from.dy * zoom;
  const x1 = b.left + anchor.to.dx * zoom;
  const y1 = b.top + anchor.to.dy * zoom;
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Last index in [0, count) whose start coordinate is <= `pos` (binary search). */
function lastStartBefore(count: number, pos: number, start: (i: number) => number): number {
  let lo = 0;
  let hi = count - 1;
  if (pos <= start(0)) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (start(mid) <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Cell under a point plus the offset inside it (CSS px at 100%). */
export function pointToCell(grid: GridGeometry, x: number, y: number): { row: number; col: number; dx: number; dy: number } {
  const zoom = grid.getViewport().zoom;
  const col = lastStartBefore(MAX_COLS, x, (c) => cellRect(grid, 0, c).left);
  const row = lastStartBefore(MAX_ROWS, y, (r) => cellRect(grid, r, 0).top);
  const rect = cellRect(grid, row, col);
  const dx = Math.max(0, Math.min(rect.width, x - rect.left)) / zoom;
  const dy = Math.max(0, Math.min(rect.height, y - rect.top)) / zoom;
  return { row, col, dx: Math.round(dx * 100) / 100, dy: Math.round(dy * 100) / 100 };
}

export function boxToAnchor(grid: GridGeometry, box: Box): ChartAnchor {
  return {
    from: pointToCell(grid, box.x, box.y),
    to: pointToCell(grid, box.x + box.w, box.y + box.h),
  };
}

/** Excel's default chart size (5" x 3" at 96 dpi), in CSS px at 100%. */
export const DEFAULT_CHART_SIZE = { w: 480, h: 288 } as const;

/** Anchor for a new chart placed to the right of `data` (one empty column in between), like Excel. */
export function anchorNextTo(grid: GridGeometry | null, data: CellRange): ChartAnchor {
  const col = Math.min(MAX_COLS - 1, data.c1 + 2);
  const row = data.r0;
  if (!grid) {
    // Default geometry: 64 x 20 px cells.
    return {
      from: { row, col, dx: 0, dy: 0 },
      to: {
        row: row + Math.floor(DEFAULT_CHART_SIZE.h / 20),
        col: col + Math.floor(DEFAULT_CHART_SIZE.w / 64),
        dx: DEFAULT_CHART_SIZE.w % 64,
        dy: DEFAULT_CHART_SIZE.h % 20,
      },
    };
  }
  const zoom = grid.getViewport().zoom;
  const start = cellRect(grid, row, col);
  return boxToAnchor(grid, {
    x: start.left,
    y: start.top,
    w: DEFAULT_CHART_SIZE.w * zoom,
    h: DEFAULT_CHART_SIZE.h * zoom,
  });
}
