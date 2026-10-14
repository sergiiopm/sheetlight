import type { EngineOp } from "@/engine/contract";
import { MAX_COLS, MAX_ROWS, rangeContains, type CellAddress, type CellRange, type Direction, type SheetId } from "@/engine/types";
import type { SelectionState } from "@/model/selection";
import type { EditRequest, GridContextMenuEvent, ReferencePicker } from "../api";
import type { EngineDataSource } from "../data/DataSource";
import type { SheetGeometry } from "../geometry/SheetGeometry";
import type { Viewport } from "../core/Viewport";
import { sameRange } from "../core/util";
import {
  addCell,
  cycleActive,
  extendTo,
  focusOf,
  selectAll,
  selectCell,
  selectCols,
  selectedHeaderIndices,
  selectionContains,
  selectRows,
  type SelectMode,
} from "../selection/selection";
import { stepCell, visibleCell } from "../selection/navigation";

/** What interactions need from the grid (implemented by `Grid`). */
export interface InteractionHost {
  readonly geom: SheetGeometry;
  readonly viewport: Viewport;
  readonly sheet: SheetId;
  readonly readOnly: boolean;
  data(): EngineDataSource | null;
  selection(): SelectionState;
  /** Write a new selection to the store (no-op if equal). */
  setSelection(next: SelectionState): void;
  picker(): ReferencePicker | null;
  apply(ops: EngineOp[]): void;
  editRequest(req: EditRequest): void;
  unhandledKey(e: KeyboardEvent): void;
  contextMenu(e: GridContextMenuEvent): void;
  filterButton(col: number, anchor: DOMRect): void;
  /** Local (optimistic) axis size change while dragging; full repaint. */
  resizeAxis(axis: "row" | "col", index: number, size: number): void;
  setResizeGuide(guide: { axis: "col" | "row"; index: number } | null): void;
  setFillPreview(range: CellRange | null): void;
  setPick(range: CellRange | null): void;
  measureAutofit(cols: ReadonlyArray<number>): Promise<ReadonlyArray<number>>;
  isDisposed(): boolean;
}

const MAX_HEADER_OP_INDICES = 65_536;

/**
 * Excel interaction semantics on top of the selection store: keyboard
 * navigation, selection commands, header resize/autofit commits, fill-handle
 * commits, edit requests. Pointer events are translated by `PointerController`
 * into calls on this class.
 */
export class GridInteractions {
  private navQueue: Promise<void> = Promise.resolve();

  constructor(private readonly host: InteractionHost) {}

  private get geom(): SheetGeometry {
    return this.host.geom;
  }

  /** Current selection with the active cell made visible (hidden rows may have changed). */
  private sel(): SelectionState {
    return this.host.selection();
  }

  private commit(next: SelectionState, reveal: CellAddress | null): void {
    this.host.setSelection(next);
    if (reveal) this.host.viewport.ensureVisible(reveal);
  }

  // ------------------------------------------------------------ navigation

  /** Arrow keys (with/without Shift). */
  moveSelection(dir: Direction, extend: boolean): void {
    const s = this.sel();
    if (extend) {
      const f = stepCell(this.geom, focusOf(s), dir);
      this.commit(extendTo(s, f, this.geom.merges), f);
    } else {
      const a = stepCell(this.geom, s.active, dir);
      this.commit(selectCell(this.host.sheet, a, this.geom.merges), a);
    }
  }

  /** Ctrl+Arrow (Excel "jump to data edge", skipping hidden rows); async, serialized. */
  jumpToEdge(dir: Direction, extend: boolean): Promise<void> {
    this.navQueue = this.navQueue.then(async () => {
      const data = this.host.data();
      if (!data) return;
      const s = this.sel();
      const from = extend ? focusOf(s) : s.active;
      let to: CellAddress;
      try {
        to = await data.findDataEdge(from, dir, this.geom.rows, this.geom.cols);
      } catch {
        return;
      }
      if (this.host.isDisposed()) return;
      to = visibleCell(this.geom, to);
      const cur = this.sel();
      this.commit(extend ? extendTo(cur, to, this.geom.merges) : selectCell(this.host.sheet, to, this.geom.merges), to);
    });
    return this.navQueue;
  }

