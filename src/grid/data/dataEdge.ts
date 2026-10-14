import type { CellAddress, Direction } from "@/engine/types";

/** What the edge search needs from an axis (`AxisModel` implements it). */
export interface EdgeAxis {
  readonly count: number;
  nextVisible(i: number, dir: 1 | -1): number;
  isHidden(i: number): boolean;
  hasHiddenIn(a: number, b: number): boolean;
  nearestHidden(i: number, dir: 1 | -1): number;
}

export interface EdgeProbe {
  /** The engine's Ctrl+Arrow target, which ignores hidden rows/cols. */
  rawEdge(from: CellAddress, dir: Direction): Promise<CellAddress>;
  /** Whether a cell has content. */
  filled(row: number, col: number): Promise<boolean>;
}

/**
 * Excel Ctrl+Arrow that skips hidden rows/cols: the jump behaves as if hidden
 * rows/cols did not exist (filtered lists jump to the last *visible* value).
 *
 * The engine answers the raw question (`findDataEdge`). When no hidden index
 * lies in the traversed span the raw answer is the answer (one round trip,
 * the common case); otherwise the search hops from hidden run to hidden run,
 * asking the engine only for the plain stretches in between, so the cost is
 * O(hidden runs crossed) round trips instead of a cell walk.
 */
export async function visibleDataEdge(
  probe: EdgeProbe,
  rows: EdgeAxis,
  cols: EdgeAxis,
  from: CellAddress,
  dir: Direction,
): Promise<CellAddress> {
  const vertical = dir === "up" || dir === "down";
  const axis = vertical ? rows : cols;
  const step: 1 | -1 = dir === "down" || dir === "right" ? 1 : -1;
  const back: 1 | -1 = step === 1 ? -1 : 1;
  const at = (i: number): CellAddress => (vertical ? { row: i, col: from.col } : { row: from.row, col: i });
  const pos = (c: CellAddress): number => (vertical ? c.row : c.col);
  const filled = (i: number): Promise<boolean> => (vertical ? probe.filled(i, from.col) : probe.filled(from.row, i));
  const raw = async (i: number): Promise<number> => pos(await probe.rawEdge(at(i), dir));
  const span = (a: number, b: number): boolean => axis.hasHiddenIn(a, b);
  const next = (i: number): number => axis.nextVisible(i + step, step);

  const start = pos(from);
  let n = next(start);
  if (n < 0) return from;

  // Fast path: the engine's answer is exact when nothing in the span is hidden.
  const r0 = await raw(start);
  const limit = Math.max(0, Math.min(axis.count - 1, r0 + step));
  if (!span(start, limit)) return at(r0);

  if ((await filled(start)) && (await filled(n))) {
    // Run mode: go to the last visible filled cell of the run.
    for (let guard = 0; guard < 1_000_000; guard++) {
      const m = next(n);
      if (m < 0 || !(await filled(m))) return at(n);
      if (m !== n + step) {
        n = m; // crossed a hidden run and the run continues
        continue;
      }
      const end = await raw(n); // raw run end (n and n + step are filled)
      if (!span(n, end)) {
        n = end;
        continue;
      }
      // A hidden index inside the raw run: everything up to it is filled and visible.
      const h = axis.nearestHidden(n + step, step);
      n = h - step;
    }
    return at(n);
  }

  // Seek mode: first visible filled cell after the start, from an empty visible cell.
  let e = n;
  if (await filled(e)) return at(e);
  for (let guard = 0; guard < 1_000_000; guard++) {
    const f = await raw(e);
    if (f === e) return at(e);
    if (!axis.isHidden(f)) return at(f); // hidden cells before f are empty
    const m = axis.nextVisible(f, step);
    if (m < 0) return at(Math.max(0, axis.nextVisible(f, back)));
    if (await filled(m)) return at(m);
    e = m;
  }
  return at(e);
}
