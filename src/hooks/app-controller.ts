import type {
  ApplyResult,
  BorderPreset,
  BorderStyle,
  CellDetails,
  EngineOp,
  PasteMode,
  SheetInfo,
  WorkbookEngine,
} from "@/engine/contract";
import type { CellAddress, CellRange, SheetId } from "@/engine/types";
import type { GridContextMenuEvent, GridHandle } from "@/grid/api";
import { CommandRegistry, type CommandId } from "@/model/commands";
import type { SelectionState } from "@/model/selection";
import type { SettingsStore } from "@/lib/settings";
import {
  ClipboardState,
  choosePasteSource,
  type ClipboardContents,
  type SystemClipboard,
} from "@/hooks/clipboard";
import { ChartIntegration } from "@/hooks/chart-integration";
import type { FileGateway } from "@/hooks/file-gateway";
import { SelectionStatsTracker } from "@/hooks/selection-stats";
import { activeRangeOf, rangeSelection, selectionForContextClick } from "@/hooks/selection-ops";
import { SessionManager, errorMessage } from "@/hooks/session-manager";
import { GLOBAL_COMMANDS, isEditableTarget, matchCommand, type KeyLike } from "@/hooks/shortcuts";
import { createStore } from "@/hooks/store";
import type { WorkbookSession } from "@/hooks/workbook-session";

/**
 * The shell's brain, independent of React: owns the `SessionManager`, the
 * command registry and the small observable stores the UI renders (dialogs,
 * menus, notices, active-cell format for toolbar toggles, active sheet info).
 * Actions live in `src/hooks/actions/*` and take the controller as argument;
 * `registerShellCommands` (app-commands.ts) exposes them as commands.
 */

export type FormatCellsTab = "number" | "alignment" | "font" | "border" | "fill";

export type DialogState =
  | { readonly kind: "formatCells"; readonly tab: FormatCellsTab }
  | { readonly kind: "find"; readonly tab: "find" | "replace" }
  | { readonly kind: "goTo" }
  | { readonly kind: "sortCustom" }
  | { readonly kind: "insertCells" }
  | { readonly kind: "deleteCells" }
  | { readonly kind: "pasteSpecial" }
  | { readonly kind: "csvOptions"; readonly sessionId: string }
  | { readonly kind: "rowHeight" }
  | { readonly kind: "colWidth" }
  | { readonly kind: "deleteSheet"; readonly sheet: SheetId }
  | { readonly kind: "unhideSheets" }
  | { readonly kind: "about" }
  | { readonly kind: "options" };

export interface Notice {
  readonly id: number;
  readonly kind: "error" | "info";
  readonly message: string;
}

export interface MenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FilterMenuState {
  readonly sessionId: string;
  readonly sheet: SheetId;
  readonly col: number;
  readonly anchor: MenuAnchor;
}

export interface ContextMenuState {
  readonly region: GridContextMenuEvent["region"];
  readonly x: number;
  readonly y: number;
}

export interface PainterState {
  readonly sessionId: string;
  readonly sheet: SheetId;
  readonly source: CellRange;
  /** Double click on the button: keeps painting until Esc. */
  readonly sticky: boolean;
}

export interface BorderChoice {
  readonly preset: BorderPreset;
  readonly style: BorderStyle;
  readonly color: string;
}

export interface AppControllerDeps {
  readonly engine: WorkbookEngine;
  readonly files: FileGateway;
  readonly clipboard: SystemClipboard;
  readonly settings: SettingsStore;
  readonly destroyWindow?: () => Promise<void>;
  /** Debounce for active-cell refreshes (ms). 0 = synchronous scheduling for tests. */
  readonly refreshDelayMs?: number;
  /** Fallback delay before a Ctrl+V without DOM paste event reads the clipboard API. */
  readonly pasteFallbackMs?: number;
  /** Debounce for status bar statistics (ms). */
  readonly statsDelayMs?: number;
}

let nextNoticeId = 1;

