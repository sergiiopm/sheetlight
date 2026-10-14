import type { AutoFilterInfo, SheetInfo } from "@/engine/contract";
import { MAX_COLS, MAX_ROWS } from "@/engine/types";
import { AxisModel } from "./AxisModel";
import { MergeIndex } from "./MergeIndex";

/** Rows + columns + merges + frozen panes + sheet view flags of one sheet (all in sheet units). */
export class SheetGeometry {
  readonly rows: AxisModel;
  readonly cols: AxisModel;
  readonly merges = new MergeIndex();
  private frozenR = 0;
  private frozenC = 0;
  private local = 0;
  showGridLines = true;
  autoFilter: AutoFilterInfo | null = null;

  constructor(rowCount = MAX_ROWS, colCount = MAX_COLS, defaultRowHeight = 20, defaultColWidth = 64) {
    this.rows = new AxisModel(rowCount, defaultRowHeight);
    this.cols = new AxisModel(colCount, defaultColWidth);
  }

  get frozenRows(): number {
    return this.frozenR;
  }

  get frozenCols(): number {
    return this.frozenC;
  }

  setFrozen(rows: number, cols: number): void {
    const r = Math.max(0, Math.min(rows, this.rows.count - 1));
    const c = Math.max(0, Math.min(cols, this.cols.count - 1));
    if (r === this.frozenR && c === this.frozenC) return;
    this.frozenR = r;
    this.frozenC = c;
    this.local++;
  }

  /** Load / reload everything from the engine's SheetInfo. */
  apply(info: SheetInfo): void {
    this.rows.reset(info.rowCount, info.defaultRowHeight, info.rowOverrides);
    this.cols.reset(info.colCount, info.defaultColWidth, info.colOverrides);
    this.merges.setAll(info.merges);
    this.setFrozen(info.frozenRows, info.frozenCols);
    this.showGridLines = info.showGridLines;
    this.autoFilter = info.autoFilter;
    this.local++;
  }

  /** Bump the version for changes the sub-models don't track (gridlines, filter). */
  touch(): void {
    this.local++;
  }

  /** Combined version for render caches. */
  get version(): number {
    return this.rows.version * 1_000_003 + this.cols.version * 1009 + this.merges.version * 31 + this.local;
  }
}
