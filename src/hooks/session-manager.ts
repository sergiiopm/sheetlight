import {
  EngineError,
  type ApplyResult,
  type CsvOptions,
  type DocumentInfo,
  type EngineOp,
  type FidelityFeature,
  type OpenOptions,
  type SaveFormat,
  type SaveResult,
  type WorkbookEngine,
} from "@/engine/contract";
import type { SheetId } from "@/engine/types";
import { getFileName, getFormatFromPath, samePath } from "@/files/path";
import type { FileGateway, PickedFile } from "@/hooks/file-gateway";
import { createStore, type Store } from "@/hooks/store";
import { WorkbookSession, sessionFileName, type OpenSource } from "@/hooks/workbook-session";

/**
 * Owns the open documents (workbook tabs): new / open / close / save / save
 * as, the unsaved-changes flow (tab close and window close), routing of
 * engine events to sessions, and the `apply` wrapper every mutation goes
 * through (dirty/undo state, selection hints, Spanish errors).
 *
 * Framework independent; React reads `state` and `pending` with `useStore`.
 */

export interface SessionsState {
  readonly sessions: ReadonlyArray<WorkbookSession>;
  readonly activeId: string | null;
}

export interface PendingClose {
  readonly sessionId: string;
  /** Closing the whole window (walks every unsaved document). */
  readonly closeWindow: boolean;
}

export interface SessionManagerHooks {
  onError(message: string): void;
  onInfo(message: string): void;
  /** A document was opened from or saved to `path` (recent files). */
  onPathUsed?(path: string): void;
  /** Really closes the native window (after the unsaved-changes walk). */
  destroyWindow?(): Promise<void>;
  /** CSV defaults from settings (null fields = auto-detect). */
  csvDefaults?(): Partial<CsvOptions>;
  /** Delimiter for CSV saves. */
  csvSaveDelimiter?(): NonNullable<CsvOptions["delimiter"]>;
}

const SUPPORTED_MESSAGE = "Sheetlight solo abre archivos .xlsx, .xls y .csv.";

const FEATURE_NAMES: Record<FidelityFeature, string> = {
  charts: "gráficos",
  images: "imágenes",
  shapes: "formas",
  comments: "comentarios",
  dataValidation: "validación de datos",
  autoFilter: "filtros",
  conditionalFormatting: "formato condicional",
  pivotTables: "tablas dinámicas",
  tables: "tablas",
  macros: "macros",
  externalLinks: "vínculos externos",
  sparklines: "minigráficos",
  slicers: "segmentaciones",
  other: "otros elementos",
};

export function featureName(feature: FidelityFeature): string {
  return FEATURE_NAMES[feature];
}