export class AppController {
  readonly engine: WorkbookEngine;
  readonly manager: SessionManager;
  readonly registry = new CommandRegistry();
  readonly settings: SettingsStore;
  readonly clipboard: ClipboardState;
  /** Status bar statistics of the active selection. */
  readonly stats: SelectionStatsTracker;
  /** Injection point for charts (WS6); see `chart-integration.ts`. */
  readonly charts = new ChartIntegration();

  readonly dialog = createStore<DialogState | null>(null);
  readonly filterMenu = createStore<FilterMenuState | null>(null);
  readonly contextMenu = createStore<ContextMenuState | null>(null);
  readonly notices = createStore<ReadonlyArray<Notice>>([]);
  /** Details of the active cell (toolbar toggles, format dialog). */
  readonly activeCell = createStore<CellDetails | null>(null);
  /** Info of the active sheet (frozen panes, grid lines, autofilter). */
  readonly sheetInfo = createStore<SheetInfo | null>(null);
  readonly painter = createStore<PainterState | null>(null);
  /** Sheet whose tab is in inline-rename mode (double click, "Cambiar nombre"). */
  readonly renamingSheet = createStore<SheetId | null>(null);
  /** Last colors / border used by the split buttons. */
  readonly lastFontColor = createStore("#c00000");
  readonly lastFill = createStore("#ffff00");
  readonly lastBorder = createStore<BorderChoice>({ preset: "bottom", style: "thin", color: "#000000" });

  private readonly refreshDelay: number;
  private readonly pasteFallbackMs: number;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshToken = 0;
  private boundSession: WorkbookSession | null = null;
  private unbindSession: (() => void) | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly disposers: Array<() => void> = [];

  constructor(deps: AppControllerDeps) {
    this.engine = deps.engine;
    this.settings = deps.settings;
    this.clipboard = new ClipboardState(deps.clipboard);
    this.refreshDelay = deps.refreshDelayMs ?? 60;
    this.pasteFallbackMs = deps.pasteFallbackMs ?? 120;
    this.manager = new SessionManager(deps.engine, deps.files, {
      onError: (message) => this.notify(message, "error"),
      onInfo: (message) => this.notify(message, "info"),
      onPathUsed: (path) => this.settings.addRecentFile(path),
      destroyWindow: deps.destroyWindow,
      csvDefaults: () => {
        const { delimiter, encoding, decimal } = this.settings.get().csv;
        return { delimiter, encoding, decimal };
      },
      csvSaveDelimiter: () => this.settings.get().csv.saveDelimiter,
    });
    this.stats = new SelectionStatsTracker(deps.engine, this.manager, deps.statsDelayMs ?? 120);
    this.disposers.push(
      () => this.stats.dispose(),
      this.manager.state.subscribe(() => this.bindActiveSession()),
      this.charts.insertHandler.subscribe(() => this.registry.changed()),
      this.clipboard.clip.subscribe(() => {
        this.updateMarquee();
        this.registry.changed();
      }),
      this.painter.subscribe(() => this.registry.changed()),
      this.dialog.subscribe(() => {
        this.contextMenu.set(null);
      }),
    );
  }

  dispose(): void {
    this.unbindSession?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    for (const dispose of this.disposers) dispose();
    this.manager.dispose();
  }

  // ----- accessors -----------------------------------------------------------

  get session(): WorkbookSession | null {
    return this.manager.active;
  }

  get selection(): SelectionState | null {
    return this.session?.selection.get() ?? null;
  }

  // ----- notices & dialogs ---------------------------------------------------

  notify(message: string, kind: Notice["kind"] = "info"): void {
    const notice: Notice = { id: nextNoticeId++, kind, message };
    this.notices.update((list) => [...list.filter((n) => n.message !== message), notice].slice(-4));
  }

  dismissNotice(id: number): void {
    this.notices.update((list) => list.filter((n) => n.id !== id));
  }

  openDialog(state: DialogState): void {
    this.dialog.set(state);
  }

  closeDialog(): void {
    this.dialog.set(null);
    this.focusGrid();
  }