  /** Page Up/Down (Alt: left/right): move a screen and keep the cursor's screen position. */
  page(dir: Direction, extend: boolean): void {
    const vp = this.host.viewport;
    const ext = vp.extent();
    const vertical = dir === "up" || dir === "down";
    const sign = dir === "down" || dir === "right" ? 1 : -1;
    const s = this.sel();
    const from = extend ? focusOf(s) : s.active;
    const axis = vertical ? this.geom.rows : this.geom.cols;
    const idx = vertical ? from.row : from.col;
    const delta = sign * (vertical ? ext.viewH : ext.viewW);
    const target = axis.indexAt(axis.offsetOf(idx) + delta + 1);
    const cell = vertical ? { row: target, col: from.col } : { row: from.row, col: target };
    const sc = vp.getScroll();
    if (vertical) vp.setScroll(sc.x, sc.y + delta);
    else vp.setScroll(sc.x + delta, sc.y);
    this.commit(extend ? extendTo(s, cell, this.geom.merges) : selectCell(this.host.sheet, cell, this.geom.merges), cell);
  }

  goTo(cell: CellAddress, extend = false): void {
    const c = visibleCell(this.geom, cell);
    const s = this.sel();
    this.commit(extend ? extendTo(s, c, this.geom.merges) : selectCell(this.host.sheet, c, this.geom.merges), c);
  }

  /** Ctrl+End target: bottom-right of the used range. */
  lastUsedCell(): CellAddress {
    const used = this.host.data()?.used;
    return used ? { row: used.r1, col: used.c1 } : { row: 0, col: 0 };
  }

  /** Tab / Enter (cycling inside a multi-cell selection). */
  advance(byRow: boolean, backwards: boolean): void {
    const s = this.sel();
    const hidden = (r: number, c: number) => this.geom.rows.isHidden(r) || this.geom.cols.isHidden(c);
    const cycled = cycleActive(s, byRow, backwards, hidden, this.geom.merges);
    if (cycled) {
      this.commit(cycled, cycled.active);
      return;
    }
    const dir: Direction = byRow ? (backwards ? "left" : "right") : backwards ? "up" : "down";
    const a = stepCell(this.geom, s.active, dir);
    this.commit(selectCell(this.host.sheet, a, this.geom.merges), a);
  }

  selectAll(): void {
    this.commit(selectAll(this.sel()), null);
  }

  selectColumnsOfActive(): void {
    const s = this.sel();
    const r = s.ranges[s.activeRange];
    this.commit(selectCols(s, r.c0, r.c1, "replace", s.active.row), null);
  }

  selectRowsOfActive(): void {
    const s = this.sel();
    const r = s.ranges[s.activeRange];
    this.commit(selectRows(s, r.r0, r.r1, "replace", s.active.col), null);
  }

  // ---------------------------------------------------------- pointer API

  clickCell(cell: CellAddress, mode: SelectMode): void {
    const s = this.sel();
    const m = this.geom.merges;
    this.commit(mode === "extend" ? extendTo(s, cell, m) : mode === "add" ? addCell(s, cell, m) : selectCell(this.host.sheet, cell, m), null);
  }

  /** Drag-extend to a cell; `axis` limits the extension for header drags. */
  dragTo(cell: CellAddress, axis: "cells" | "rows" | "cols"): void {
    const s = this.sel();
    const f = focusOf(s);
    const target = axis === "rows" ? { row: cell.row, col: f.col } : axis === "cols" ? { row: f.row, col: cell.col } : cell;
    this.commit(extendTo(s, target, this.geom.merges), null);
  }

  clickRowHeader(row: number, mode: SelectMode, activeCol: number): void {
    const s = this.sel();
    this.commit(selectRows(s, mode === "extend" ? s.active.row : row, row, mode, activeCol), null);
  }

  clickColHeader(col: number, mode: SelectMode, activeRow: number): void {
    const s = this.sel();
    this.commit(selectCols(s, mode === "extend" ? s.active.col : col, col, mode, activeRow), null);
  }

