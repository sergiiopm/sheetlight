import type {
  CellAddress,
  CellRange,
  Direction,
  DocumentId,
  SheetId,
  StyleId,
} from "@/engine/types";

/**
 * The `WorkbookEngine` contract: everything the UI knows about a workbook goes
 * through this interface. The production implementation (`TauriEngine`) talks
 * to the native IronCalc engine in `src-tauri/src/engine`; `MemoryEngine` is a
 * small in-memory fake for tests and for developing UI without the backend.
 *
 * Rules (see docs/ARCHITECTURE.md):
 * - Everything is async; nothing here may block the UI thread.
 * - Rows/cols are 0-based. Formulas use en-US syntax (`=SUM(A1:A5,2)`).
 * - One `apply()` call is one undo step. Undo/redo history lives in the engine.
 * - The engine owns values, number formatting, locale-aware display strings,
 *   conditional formatting and recalculation. The grid only renders display
 *   strings + style ids.
 * - Errors reject with `EngineError`; `message` is user-facing Spanish.
 */

// ---------------------------------------------------------------------------
// Blocks (grid data transport)
// ---------------------------------------------------------------------------

/** Blocks are fixed tiles of 64 rows x 16 cols, stored row-major. */
export const BLOCK_ROWS = 64;
export const BLOCK_COLS = 16;
export const BLOCK_SIZE = BLOCK_ROWS * BLOCK_COLS;

export const CellKind = {
  Empty: 0,
  Text: 1,
  Number: 2,
  Bool: 3,
  Error: 4,
  /** Row not loaded yet (large CSV still streaming). Rendered as a placeholder. */
  Pending: 5,
} as const;
export type CellKind = (typeof CellKind)[keyof typeof CellKind];

/** Bit flags per cell (`CellBlock.flags`). */
export const CellFlag = {
  Formula: 1 << 0,
  Comment: 1 << 1,
  Validation: 1 << 2,
  Spill: 1 << 3,
  Hyperlink: 1 << 4,
} as const;

export interface BlockKey {
  /** Block row = floor(row / BLOCK_ROWS). */
  readonly br: number;
  /** Block col = floor(col / BLOCK_COLS). */
  readonly bc: number;
}

/**
 * One tile of display data. Dense and row-major: cell (r, c) inside the block
 * is index `r * BLOCK_COLS + c`. The text of cell i is
 * `text.slice(textOffsets[i], textOffsets[i + 1])` (equal offsets = no text).
 */
export interface CellBlock extends BlockKey {
  readonly sheet: SheetId;
  /** Opaque content version: equal version => identical block content. */
  readonly version: number;
  readonly text: string;
  /** BLOCK_SIZE + 1 offsets (UTF-16 code units) into `text`. */
  readonly textOffsets: Uint32Array;
  readonly kinds: Uint8Array;
  readonly styleIds: Uint32Array;
  readonly flags: Uint8Array;
}

export interface BlockRequest {
  readonly sheet: SheetId;
  readonly keys: ReadonlyArray<BlockKey>;
  /**
   * Optional, parallel to `keys`: versions the client already holds. The
   * engine may answer "unchanged" for those, and `fetchBlocks` omits them.
   */
  readonly knownVersions?: ReadonlyArray<number>;
  /** 0 = visible now, 1 = prefetch. */
  readonly priority: 0 | 1;
}

// ---------------------------------------------------------------------------
// Sheets, geometry, styles
// ---------------------------------------------------------------------------

export interface AxisOverride {
  readonly index: number;
  /** CSS px at 100% zoom. */
  readonly size?: number;
  readonly hidden?: boolean;
}

export interface AutoFilterInfo {
  readonly range: CellRange;
  /** Columns (absolute indices) that currently have a filter applied. */
  readonly filteredCols: ReadonlyArray<number>;
}

export interface SheetMeta {
  readonly id: SheetId;
  readonly name: string;
  readonly hidden: boolean;
  /** Tab color as `#rrggbb`. */
  readonly color?: string;
}