  focusGrid(): void {
    const grid = this.session?.grid;
    if (grid) requestAnimationFrame(() => grid.focus());
  }

  /** True while a modal UI (dialog, unsaved prompt) owns the keyboard. */
  get modalOpen(): boolean {
    const dialog = this.dialog.get();
    // "Buscar y reemplazar" is modeless (like Excel): the grid keeps working.
    return (dialog !== null && dialog.kind !== "find") || this.manager.pending.get() !== null;
  }

  // ----- active session tracking -----------------------------------------------

  private bindActiveSession(): void {
    const session = this.manager.active;
    if (session === this.boundSession) return;
    this.unbindSession?.();
    this.boundSession = session;
    this.activeCell.set(null);
    this.sheetInfo.set(null);
    if (!session) {
      this.unbindSession = null;
      this.registry.changed();
      return;
    }
    let lastSheet = session.activeSheet;
    let lastUndo = `${session.info.canUndo}/${session.info.canRedo}/${session.info.backend}`;
    const unsubs = [
      session.selection.subscribe(() => this.scheduleRefresh(false)),
      session.meta.subscribe(() => {
        const undo = `${session.info.canUndo}/${session.info.canRedo}/${session.info.backend}`;
        if (session.activeSheet !== lastSheet) {
          lastSheet = session.activeSheet;
          this.updateMarquee();
          this.scheduleRefresh(true);
        } else if (undo !== lastUndo) {
          this.registry.changed();
        }
        lastUndo = undo;
      }),
      session.dataEvents.subscribe((event) => {
        if (!("sheet" in event) || event.sheet !== session.activeSheet) return;
        if (event.type === "sheetInfo" || event.type === "structure") this.scheduleRefresh(true);
        else if (event.type === "cells" || event.type === "sheetData") this.scheduleRefresh(false);
      }),
    ];
    this.unbindSession = () => unsubs.forEach((unsub) => unsub());
    this.updateMarquee();
    this.registry.changed();
    void this.refresh(true);
  }

  private pendingSheetRefresh = false;