/** Spanish, user-facing message for anything thrown by the engine or the platform. */
export function errorMessage(error: unknown, fallback = "Se ha producido un error inesperado."): string {
  if (error instanceof EngineError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function nextUntitled(sessions: ReadonlyArray<WorkbookSession>): number {
  const used = new Set(sessions.filter((s) => !s.info.path).map((s) => s.meta.get().untitled));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function withExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

export class SessionManager {
  readonly state: Store<SessionsState> = createStore<SessionsState>({ sessions: [], activeId: null });
  readonly pending: Store<PendingClose | null> = createStore<PendingClose | null>(null);

  private openQueue: Promise<unknown> = Promise.resolve();
  private readonly skippedOnClose = new Set<string>();
  private allowWindowClose = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly engine: WorkbookEngine,
    private readonly files: FileGateway,
    private readonly hooks: SessionManagerHooks,
  ) {
    this.unsubscribe = engine.subscribe((event) => {
      const session = this.state.get().sessions.find((s) => s.doc === event.doc);
      session?.handleEvent(event);
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  get sessions(): ReadonlyArray<WorkbookSession> {
    return this.state.get().sessions;
  }

  get active(): WorkbookSession | null {
    const { sessions, activeId } = this.state.get();
    return sessions.find((s) => s.id === activeId) ?? null;
  }

  byId(id: string): WorkbookSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** True when closing the window would lose work. */
  get anyDirty(): boolean {
    return this.sessions.some((s) => s.info.dirty);
  }

  // ----- tabs --------------------------------------------------------------

  activate(id: string): void {
    if (!this.byId(id)) return;
    this.state.update((state) => ({ ...state, activeId: id }));
  }

  cycle(step: 1 | -1): void {
    const { sessions, activeId } = this.state.get();
    if (sessions.length < 2) return;
    const index = sessions.findIndex((s) => s.id === activeId);
    this.activate(sessions[(index + step + sessions.length) % sessions.length].id);
  }

  move(id: string, overId: string): void {
    const sessions = [...this.sessions];
    const from = sessions.findIndex((s) => s.id === id);
    const to = sessions.findIndex((s) => s.id === overId);
    if (from === -1 || to === -1 || from === to) return;
    const [moved] = sessions.splice(from, 1);
    sessions.splice(to, 0, moved);
    this.state.update((state) => ({ ...state, sessions }));
  }

  private addSession(session: WorkbookSession, replacePristine: boolean): void {
    const { sessions, activeId } = this.state.get();
    const active = sessions.find((s) => s.id === activeId);
    if (replacePristine && active && active.isPristine()) {
      this.state.set({ sessions: sessions.map((s) => (s === active ? session : s)), activeId: session.id });
      void this.engine.closeDocument(active.doc).catch(() => undefined);
      return;
    }
    this.state.set({ sessions: [...sessions, session], activeId: session.id });
  }

  private createSession(info: DocumentInfo, source: OpenSource): WorkbookSession {
    return new WorkbookSession(this.engine, info, info.path ? 0 : nextUntitled(this.sessions), source);
  }

  // ----- new / open ----------------------------------------------------------

  async newWorkbook(): Promise<WorkbookSession | null> {
    try {
      const info = await this.engine.newDocument();
      const session = this.createSession(info, { kind: "new" });
      this.addSession(session, false);
      return session;
    } catch (error) {
      this.hooks.onError(errorMessage(error, "No se pudo crear el libro."));
      return null;
    }
  }

  /** Makes sure at least one workbook is open (start-up, after closing the last tab). */
  async ensureOne(): Promise<void> {
    if (this.sessions.length === 0) await this.newWorkbook();
  }

  /** Opens files one after another so tabs keep the requested order. */
  openPaths(paths: ReadonlyArray<string>): Promise<void> {
    const run = paths.reduce<Promise<unknown>>((queue, path) => queue.then(() => this.openPath(path)), this.openQueue);
    this.openQueue = run.catch(() => undefined);
    return this.openQueue.then(() => undefined);
  }

  async openPath(path: string, options?: OpenOptions): Promise<WorkbookSession | null> {
    const existing = this.sessions.find((s) => s.info.path && samePath(s.info.path, path));
    if (existing) {
      this.activate(existing.id);
      return existing;
    }
    const name = getFileName(path);
    if (!getFormatFromPath(path)) {
      this.hooks.onError(`«${name}»: ${SUPPORTED_MESSAGE}`);
      return null;
    }
    try {
      const info = await this.engine.openDocument(path, this.openOptions(path, options));
      const session = this.createSession(info, { kind: "path", path });
      this.addSession(session, true);
      this.hooks.onPathUsed?.(path);
      return session;
    } catch (error) {
      this.hooks.onError(`No se pudo abrir «${name}». ${errorMessage(error, "")}`.trim());
      return null;
    }
  }

  /** Browser dev path: the picked files' bytes go to `engine.openBytes`. */
  async openFiles(files: ReadonlyArray<PickedFile>): Promise<void> {
    for (const file of files) {
      if (!getFormatFromPath(file.name)) {
        this.hooks.onError(`«${file.name}»: ${SUPPORTED_MESSAGE}`);
        continue;
      }
      try {
        const info = await this.engine.openBytes(file.name, file.bytes, this.openOptions(file.name));
        this.addSession(this.createSession(info, { kind: "bytes", name: file.name, bytes: file.bytes }), true);
      } catch (error) {
        this.hooks.onError(`No se pudo abrir «${file.name}». ${errorMessage(error, "")}`.trim());
      }
    }
  }

  /** "Abrir": native dialog in the desktop app, file input in the browser. */
  async open(): Promise<void> {
    try {
      if (this.files.native) await this.openPaths(await this.files.pickOpenPaths());
      else await this.openFiles(await this.files.pickBrowserFiles());
    } catch (error) {
      this.hooks.onError(errorMessage(error, "No se pudo abrir el libro."));
    }
  }

  private openOptions(name: string, options?: OpenOptions): OpenOptions | undefined {
    if (options) return options;
    if (getFormatFromPath(name) !== "csv") return undefined;
    const defaults = this.hooks.csvDefaults?.();
    return defaults ? { csv: defaults } : undefined;
  }

  /** Re-opens a CSV with other import options in the same tab (discards edits). */
  async reopenCsv(session: WorkbookSession, csv: Partial<CsvOptions>): Promise<boolean> {
    const source = session.source;
    try {
      let info: DocumentInfo;
      if (source.kind === "path") info = await this.engine.openDocument(source.path, { csv });
      else if (source.kind === "bytes") info = await this.engine.openBytes(source.name, source.bytes, { csv });
      else return false;
      const oldDoc = session.doc;
      session.replaceInfo(info);
      await this.engine.closeDocument(oldDoc).catch(() => undefined);
      return true;
    } catch (error) {
      this.hooks.onError(`No se pudo volver a abrir el CSV. ${errorMessage(error, "")}`.trim());
      return false;
    }
  }

  // ----- save ----------------------------------------------------------------

  /** Ctrl+S. Legacy formats and new workbooks go through "Guardar como". */
  async save(session: WorkbookSession): Promise<boolean> {
    const { path, sourceFormat } = session.info;
    const format = path ? getFormatFromPath(path) : null;
    if (!path || sourceFormat === "xls" || sourceFormat === "ods" || (format !== "xlsx" && format !== "csv")) {
      return this.saveAs(session);
    }
    return this.write(session, path, format);
  }

  async saveAs(session: WorkbookSession): Promise<boolean> {
    const current = sessionFileName(session.meta.get());
    const format = getFormatFromPath(current);
    const suggestedName = format === "xlsx" || format === "csv" ? current : withExtension(current, "xlsx");
    const suggested = session.info.path && session.info.path !== current ? session.info.path.replace(/[^\\/]+$/, suggestedName) : suggestedName;
    try {
      const target = this.files.native ? await this.files.pickSavePath(suggested, format === "csv" ? "csv" : "xlsx") : suggested;
      if (!target) return false;
      return await this.write(session, target, getFormatFromPath(target) === "csv" ? "csv" : "xlsx");
    } catch (error) {
      this.hooks.onError(errorMessage(error, "No se pudo guardar el libro."));
      return false;
    }
  }

  private async write(session: WorkbookSession, path: string, format: SaveFormat): Promise<boolean> {
    const name = getFileName(path);
    let result: SaveResult;
    try {
      result = await this.engine.saveDocument(session.doc, path, {
        format,
        sheet: format === "csv" ? session.activeSheet : undefined,
        csv: format === "csv" ? { delimiter: this.hooks.csvSaveDelimiter?.() ?? ";" } : undefined,
      });
    } catch (error) {
      this.hooks.onError(`No se pudo guardar «${name}». ${errorMessage(error, "")}`.trim());
      return false;
    }
    const sourceFormat = format === "csv" ? "csv" : "xlsx";
    session.patchInfo({ path: result.path, dirty: false, sourceFormat });
    session.source = { kind: "path", path: result.path };
    this.hooks.onPathUsed?.(result.path);
    const visibleSheets = session.info.sheets.filter((s) => !s.hidden).length;
    if (format === "csv" && visibleSheets > 1) {
      const sheetName = session.info.sheets.find((s) => s.id === session.activeSheet)?.name ?? "";
      this.hooks.onInfo(`CSV solo guarda una hoja: se ha guardado «${sheetName}».`);
    }
    if (result.lost.length > 0) {
      this.hooks.onInfo(`«${name}» se ha guardado, pero se han perdido: ${result.lost.map(featureName).join(", ")}.`);
    }
    return true;
  }

  // ----- close -----------------------------------------------------------------

  /** Close button / Ctrl+W: asks first when there are unsaved changes. */
  requestClose(id: string): void {
    const session = this.byId(id);
    if (!session) return;
    if (session.info.dirty) {
      this.activate(id);
      this.pending.set({ sessionId: id, closeWindow: false });
      return;
    }
    void this.close(id);
  }

  async close(id: string): Promise<void> {
    const { sessions, activeId } = this.state.get();
    const index = sessions.findIndex((s) => s.id === id);
    if (index === -1) return;
    const session = sessions[index];
    const remaining = sessions.filter((s) => s.id !== id);
    const nextActive = activeId === id ? remaining[Math.min(index, remaining.length - 1)]?.id ?? null : activeId;
    this.state.set({ sessions: remaining, activeId: nextActive });
    session.grid = null;
    await this.engine.closeDocument(session.doc).catch(() => undefined);
    await this.ensureOne();
  }

  /**
   * Window close (Tauri `onCloseRequested`). Returns true when the window may
   * close now; otherwise the unsaved-changes dialog was opened.
   */
  async requestCloseWindow(): Promise<boolean> {
    if (this.allowWindowClose) return true;
    const dirty = this.sessions.find((s) => s.info.dirty && !this.skippedOnClose.has(s.id));
    if (dirty) {
      this.activate(dirty.id);
      this.pending.set({ sessionId: dirty.id, closeWindow: true });
      return false;
    }
    this.allowWindowClose = true;
    await this.hooks.destroyWindow?.();
    return true;
  }

  /** Answer of the unsaved-changes dialog. */
  async confirmPending(choice: "save" | "discard" | "cancel"): Promise<void> {
    const pending = this.pending.get();
    this.pending.set(null);
    if (!pending || choice === "cancel") {
      this.skippedOnClose.clear();
      return;
    }
    const session = this.byId(pending.sessionId);
    if (session && choice === "save" && !(await this.save(session))) {
      this.skippedOnClose.clear();
      return;
    }
    if (pending.closeWindow) {
      this.skippedOnClose.add(pending.sessionId);
      await this.requestCloseWindow();
    } else {
      await this.close(pending.sessionId);
    }
  }

  // ----- sheets & mutations --------------------------------------------------------

  /** Switches the visible sheet (instant locally) and tells the engine. */
  async setActiveSheet(session: WorkbookSession, sheet: SheetId): Promise<void> {
    if (!session.showSheet(sheet)) return;
    session.pendingActiveSheet = sheet;
    try {
      await this.engine.apply(session.doc, [{ type: "setActiveSheet", sheet }]);
    } catch {
      // Not critical: the shell already shows the sheet.
    } finally {
      if (session.pendingActiveSheet === sheet) session.pendingActiveSheet = null;
    }
  }

  /** Every mutation goes through here: one call = one undo step. */
  async apply(session: WorkbookSession, ops: ReadonlyArray<EngineOp>): Promise<ApplyResult | null> {
    if (ops.length === 0) return null;
    try {
      const result = await this.engine.apply(session.doc, ops);
      await this.afterApply(session, result);
      return result;
    } catch (error) {
      this.hooks.onError(errorMessage(error));
      return null;
    }
  }

  async undo(session: WorkbookSession): Promise<ApplyResult | null> {
    return this.step(session, "undo");
  }

  async redo(session: WorkbookSession): Promise<ApplyResult | null> {
    return this.step(session, "redo");
  }

  private async step(session: WorkbookSession, direction: "undo" | "redo"): Promise<ApplyResult | null> {
    try {
      const result = direction === "undo" ? await this.engine.undo(session.doc) : await this.engine.redo(session.doc);
      await this.afterApply(session, result);
      return result;
    } catch (error) {
      this.hooks.onError(errorMessage(error));
      return null;
    }
  }

  private async afterApply(session: WorkbookSession, result: ApplyResult): Promise<void> {
    session.patchInfo({ dirty: result.dirty, canUndo: result.canUndo, canRedo: result.canRedo });
    const hint = result.selection;
    if (!hint) return;
    if (hint.sheet !== session.activeSheet) await this.setActiveSheet(session, hint.sheet);
    session.applyHint(hint);
  }
}
