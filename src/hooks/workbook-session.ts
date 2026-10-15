import type {
  DocumentInfo,
  EngineEvent,
  SelectionHint,
  WorkbookEngine,
} from "@/engine/contract";
import type { DocumentId, SheetId } from "@/engine/types";
import { getFileName, untitledFileName } from "@/files/path";
import type { GridHandle, GridViewport } from "@/grid/api";
import {
  createSelectionStore,
  singleCellSelection,
  type SelectionState,
  type SelectionStore,
} from "@/model/selection";
import { hintToSelection } from "@/hooks/selection-ops";
import { createStore, Emitter, type Store } from "@/hooks/store";

/**
 * One open document (a workbook tab). Holds everything the shell keeps per
 * document outside the engine:
 * - `meta`: immutable snapshot of tab-level state (`DocumentInfo` kept in sync
 *   with engine events: sheets, active sheet, dirty, undo state, backend…);
 * - `selection`: the active sheet's selection; the last selection of every
 *   other sheet is remembered and restored when switching back;
 * - the grid view (scroll position + zoom) per sheet;
 * - `grid`: the mounted grid's handle (null while not mounted).
 *
 * Cell data never lives here: the grid fetches it from the engine.
 */

export type OpenSource =
  | { readonly kind: "new" }
  | { readonly kind: "path"; readonly path: string }
  /** Browser dev only: bytes kept to re-open a CSV with other options. */
  | { readonly kind: "bytes"; readonly name: string; readonly bytes: Uint8Array };

export interface SessionMeta {
  readonly info: DocumentInfo;
  /** N of "LibroN.xlsx" for documents without a path. */
  readonly untitled: number;
  /** The fidelity banner was dismissed. */
  readonly warningsDismissed: boolean;
  /** The CSV options hint was dismissed. */
  readonly csvHintDismissed: boolean;
}

export interface LoadState {
  readonly rowsLoaded: number;
  readonly bytesRead: number;
  readonly bytesTotal: number;
  readonly done: boolean;
  readonly error: string | null;
}

/** What the shell needs from the editor session (`EditSession` satisfies it). */
export interface ShellEditor {
  isEditing(): boolean;
  commit(move: "none"): boolean;
  cancel(): void;
}

export const DEFAULT_VIEW: GridViewport = { topLeft: { row: 0, col: 0 }, zoom: 1 };

let nextSessionNumber = 1;

export class WorkbookSession {
  readonly id = `wb-${nextSessionNumber++}`;
  readonly meta: Store<SessionMeta>;
  readonly selection: SelectionStore;
  /** CSV streaming progress (null when nothing is loading). */
  readonly load: Store<LoadState | null>;
  /** Zoom of the active sheet (status bar, Vista menu). */
  readonly zoom: Store<number>;
  /** Excel status-bar mode of the editor: "Listo", "Introducir", "Modificar" or "Señalar". */
  readonly editMode = createStore("Listo");
  /**
   * The mounted editor of this document (set by the workbook view). The
   * shell commits a pending edit before running toolbar/menu commands.
   */
  editor: ShellEditor | null = null;
  /** Engine data events of this document (cells, sheetData, sheetInfo, structure, charts…). */
  readonly dataEvents = new Emitter<EngineEvent>();
  source: OpenSource;
  grid: GridHandle | null = null;

  private readonly sheetSelections = new Map<SheetId, SelectionState>();
  private readonly views = new Map<SheetId, GridViewport>();
  /** Sheet requested with `setActiveSheet` and not yet confirmed by the engine. */
  pendingActiveSheet: SheetId | null = null;

  constructor(
    readonly engine: WorkbookEngine,
    info: DocumentInfo,
    untitled: number,
    source: OpenSource,
  ) {
    this.source = source;
    this.meta = createStore<SessionMeta>({ info, untitled, warningsDismissed: false, csvHintDismissed: false });
    this.selection = createSelectionStore(singleCellSelection(info.activeSheet));
    this.load = createStore<LoadState | null>(
      info.loading ? { rowsLoaded: 0, bytesRead: 0, bytesTotal: 0, done: false, error: null } : null,
    );
    this.zoom = createStore(DEFAULT_VIEW.zoom);
  }

  get doc(): DocumentId {
    return this.meta.get().info.doc;
  }

  get info(): DocumentInfo {
    return this.meta.get().info;
  }

  get activeSheet(): SheetId {
    return this.meta.get().info.activeSheet;
  }

  get fileName(): string {
    return sessionFileName(this.meta.get());
  }