  private scheduleRefresh(sheetToo: boolean): void {
    this.pendingSheetRefresh ||= sheetToo;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      const sheet = this.pendingSheetRefresh;
      this.pendingSheetRefresh = false;
      void this.refresh(sheet);
    }, this.refreshDelay);
  }

  /** Reloads the active cell details (and the sheet info) for toolbar states. */
  async refresh(sheetToo = true): Promise<void> {
    const session = this.session;
    if (!session) return;
    const token = ++this.refreshToken;
    const selection = session.selection.get();
    const sheet = selection.sheet;
    try {
      const [cell, info] = await Promise.all([
        this.engine.getCell(session.doc, sheet, selection.active),
        sheetToo || !this.sheetInfo.get() || this.sheetInfo.get()?.sheet !== sheet
          ? this.engine.getSheetInfo(session.doc, sheet)
          : Promise.resolve(this.sheetInfo.get()),
      ]);
      if (token !== this.refreshToken || this.session !== session) return;
      this.activeCell.set(cell);
      this.sheetInfo.set(info);
      this.registry.changed();
    } catch {
      // Document closed or sheet deleted meanwhile: the next refresh fixes it.
    }
  }

  // ----- mutations & navigation -------------------------------------------------

  /** Applies ops to the active document (one undo step). */
  async apply(ops: ReadonlyArray<EngineOp>): Promise<ApplyResult | null> {
    const session = this.session;
    if (!session) return null;
    const result = await this.manager.apply(session, ops);
    if (result) this.scheduleRefresh(true);
    return result;
  }

  /** Selects a range (switching sheets if needed) and scrolls it into view. */
  async select(sheet: SheetId, range: CellRange, active?: CellAddress): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (sheet !== session.activeSheet) await this.manager.setActiveSheet(session, sheet);
    const selection = rangeSelection(sheet, range, active);
    session.selection.set(selection);
    session.grid?.scrollIntoView(selection.active);
    this.focusGrid();
  }

  // ----- grid wiring -------------------------------------------------------------

  /** WorkbookView calls this when the grid mounts/unmounts. */
  attachGrid(session: WorkbookSession, grid: GridHandle | null): void {
    session.grid = grid;
    if (grid && session === this.session) {
      grid.setCopyMarquee(this.clipboard.marqueeFor(session.id, session.activeSheet));
      grid.setCursorMode(this.painter.get()?.sessionId === session.id ? "formatPainter" : "default");
    }
  }

  updateMarquee(): void {
    const session = this.session;
    session?.grid?.setCopyMarquee(this.clipboard.marqueeFor(session.id, session.activeSheet));
  }

  /** Grid right click: moves the selection when clicking outside it, then opens the menu. */
  openContextMenu(event: GridContextMenuEvent): void {
    const session = this.session;
    if (!session) return;
    const next = selectionForContextClick(session.selection.get(), event.region, event.cell);
    if (next) session.selection.set(next);
    this.contextMenu.set({ region: event.region, x: event.clientX, y: event.clientY });
  }

  // ----- keyboard ------------------------------------------------------------------

  /**
   * Routes a key to the command registry. `origin` is "grid" for
   * `GridProps.onUnhandledKey`, "window" for the global listener. Returns true
   * when a command handled it.
   */
  handleKey(event: KeyLike & { target?: EventTarget | null; defaultPrevented?: boolean; isComposing?: boolean; preventDefault?: () => void }, origin: "grid" | "window"): boolean {
    if (event.defaultPrevented || event.isComposing) return false;
    const command = matchCommand(this.registry, event);
    if (!command) return false;
    const global = GLOBAL_COMMANDS.has(command.id);
    if (origin === "window" && isEditableTarget(event.target ?? null) && !global) return false;
    if (this.modalOpen && !global) return false;
    const mod = event.ctrlKey || event.metaKey;
    if (command.isEnabled && !command.isEnabled()) {
      // Keep the browser from acting on Ctrl shortcuts (Ctrl+S, Ctrl+F…), let Esc & co. through.
      if (mod) event.preventDefault?.();
      return mod;
    }
    if (command.id === "edit.paste" && mod && !event.altKey) {
      // Let the DOM paste event bring the clipboard contents (no permission
      // prompt); fall back to the async Clipboard API if it never arrives.
      this.expectPasteEvent();
      return true;
    }
    event.preventDefault?.();
    if (global && !this.settleEdit(command.id)) return true;
    void this.registry.run(command.id, { source: "shortcut" }).catch((error: unknown) => this.notify(errorMessage(error), "error"));
    return true;
  }

  private expectPasteEvent(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = null;
      void this.paste("all");
    }, this.pasteFallbackMs);
  }

  /** Document `paste` event (outside text fields). */
  handlePasteEvent(contents: ClipboardContents | null): boolean {
    if (this.modalOpen) return false;
    if (this.pasteTimer) {
      clearTimeout(this.pasteTimer);
      this.pasteTimer = null;
    }
    void this.paste("all", contents);
    return true;
  }

  /**
   * Finishes a pending cell edit before a command from the toolbar, a menu or
   * a global shortcut runs (Excel commits the entry first). Returns false
   * when the entry is invalid and the editor stays open.
   */
  settleEdit(id: CommandId): boolean {
    const editor = this.session?.editor;
    if (!editor?.isEditing()) return true;
    if (id === "edit.undo") {
      editor.cancel();
      return false;
    }
    return editor.commit("none");
  }

  async runCommand(id: CommandId, source: "toolbar" | "menu" | "contextMenu" | "palette" | "api" = "toolbar"): Promise<boolean> {
    if (source !== "api" && !this.settleEdit(id)) return false;
    try {
      return await this.registry.run(id, { source });
    } catch (error) {
      this.notify(errorMessage(error), "error");
      return false;
    }
  }

  // ----- clipboard ----------------------------------------------------------------

  async copy(cut: boolean): Promise<void> {
    const session = this.session;
    if (!session) return;
    const selection = session.selection.get();
    if (selection.ranges.length > 1) {
      this.notify("Este comando no se puede usar con selecciones múltiples.", "error");
      return;
    }
    const range = activeRangeOf(selection);
    try {
      const data = await this.engine.copy(session.doc, selection.sheet, range);
      this.clipboard.remember({ sessionId: session.id, doc: session.doc, sheet: selection.sheet, range, clipId: data.clipId, cut, text: data.text });
      try {
        await this.clipboard.system.write(data.text, data.html);
      } catch {
        // Internal paste still works; other apps won't see it.
      }
    } catch (error) {
      this.notify(errorMessage(error), "error");
    }
  }

  /**
   * Pastes into the selection. `contents` comes from a DOM paste event; when
   * absent the system clipboard is read through the Clipboard API.
   */
  async paste(mode: PasteMode, contents?: ClipboardContents | null): Promise<void> {
    const session = this.session;
    if (!session) return;
    const selection = session.selection.get();
    if (selection.ranges.length > 1) {
      this.notify("Este comando no se puede usar con selecciones múltiples.", "error");
      return;
    }
    let data = contents ?? null;
    if (contents === undefined) {
      try {
        data = await this.clipboard.system.read();
      } catch {
        data = null;
      }
    }
    const clip = this.clipboard.clip.get();
    const source = choosePasteSource(clip, data);
    if (!source) {
      if (data === null && !clip) this.notify("No se puede leer el portapapeles. Usa Ctrl+V para pegar.", "error");
      return;
    }
    if (source.kind !== "internal" && (mode === "formats" || mode === "formulas")) {
      this.notify("Solo se pueden pegar formatos o fórmulas copiados desde Sheetlight.", "error");
      return;
    }
    const target = activeRangeOf(selection);
    const result = await this.apply([{ type: "paste", sheet: selection.sheet, target, source, mode }]);
    if (result && source.kind === "internal" && source.cut) this.clipboard.clear();
  }

  clearMarquee(): void {
    this.clipboard.clear();
    this.stopFormatPainter();
  }

  // ----- charts --------------------------------------------------------------------

  /** "Insertar > Gráfico": hands the selection to the injected chart handler. */
  async insertChart(): Promise<void> {
    const handler = this.charts.insertHandler.get();
    const session = this.session;
    if (!session) return;
    if (!handler) {
      this.notify("Los gráficos todavía no están disponibles en esta versión.", "info");
      return;
    }
    await handler({
      engine: this.engine,
      doc: session.doc,
      sheet: session.activeSheet,
      selection: session.selection.get(),
      grid: session.grid,
      apply: (ops) => this.apply(ops),
    });
  }

  // ----- format painter ------------------------------------------------------------

  startFormatPainter(sticky = false): void {
    const session = this.session;
    if (!session) return;
    if (this.painter.get()) {
      this.stopFormatPainter();
      return;
    }
    const selection = session.selection.get();
    this.painter.set({ sessionId: session.id, sheet: selection.sheet, source: activeRangeOf(selection), sticky });
    session.grid?.setCursorMode("formatPainter");
  }

  stopFormatPainter(): void {
    if (!this.painter.get()) return;
    this.painter.set(null);
    this.session?.grid?.setCursorMode("default");
  }

  /** Pointer released over the grid while painting: copy the format to the new selection. */
  async finishFormatPainter(): Promise<void> {
    const painter = this.painter.get();
    const session = this.session;
    if (!painter || !session || painter.sessionId !== session.id) return;
    const selection = session.selection.get();
    if (selection.sheet !== painter.sheet) {
      this.notify("El formato solo se puede copiar dentro de la misma hoja.", "error");
      this.stopFormatPainter();
      return;
    }
    if (!painter.sticky) this.stopFormatPainter();
    await this.apply([{ type: "copyFormat", sheet: painter.sheet, source: painter.source, targets: selection.ranges }]);
  }
}
