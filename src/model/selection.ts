import type { CellAddress, CellRange, SheetId } from "@/engine/types";

/**
 * Selection of one sheet, with Excel semantics:
 * - `ranges` may hold several ranges (Ctrl+click); the last one is the one
 *   Shift+click / Shift+arrows extend.
 * - `active` is the cell that receives typing (white cell inside the
 *   highlight); it is always inside `ranges[activeRange]`.
 * - `anchor` is the fixed corner of the range being extended.
 * - `kind` tells whether whole rows/columns/sheet were selected via headers.
 *
 * The grid renders this state and turns pointer/keyboard input into new
 * states; the formula bar, status bar and commands read it. It lives in
 * `model/` (not in the grid) so undo hints, the formula bar and commands can
 * share it.
 */
export type SelectionKind = "cells" | "rows" | "cols" | "all";

export interface SelectionState {
  readonly sheet: SheetId;
  readonly ranges: ReadonlyArray<CellRange>;
  /** Index into `ranges` of the range containing `active`. */
  readonly activeRange: number;
  readonly active: CellAddress;
  readonly anchor: CellAddress;
  readonly kind: SelectionKind;
}

export function singleCellSelection(sheet: SheetId, cell: CellAddress = { row: 0, col: 0 }): SelectionState {
  return {
    sheet,
    ranges: [{ r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col }],
    activeRange: 0,
    active: cell,
    anchor: cell,
    kind: "cells",
  };
}

export type SelectionListener = (state: SelectionState, previous: SelectionState) => void;

/**
 * Tiny observable holder. One store per open document; it holds the selection
 * of the active sheet (the session keeps the last selection of each sheet).
 * Works with React's `useSyncExternalStore(store.subscribe, store.get)`.
 */
export interface SelectionStore {
  get(): SelectionState;
  set(next: SelectionState): void;
  subscribe(listener: SelectionListener): () => void;
}

export function createSelectionStore(initial: SelectionState): SelectionStore {
  let state = initial;
  const listeners = new Set<SelectionListener>();
  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      const previous = state;
      state = next;
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