  /** An untouched new workbook: replaced when the user opens a file. */
  isPristine(): boolean {
    const { info } = this.meta.get();
    return info.sourceFormat === "new" && !info.path && !info.dirty && !info.canUndo;
  }

  patchInfo(patch: Partial<DocumentInfo>): void {
    this.meta.update((meta) => ({ ...meta, info: { ...meta.info, ...patch } }));
  }

  patchMeta(patch: Partial<Omit<SessionMeta, "info">>): void {
    this.meta.update((meta) => ({ ...meta, ...patch }));
  }

  /** Replaces the document behind this tab (CSV re-open with other options). */
  replaceInfo(info: DocumentInfo): void {
    this.sheetSelections.clear();
    this.views.clear();
    this.meta.update((meta) => ({ ...meta, info }));
    this.selection.set(singleCellSelection(info.activeSheet));
    this.zoom.set(DEFAULT_VIEW.zoom);
    this.load.set(info.loading ? { rowsLoaded: 0, bytesRead: 0, bytesTotal: 0, done: false, error: null } : null);
  }

  /**
   * Local part of switching sheets: remembers the current sheet's selection
   * and restores the target's. Returns false if already active or unknown.
   */
  showSheet(sheet: SheetId): boolean {
    const { info } = this.meta.get();
    if (sheet === info.activeSheet || !info.sheets.some((s) => s.id === sheet)) return false;
    this.sheetSelections.set(info.activeSheet, this.selection.get());
    this.patchInfo({ activeSheet: sheet });
    this.selection.set(this.sheetSelections.get(sheet) ?? singleCellSelection(sheet));
    this.zoom.set(this.viewFor(sheet).zoom);
    return true;
  }

  viewFor(sheet: SheetId): GridViewport {
    return this.views.get(sheet) ?? DEFAULT_VIEW;
  }

  /** Called by the grid on scroll/zoom (no React state involved). */
  setViewport(view: GridViewport, sheet: SheetId = this.activeSheet): void {
    this.views.set(sheet, view);
    if (sheet === this.activeSheet) this.zoom.set(view.zoom);
  }

  /** Applies an engine selection hint (after apply/undo/redo). The caller switches sheets first. */
  applyHint(hint: SelectionHint): void {
    if (hint.sheet !== this.activeSheet) {
      this.sheetSelections.set(hint.sheet, hintToSelection(hint));
      return;
    }
    this.selection.set(hintToSelection(hint));
  }

  /** Engine events for this document. */
  handleEvent(event: EngineEvent): void {
    switch (event.type) {
      case "sheets": {
        this.patchInfo({ sheets: event.sheets });
        const ids = new Set(event.sheets.map((s) => s.id));
        const pending = this.pendingActiveSheet;
        if (pending !== null && event.activeSheet === pending) this.pendingActiveSheet = null;
        // While our own sheet switch is in flight, older events still carry the previous sheet.
        const stale = pending !== null && event.activeSheet !== pending && ids.has(this.activeSheet);
        if (!stale && event.activeSheet !== this.activeSheet && ids.has(event.activeSheet)) this.showSheet(event.activeSheet);
        for (const id of [...this.sheetSelections.keys()]) if (!ids.has(id)) this.sheetSelections.delete(id);
        for (const id of [...this.views.keys()]) if (!ids.has(id)) this.views.delete(id);
        break;
      }
      case "docState":
        this.patchInfo({ dirty: event.dirty, canUndo: event.canUndo, canRedo: event.canRedo });
        break;
      case "loadProgress":
        this.load.set(
          event.done && !event.error
            ? null
            : { rowsLoaded: event.rowsLoaded, bytesRead: event.bytesRead, bytesTotal: event.bytesTotal, done: event.done, error: event.error },
        );
        if (event.done) this.patchInfo({ loading: false });
        this.dataEvents.emit(event);
        break;
      case "backendChanged":
        this.patchInfo({ backend: event.backend });
        break;
      default:
        this.dataEvents.emit(event);
    }
  }
}

export function sessionFileName(meta: SessionMeta): string {
  return meta.info.path ? getFileName(meta.info.path) : untitledFileName(meta.untitled);
}

/** Window title: "Libro1.xlsx — Sheetlight", with "• " when unsaved (like the tab dot). */
export function windowTitle(meta: SessionMeta | null): string {
  if (!meta) return "Sheetlight";
  return `${meta.info.dirty ? "• " : ""}${sessionFileName(meta)} — Sheetlight`;
}