  // ------------------------------------------------------- resize / autofit

  /** Indices affected by resizing `index`: every selected header if it is part of a header selection. */
  private headerTargets(axis: "row" | "col", index: number): number[] {
    const s = this.sel();
    const used = this.host.data()?.used;
    const L = this.host.viewport.layout();
    // Cap absurd selections (whole sheet) to the data / visible area.
    const visibleEnd = axis === "col" ? L.main.c1 : L.main.r1;
    const usedEnd = used ? (axis === "col" ? used.c1 : used.r1) : 0;
    const total = axis === "col" ? MAX_COLS : MAX_ROWS;
    let limit = total - 1;
    const count = s.ranges.reduce((n, r) => n + (axis === "col" ? r.c1 - r.c0 + 1 : r.r1 - r.r0 + 1), 0);
    if (count > MAX_HEADER_OP_INDICES) limit = Math.max(usedEnd, visibleEnd, index);
    return selectedHeaderIndices(s, axis, index, limit) ?? [index];
  }

  /** End of a header-border drag: persist the size (and unhide when a hidden index was dragged open). */
  commitResize(axis: "row" | "col", index: number, size: number, wasHidden: boolean): void {
    if (this.host.readOnly) return;
    const targets = this.headerTargets(axis, index);
    const sheet = this.host.sheet;
    const s = Math.max(1, Math.round(size));
    const a = axis === "col" ? this.geom.cols : this.geom.rows;
    for (const i of targets) if (i !== index) a.setSize(i, s);
    const ops: EngineOp[] = [];
    if (wasHidden) ops.push({ type: "setHidden", sheet, axis, indices: [index], hidden: false });
    ops.push(axis === "col" ? { type: "setColWidths", sheet, cols: targets, size: s } : { type: "setRowHeights", sheet, rows: targets, size: s });
    this.host.resizeAxis(axis, index, s);
    this.host.apply(ops);
  }

  /** Double-click on a column border: autofit it (and every selected column with it). */
  async autofitColumns(col: number): Promise<void> {
    if (this.host.readOnly) return;
    const targets = this.headerTargets("col", col);
    const widths = await this.host.measureAutofit(targets);
    if (this.host.isDisposed()) return;
    const sheet = this.host.sheet;
    // One op per distinct width, all in one batch (= one undo step).
    const byWidth = new Map<number, number[]>();
    targets.forEach((c, i) => {
      const w = widths[i];
      const list = byWidth.get(w);
      if (list) list.push(c);
      else byWidth.set(w, [c]);
      this.geom.cols.setSize(c, w);
    });
    const ops: EngineOp[] = [...byWidth].map(([size, cols]) => ({ type: "setColWidths", sheet, cols, size }));
    this.host.resizeAxis("col", col, this.geom.cols.storedSizeOf(col));
    this.host.apply(ops);
  }

  /** Double-click on a row border: back to the default height (auto height). */
  autofitRows(row: number): void {
    if (this.host.readOnly) return;
    const targets = this.headerTargets("row", row);
    for (const r of targets) this.geom.rows.setSize(r, this.geom.rows.defaultSize);
    this.host.resizeAxis("row", row, this.geom.rows.defaultSize);
    this.host.apply([{ type: "setRowHeights", sheet: this.host.sheet, rows: targets, size: null }]);
  }

  // ------------------------------------------------------------ fill handle

  /** Target of a fill-handle drag with the pointer over `cell` (Excel rules). */
  fillTarget(src: CellRange, cell: CellAddress): CellRange {
    const { row, col } = cell;
    const dr = row > src.r1 ? row - src.r1 : row < src.r0 ? row - src.r0 : 0;
    const dc = col > src.c1 ? col - src.c1 : col < src.c0 ? col - src.c0 : 0;
    if (dr === 0 && dc === 0) {
      // Back inside the source: shrink (the removed part gets cleared).
      const shrinkRows = src.r1 - row;
      const shrinkCols = src.c1 - col;
      if (shrinkRows === 0 && shrinkCols === 0) return src;
      return shrinkRows >= shrinkCols ? { ...src, r1: row } : { ...src, c1: col };
    }
    // Excel extends along the axis with the larger distance.
    if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? { ...src, r1: row } : { ...src, r0: row };
    return dc > 0 ? { ...src, c1: col } : { ...src, c0: col };
  }

