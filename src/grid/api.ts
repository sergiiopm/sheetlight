import type { EngineOp, WorkbookEngine } from "@/engine/contract";
import type { CellAddress, CellRange, DocumentId, SheetId } from "@/engine/types";
import type { SelectionStore } from "@/model/selection";

/**
 * Public API of the grid (WS1) for the rest of the app. Everything else in
 * `src/grid` is internal. The React host is `<SpreadsheetGrid {...props} />`
 * exported from `src/grid/index.ts`; it forwards a ref of type `GridHandle`.
 */

export interface GridProps {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly sheet: SheetId;
  /** Selection store of this document; the grid reads and writes it. */
  readonly selection: SelectionStore;
  /** Restored when switching back to a sheet/document. */
  readonly initialView?: GridViewport;
  /** Grid-originated mutations (resize, autofit, fill handle drag, drag-move). */
  readonly onApply: (ops: EngineOp[]) => void;
  /** The user wants to edit a cell (typing, F2, double click, Backspace). */
  readonly onEditRequest: (request: EditRequest) => void;
  /** Keys the grid does not handle (shortcuts) bubble here. */
  readonly onUnhandledKey?: (event: KeyboardEvent) => void;
  readonly onContextMenu?: (event: GridContextMenuEvent) => void;
  /** Click on an autofilter dropdown button in a header cell. */
  readonly onFilterButton?: (col: number, anchor: DOMRect) => void;
  readonly onViewportChange?: (view: GridViewport) => void;
  readonly readOnly?: boolean;
}

export interface EditRequest {
  readonly cell: CellAddress;
  /** `type`: the first typed character is in `initialText` and replaces the content. */
  readonly source: "type" | "f2" | "dblclick" | "backspace";
  readonly initialText?: string;
}

export interface GridContextMenuEvent {
  readonly region: "cell" | "rowHeader" | "colHeader" | "corner";
  readonly cell: CellAddress;
  readonly clientX: number;
  readonly clientY: number;
}

export interface GridViewport {
  /** Top-left visible cell of the scrollable pane. */
  readonly topLeft: CellAddress;
  /** 0.5 .. 2 (50%–200%). */
  readonly zoom: number;
}

/** Colored range shown while editing a formula (Excel reference highlighting). */
export interface RefHighlight {
  readonly range: CellRange;
  /** `#rrggbb` */
  readonly color: string;
}

/**
 * Reference mode: while the user edits a formula and the caret is at a place
 * where a reference can go, clicks/drags on the grid (and arrow keys, when the
 * editor forwards them) produce a range for the editor instead of moving the
 * selection.
 */
export interface ReferencePicker {
  /** Called continuously while dragging, and once more with `final = true`. */
  onPick(range: CellRange, final: boolean): void;
}

export interface GridHandle {
  focus(): void;
  /** Cell rectangle in client (viewport) coordinates for overlays (editor, tooltips); null if not visible. */
  getCellRect(cell: CellAddress): DOMRect | null;
  scrollIntoView(cell: CellAddress): void;
  getViewport(): GridViewport;
  setZoom(zoom: number): void;
  setRefHighlights(highlights: ReadonlyArray<RefHighlight>): void;
  setReferencePicker(picker: ReferencePicker | null): void;
  /** Marching-ants marquee for copy/cut; null clears it. */
  setCopyMarquee(range: CellRange | null): void;
  /** Format painter / paste-preview cursor state. */
  setCursorMode(mode: "default" | "formatPainter"): void;
  /** Measures text and returns the best width for columns (CSS px @100%), for autofit commands. */
  measureAutofit(cols: ReadonlyArray<number>): Promise<ReadonlyArray<number>>;
}