export interface SheetInfo {
  readonly sheet: SheetId;
  readonly rowCount: number;
  readonly colCount: number;
  /** CSS px at 100% zoom. */
  readonly defaultRowHeight: number;
  readonly defaultColWidth: number;
  /** Bounding box of non-empty cells; null for an empty sheet. */
  readonly usedRange: CellRange | null;
  readonly rowOverrides: ReadonlyArray<AxisOverride>;
  readonly colOverrides: ReadonlyArray<AxisOverride>;
  readonly merges: ReadonlyArray<CellRange>;
  readonly frozenRows: number;
  readonly frozenCols: number;
  readonly showGridLines: boolean;
  readonly autoFilter: AutoFilterInfo | null;
  /** Increases on every change to anything in this struct. */
  readonly version: number;
}

export type HAlign = "general" | "left" | "center" | "right" | "fill" | "justify" | "centerContinuous";
export type VAlign = "top" | "middle" | "bottom";
export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair";

export interface BorderSpec {
  readonly style: BorderStyle;
  /** `#rrggbb` */
  readonly color: string;
}

/**
 * Fully resolved visual style for rendering. Number-format colors (`[Red]`)
 * and conditional formatting are already applied by the engine, so the grid
 * never evaluates formats. Absent field = sheet default.
 */
export interface CellStyle {
  readonly fontFamily?: string;
  /** Points. */
  readonly fontSize?: number;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean | "double";
  readonly strike?: boolean;
  /** `#rrggbb` */
  readonly color?: string;
  /** `#rrggbb` */
  readonly fill?: string;
  readonly hAlign?: HAlign;
  readonly vAlign?: VAlign;
  readonly wrap?: boolean;
  readonly shrinkToFit?: boolean;
  /** Indent level (~3 characters each). */
  readonly indent?: number;
  /** Degrees, -90..90, or 255 for vertical text. */
  readonly rotation?: number;
  readonly borderTop?: BorderSpec;
  readonly borderRight?: BorderSpec;
  readonly borderBottom?: BorderSpec;
  readonly borderLeft?: BorderSpec;
}

/** Editable format of a cell, as shown by the toolbar and the format dialog. */
export interface CellFormat {
  readonly style: CellStyle;
  /** Excel number format code, e.g. `General`, `#,##0.00 "€"`, `dd/mm/yyyy`. */
  readonly numFmt: string;
}

// ---------------------------------------------------------------------------
// Cell queries
// ---------------------------------------------------------------------------

export type CellValue =
  | { readonly type: "empty" }
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "error"; readonly value: string };

/** Everything the formula bar / in-cell editor / toolbar needs about one cell. */
export interface CellDetails {
  readonly sheet: SheetId;
  readonly row: number;
  readonly col: number;
  /**
   * Canonical input, as stored: a formula in en-US syntax (`=SUM(A1:A3)`) or
   * the raw value (`1234.5`, `TRUE`, `hello`). The editor converts numbers and
   * dates to the user's locale for editing (`src/lib/locale.ts`).
   */
  readonly input: string;
  readonly value: CellValue;
  /** Locale-formatted display string (what the grid shows). */
  readonly display: string;
  readonly format: CellFormat;
  /** If the cell is inside a merge, the whole merged range. */
  readonly merge: CellRange | null;
  /** If the cell is part of a dynamic-array spill, the anchor cell. */
  readonly spillAnchor: CellAddress | null;
  readonly comment: string | null;
  readonly hyperlink: string | null;
}