  /** End of a fill-handle drag. */
  commitFill(src: CellRange, target: CellRange): void {
    if (this.host.readOnly || sameRange(src, target)) return;
    const sheet = this.host.sheet;
    const inside = target.r0 >= src.r0 && target.c0 >= src.c0 && target.r1 <= src.r1 && target.c1 <= src.c1;
    if (inside) {
      // Shrink: clear what was dragged back over.
      const removed: CellRange = target.r1 < src.r1 ? { ...src, r0: target.r1 + 1 } : { ...src, c0: target.c1 + 1 };
      this.host.apply([{ type: "clear", sheet, ranges: [removed], what: "contents" }]);
      this.commit(this.rangeSelection(target), null);
      return;
    }
    this.host.apply([{ type: "fill", sheet, source: src, target }]);
    this.commit(this.rangeSelection(target), null);
  }

  /** Double-click on the fill handle: fill down as far as the adjacent column has data (Excel). */
  async fillDownToAdjacent(src: CellRange): Promise<void> {
    const data = this.host.data();
    if (!data || this.host.readOnly) return;
    let end = -1;
    for (const adj of [src.c0 - 1, src.c1 + 1]) {
      if (adj < 0 || adj >= this.geom.cols.count) continue;
      const below = data.cellText(src.r1 + 1, adj);
      if (below === null && data.isCellLoaded(src.r1 + 1, adj)) continue;
      try {
        const edge = await data.findDataEdge({ row: src.r1 + 1, col: adj }, "down", this.geom.rows, this.geom.cols);
        end = Math.max(end, edge.row);
      } catch {
        return;
      }
      break;
    }
    if (end <= src.r1 || this.host.isDisposed()) return;
    this.commitFill(src, { ...src, r1: end });
  }

  private rangeSelection(r: CellRange): SelectionState {
    const s = this.sel();
    const active = rangeContains(r, s.active.row, s.active.col) ? s.active : { row: r.r0, col: r.c0 };
    return { sheet: this.host.sheet, ranges: [r], activeRange: 0, active, anchor: { row: r.r0, col: r.c0 }, kind: "cells" };
  }

  // ---------------------------------------------------------- edit / misc

  requestEdit(source: EditRequest["source"], initialText?: string): void {
    if (this.host.readOnly) return;
    const cell = this.sel().active;
    this.host.editRequest(initialText === undefined ? { cell, source } : { cell, source, initialText });
  }

  clearContents(): void {
    if (this.host.readOnly) return;
    const s = this.sel();
    this.host.apply([{ type: "clear", sheet: this.host.sheet, ranges: s.ranges.slice(), what: "contents" }]);
  }

  /**
   * Right click: Excel keeps the selection when clicking inside it, otherwise
   * selects the clicked cell/header first.
   */
  contextMenuAt(region: GridContextMenuEvent["region"], cell: CellAddress, clientX: number, clientY: number): void {
    const s = this.sel();
    const L = this.host.viewport.layout();
    const inCols = (s.kind === "cols" || s.kind === "all") && s.ranges.some((r) => cell.col >= r.c0 && cell.col <= r.c1);
    const inRows = (s.kind === "rows" || s.kind === "all") && s.ranges.some((r) => cell.row >= r.r0 && cell.row <= r.r1);
    if (region === "cell" && !selectionContains(s, cell.row, cell.col)) this.clickCell(cell, "replace");
    else if (region === "colHeader" && !inCols) this.clickColHeader(cell.col, "replace", L.main.r0);
    else if (region === "rowHeader" && !inRows) this.clickRowHeader(cell.row, "replace", L.main.c0);
    else if (region === "corner") this.selectAll();
    this.host.contextMenu({ region, cell, clientX, clientY });
  }
}