export interface SelectionStats {
  /** Non-empty cells (Excel "Recuento"). */
  readonly count: number;
  readonly numericCount: number;
  readonly sum: number;
  readonly average: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

export interface TextSample {
  readonly text: string;
  readonly styleId: StyleId;
}

/** Values of a range for charts, row-major. */
export interface RangeValues {
  readonly range: CellRange;
  readonly values: ReadonlyArray<ReadonlyArray<CellValue>>;
  /** Display strings (formatted), same shape as `values`. */
  readonly display: ReadonlyArray<ReadonlyArray<string>>;
}

export interface FindQuery {
  readonly text: string;
  readonly matchCase: boolean;
  readonly wholeCell: boolean;
  /** Search formulas (canonical input) or displayed values. */
  readonly lookIn: "formulas" | "values";
  /** null = every sheet. */
  readonly sheet: SheetId | null;
  /** Restrict to these ranges (e.g. current multi-cell selection). */
  readonly within?: ReadonlyArray<CellRange>;
  readonly byColumns?: boolean;
  /** Maximum matches to return. */
  readonly limit: number;
}

export interface FindMatch {
  readonly sheet: SheetId;
  readonly row: number;
  readonly col: number;
  readonly display: string;
}

export interface FilterValue {
  /** Display string of the distinct value ("" = blanks). */
  readonly value: string;
  readonly count: number;
  /** Currently visible under the active filter. */
  readonly selected: boolean;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export type ChartId = number;
export type ChartType = "column" | "bar" | "line" | "pie" | "area" | "scatter" | "doughnut";

export interface ChartSeries {
  /** Formula-style reference, e.g. `Hoja1!$B$1` (may be null). */
  readonly nameRef: string | null;
  /** Literal name when there is no reference. */
  readonly name: string | null;
  /** e.g. `Hoja1!$A$2:$A$13`; null when categories are 1..n. */
  readonly categoriesRef: string | null;
  /** e.g. `Hoja1!$B$2:$B$13`. */
  readonly valuesRef: string;
  /** `#rrggbb`; null = palette. */
  readonly color: string | null;
}

/** Cell-anchored position (like xlsx two-cell anchors). Offsets in CSS px at 100%. */
export interface ChartAnchor {
  readonly from: CellAddress & { readonly dx: number; readonly dy: number };
  readonly to: CellAddress & { readonly dx: number; readonly dy: number };
}

export interface ChartSpec {
  readonly id: ChartId;
  readonly sheet: SheetId;
  readonly type: ChartType;
  readonly title: string | null;
  readonly series: ReadonlyArray<ChartSeries>;
  readonly anchor: ChartAnchor;
  readonly legend: "none" | "right" | "bottom" | "top" | "left";
  /** Column/bar: clustered or stacked. */
  readonly grouping: "clustered" | "stacked" | "percentStacked" | "standard";
  readonly xAxisTitle: string | null;
  readonly yAxisTitle: string | null;
  /**
   * True if this chart came from a file and has not been edited: on save the
   * original DrawingML part is written back untouched (perfect fidelity).
   */
  readonly fromFile: boolean;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type SourceFormat = "new" | "xlsx" | "xls" | "csv" | "ods";
export type SaveFormat = "xlsx" | "csv";

/** Features present in an opened file that Sheetlight cannot fully round-trip. */
export type FidelityFeature =
  | "charts"
  | "images"
  | "shapes"
  | "comments"
  | "dataValidation"
  | "autoFilter"
  | "conditionalFormatting"
  | "pivotTables"
  | "tables"
  | "macros"
  | "externalLinks"
  | "sparklines"
  | "slicers"
  | "other";

export interface FidelityWarning {
  readonly feature: FidelityFeature;
  readonly count: number;
  /**
   * What happens on save:
   * - `preserved`: written back unchanged (original package parts re-inserted);
   * - `editable`: Sheetlight understands and saves it;
   * - `lost`: will be dropped when saving as .xlsx.
   */
  readonly onSave: "preserved" | "editable" | "lost";
}

export interface CsvOptions {
  /** null = auto-detect. */
  readonly delimiter: "," | ";" | "\t" | "|" | null;
  /** null = auto-detect (UTF-8 with/without BOM, UTF-16, Windows-1252). */
  readonly encoding: "utf-8" | "utf-16le" | "windows-1252" | null;
  /** Decimal separator used when parsing numbers; null = auto-detect. */
  readonly decimal: "." | "," | null;
}

export interface OpenOptions {
  readonly csv?: Partial<CsvOptions>;
}

export interface DocumentInfo {
  readonly doc: DocumentId;
  readonly sourceFormat: SourceFormat;
  /** Backend currently holding the data. `csv` is the fast typed-column store. */
  readonly backend: "workbook" | "csv";
  readonly path: string | null;
  readonly sheets: ReadonlyArray<SheetMeta>;
  readonly activeSheet: SheetId;
  readonly warnings: ReadonlyArray<FidelityWarning>;
  /** CSV only: options that were detected/used. */
  readonly csv: CsvOptions | null;
  /** True while a large CSV is still streaming in (see `loadProgress` events). */
  readonly loading: boolean;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface SaveOptions {
  readonly format: SaveFormat;
  /** CSV writes only this sheet (default: active sheet). */
  readonly sheet?: SheetId;
  readonly csv?: Partial<CsvOptions>;
}

export interface SaveResult {
  readonly path: string;
  readonly format: SaveFormat;
  /** Features that were dropped by this save (empty when nothing was lost). */
  readonly lost: ReadonlyArray<FidelityFeature>;
}

// ---------------------------------------------------------------------------
// Operations (mutations). One `apply()` batch = one undo step.
// ---------------------------------------------------------------------------

export interface CellInput {
  readonly row: number;
  readonly col: number;
  /**
   * Canonical input: en-US formula (`=A1*2`) or value (`1234.5`, `TRUE`,
   * `texto`). The editor converts locale input ("1.234,5", "14/02/2025")
   * before building the op. A leading `'` forces text.
   */
  readonly input: string;
  /** Number format to apply together with the value (e.g. a typed date or %). */
  readonly numFmt?: string;
}

/** Partial style change. `null` resets a field to the default. */
export interface StylePatch {
  readonly fontFamily?: string | null;
  readonly fontSize?: number | null;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean | "double";
  readonly strike?: boolean;
  readonly color?: string | null;
  readonly fill?: string | null;
  readonly hAlign?: HAlign | null;
  readonly vAlign?: VAlign | null;
  readonly wrap?: boolean;
  readonly shrinkToFit?: boolean;
  readonly indent?: number;
  readonly rotation?: number;
  readonly numFmt?: string;
}

export type BorderPreset =
  | "all"
  | "outer"
  | "inner"
  | "innerHorizontal"
  | "innerVertical"
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "thickOuter"
  | "doubleBottom"
  | "none";

export type ClearWhat = "contents" | "formats" | "all" | "comments" | "hyperlinks";

export interface SortKey {
  /** Absolute column index. */
  readonly col: number;
  readonly ascending: boolean;
}

export type PasteSource =
  /** From a previous `engine.copy()` in this app session (keeps formulas & formats). */
  | { readonly kind: "internal"; readonly clipId: number; readonly cut: boolean }
  /** From the system clipboard (other apps): tab-separated text. */
  | { readonly kind: "text"; readonly text: string }
  /** From the system clipboard: HTML table (Excel, Google Sheets, LibreOffice). */
  | { readonly kind: "html"; readonly html: string };

export type PasteMode = "all" | "values" | "formats" | "formulas" | "transpose";

export interface FilterCriteria {
  /** Display strings to keep visible ("" = blanks). */
  readonly values: ReadonlyArray<string>;
}

export type EngineOp =
  // cells
  | { readonly type: "setCells"; readonly sheet: SheetId; readonly cells: ReadonlyArray<CellInput> }
  | { readonly type: "clear"; readonly sheet: SheetId; readonly ranges: ReadonlyArray<CellRange>; readonly what: ClearWhat }
  | { readonly type: "fill"; readonly sheet: SheetId; readonly source: CellRange; readonly target: CellRange }
  | { readonly type: "paste"; readonly sheet: SheetId; readonly target: CellRange; readonly source: PasteSource; readonly mode: PasteMode }
  | { readonly type: "sort"; readonly sheet: SheetId; readonly range: CellRange; readonly keys: ReadonlyArray<SortKey>; readonly hasHeader: boolean }
  | { readonly type: "replace"; readonly query: FindQuery; readonly replacement: string; readonly all: boolean; readonly at?: { readonly sheet: SheetId; readonly row: number; readonly col: number } }
  | { readonly type: "setComment"; readonly sheet: SheetId; readonly row: number; readonly col: number; readonly text: string | null }
  | { readonly type: "setHyperlink"; readonly sheet: SheetId; readonly row: number; readonly col: number; readonly url: string | null }
  // formatting
  | { readonly type: "setStyle"; readonly sheet: SheetId; readonly ranges: ReadonlyArray<CellRange>; readonly patch: StylePatch }
  | { readonly type: "setBorders"; readonly sheet: SheetId; readonly ranges: ReadonlyArray<CellRange>; readonly preset: BorderPreset; readonly style: BorderStyle; readonly color: string }
  | { readonly type: "copyFormat"; readonly sheet: SheetId; readonly source: CellRange; readonly targets: ReadonlyArray<CellRange> }
  | { readonly type: "merge"; readonly sheet: SheetId; readonly range: CellRange; readonly mode: "merge" | "mergeCenter" | "mergeAcross" }
  | { readonly type: "unmerge"; readonly sheet: SheetId; readonly ranges: ReadonlyArray<CellRange> }
  // structure & geometry
  | { readonly type: "insertRows"; readonly sheet: SheetId; readonly index: number; readonly count: number }
  | { readonly type: "deleteRows"; readonly sheet: SheetId; readonly index: number; readonly count: number }
  | { readonly type: "insertCols"; readonly sheet: SheetId; readonly index: number; readonly count: number }
  | { readonly type: "deleteCols"; readonly sheet: SheetId; readonly index: number; readonly count: number }
  /** Shift cells (Excel "Insert/Delete cells… shift right/down"). */
  | { readonly type: "insertCells"; readonly sheet: SheetId; readonly range: CellRange; readonly shift: "right" | "down" }
  | { readonly type: "deleteCells"; readonly sheet: SheetId; readonly range: CellRange; readonly shift: "left" | "up" }
  /** `size` null = back to default size. */
  | { readonly type: "setRowHeights"; readonly sheet: SheetId; readonly rows: ReadonlyArray<number>; readonly size: number | null }
  | { readonly type: "setColWidths"; readonly sheet: SheetId; readonly cols: ReadonlyArray<number>; readonly size: number | null }
  | { readonly type: "setHidden"; readonly sheet: SheetId; readonly axis: "row" | "col"; readonly indices: ReadonlyArray<number>; readonly hidden: boolean }
  | { readonly type: "setFrozen"; readonly sheet: SheetId; readonly rows: number; readonly cols: number }
  | { readonly type: "setShowGridLines"; readonly sheet: SheetId; readonly show: boolean }
  // sheets
  | { readonly type: "addSheet"; readonly name?: string; readonly index?: number }
  | { readonly type: "deleteSheet"; readonly sheet: SheetId }
  | { readonly type: "renameSheet"; readonly sheet: SheetId; readonly name: string }
  | { readonly type: "moveSheet"; readonly sheet: SheetId; readonly index: number }
  | { readonly type: "duplicateSheet"; readonly sheet: SheetId }
  | { readonly type: "setSheetHidden"; readonly sheet: SheetId; readonly hidden: boolean }
  | { readonly type: "setSheetColor"; readonly sheet: SheetId; readonly color: string | null }
  | { readonly type: "setActiveSheet"; readonly sheet: SheetId }
  // filter
  | { readonly type: "setAutoFilter"; readonly sheet: SheetId; readonly range: CellRange | null }
  | { readonly type: "filterColumn"; readonly sheet: SheetId; readonly col: number; readonly criteria: FilterCriteria | null }
  // charts
  | { readonly type: "addChart"; readonly chart: Omit<ChartSpec, "id" | "fromFile"> }
  | { readonly type: "updateChart"; readonly chart: Omit<ChartSpec, "fromFile"> }
  | { readonly type: "deleteChart"; readonly sheet: SheetId; readonly id: ChartId };

export type EngineOpType = EngineOp["type"];

/** Selection the UI should show after an operation, undo or redo (Excel restores it). */
export interface SelectionHint {
  readonly sheet: SheetId;
  readonly ranges: ReadonlyArray<CellRange>;
  readonly active: CellAddress;
}

export interface ApplyResult {
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly selection: SelectionHint | null;
  /** Ids created by the batch (`addSheet`, `duplicateSheet`, `addChart`), in op order. */
  readonly created: ReadonlyArray<number>;
  /** Number of cells changed by `replace`, `fill`, `paste`… (for status messages). */
  readonly affected: number;
  /** Engine time spent, for diagnostics. */
  readonly elapsedMs: number;
}

export interface ClipboardData {
  /** Pass back in `PasteSource.internal`. */
  readonly clipId: number;
  /** Tab-separated display values for the system clipboard. */
  readonly text: string;
  /** HTML table with inline styles for the system clipboard. */
  readonly html: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EngineEvent =
  /** Cell contents changed (edit, recalc, CSV streaming). The grid refetches affected blocks. */
  | { readonly type: "cells"; readonly doc: DocumentId; readonly sheet: SheetId; readonly ranges: ReadonlyArray<CellRange> }
  /** Everything in a sheet may have changed (full recalc, sort, paste…): refetch visible blocks. */
  | { readonly type: "sheetData"; readonly doc: DocumentId; readonly sheet: SheetId }
  /** `SheetInfo` changed (sizes, merges, frozen panes, filter…): call `getSheetInfo` again. */
  | { readonly type: "sheetInfo"; readonly doc: DocumentId; readonly sheet: SheetId; readonly version: number }
  /** Rows/cols inserted or deleted; lets the grid shift its cache before refetching. */
  | { readonly type: "structure"; readonly doc: DocumentId; readonly sheet: SheetId; readonly axis: "row" | "col"; readonly op: "insert" | "delete"; readonly index: number; readonly count: number }
  /** Style table entries changed meaning (rare: theme change). */
  | { readonly type: "styles"; readonly doc: DocumentId }
  /** Sheet list, names, order, colors or active sheet changed. */
  | { readonly type: "sheets"; readonly doc: DocumentId; readonly sheets: ReadonlyArray<SheetMeta>; readonly activeSheet: SheetId }
  | { readonly type: "charts"; readonly doc: DocumentId; readonly sheet: SheetId }
  | { readonly type: "docState"; readonly doc: DocumentId; readonly dirty: boolean; readonly canUndo: boolean; readonly canRedo: boolean }
  /** Large CSV streaming progress. `rowsLoaded` grows until `done`. */
  | { readonly type: "loadProgress"; readonly doc: DocumentId; readonly rowsLoaded: number; readonly bytesRead: number; readonly bytesTotal: number; readonly done: boolean; readonly error: string | null }
  /** The CSV fast store was converted into a full workbook (first formula/format edit). */
  | { readonly type: "backendChanged"; readonly doc: DocumentId; readonly backend: "workbook" | "csv" };

export type EngineEventListener = (event: EngineEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | "notFound"
  | "io"
  | "parse"
  | "unsupported"
  | "invalidOp"
  | "invalidFormula"
  | "sheetName"
  | "protected"
  | "tooLarge"
  | "internal";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface FunctionName {
  /** Upper-case en-US name, e.g. `SUMIFS`. */
  readonly name: string;
}

export interface WorkbookEngine {
  // documents
  newDocument(): Promise<DocumentInfo>;
  openDocument(path: string, options?: OpenOptions): Promise<DocumentInfo>;
  /** Browser/dev only (no filesystem): open from bytes. */
  openBytes(fileName: string, bytes: Uint8Array, options?: OpenOptions): Promise<DocumentInfo>;
  getDocumentInfo(doc: DocumentId): Promise<DocumentInfo>;
  saveDocument(doc: DocumentId, path: string, options: SaveOptions): Promise<SaveResult>;
  closeDocument(doc: DocumentId): Promise<void>;

  // grid data
  getSheetInfo(doc: DocumentId, sheet: SheetId): Promise<SheetInfo>;
  fetchBlocks(doc: DocumentId, req: BlockRequest): Promise<CellBlock[]>;
  /** Style definitions for render style ids. */
  getStyles(doc: DocumentId, ids: ReadonlyArray<StyleId>): Promise<ReadonlyArray<readonly [StyleId, CellStyle]>>;
  /** Excel Ctrl+Arrow target ("jump to data edge"). */
  findDataEdge(doc: DocumentId, sheet: SheetId, from: CellAddress, dir: Direction): Promise<CellAddress>;
  /** Longest display strings of a column, for autofit. */
  getColumnTextSamples(doc: DocumentId, sheet: SheetId, col: number, limit: number): Promise<TextSample[]>;

  // cell queries
  getCell(doc: DocumentId, sheet: SheetId, cell: CellAddress): Promise<CellDetails>;
  getRangeValues(doc: DocumentId, sheet: SheetId, range: CellRange): Promise<RangeValues>;
  getSelectionStats(doc: DocumentId, sheet: SheetId, ranges: ReadonlyArray<CellRange>): Promise<SelectionStats>;
  find(doc: DocumentId, query: FindQuery): Promise<FindMatch[]>;
  getFilterValues(doc: DocumentId, sheet: SheetId, col: number, limit: number): Promise<FilterValue[]>;
  getCharts(doc: DocumentId, sheet: SheetId): Promise<ChartSpec[]>;

  // mutations
  apply(doc: DocumentId, ops: ReadonlyArray<EngineOp>): Promise<ApplyResult>;
  undo(doc: DocumentId): Promise<ApplyResult>;
  redo(doc: DocumentId): Promise<ApplyResult>;
  /** Copies a range into the engine clipboard and returns text/HTML for the system clipboard. */
  copy(doc: DocumentId, sheet: SheetId, range: CellRange): Promise<ClipboardData>;

  // formulas
  listFunctions(): Promise<FunctionName[]>;

  subscribe(listener: EngineEventListener): () => void;
}
