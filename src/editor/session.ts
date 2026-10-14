import { EngineError, type CellDetails, type CellInput, type EngineOp, type SheetMeta, type WorkbookEngine } from "@/engine/contract";
import {
  MAX_COLS,
  MAX_ROWS,
  cellRange,
  normRange,
  rangeCellCount,
  type CellAddress,
  type CellRange,
  type Direction,
  type DocumentId,
  type SheetId,
} from "@/engine/types";
import type { EditRequest, GridHandle, RefHighlight, ReferencePicker } from "@/grid/api";
import type { SelectionKind, SelectionState, SelectionStore } from "@/model/selection";
import { DEFAULT_LOCALE, parseUserInput, toEditText, type Locale } from "@/lib/locale";
import { buildFunctionList, completionContext, filterFunctions, signatureContext, valueCompletion } from "@/editor/autocomplete";
import { CellDetailsCache } from "@/editor/details-cache";
import { genericFunctionInfo, getFunctionInfo, type FunctionInfo } from "@/editor/functions";
import { isMultiCellSelection, moveCell, nextInSelection } from "@/editor/moves";
import { colorRefs, refHighlights, type ColoredRef } from "@/editor/ref-colors";
import {
  autoCloseFormula,
  canInsertRefAt,
  cycleRefsInText,
  rangeToRefText,
  refToRange,
  shiftFormula,
  validateFormula,
} from "@/editor/references";
import { tokenize, type Token } from "@/editor/tokenizer";

/**
 * The edit session: one per open document, framework-agnostic. It owns the
 * text being edited and Excel's editing state machine; the in-cell editor
 * and the formula bar are two views of it (typing in either updates both).
 *
 * Modes (Excel's status bar "Introducir / Modificar / Señalar"):
 * - `enter`: started by typing over a cell. Arrow keys commit and move, or —
 *   in a formula, at a position where a reference may go — pick references.
 * - `edit`: started with F2, double click or by clicking into the formula
 *   bar. Arrow keys move the caret. F2 toggles enter/edit.
 * - `point`: a reference is being picked with the keyboard or the mouse; the
 *   picked reference is replaced as the pick moves. Typing returns to `enter`.
 *
 * Commit builds `EngineOp`s and calls `onCommit(ops, move)`. The session
 * already moved the selection (optimistic, so typing fast never stalls); if
 * `onCommit` rejects with an `EngineError` the editor reopens on the original
 * cell with the Spanish message, like Excel's formula error dialog.
 */

export type EditMode = "enter" | "edit" | "point";
export type EditSurface = "cell" | "bar";
/** Where the active cell goes after a commit. `none`: stays (✓ button, Ctrl+Enter, click elsewhere). */
export type CommitMove = Direction | "none";

export interface CompletionState {
  readonly items: ReadonlyArray<FunctionInfo>;
  readonly index: number;
  /** Text range replaced when accepting. */
  readonly start: number;
  readonly end: number;
}

export interface SignatureState {
  readonly fn: FunctionInfo;
  readonly argIndex: number;
}

export interface EditState {
  readonly status: "idle" | "editing";
  readonly sheet: SheetId;
  /** Cell being edited (null when idle). */
  readonly cell: CellAddress | null;
  /** Text typed by the user (without the value-autocomplete suggestion). */
  readonly text: string;
  /** Selection in the displayed value (`text + suggestion`). */
  readonly selStart: number;
  readonly selEnd: number;
  readonly mode: EditMode;
  /** Which view owns the caret/focus. */
  readonly surface: EditSurface;
  readonly isFormula: boolean;
  readonly tokens: ReadonlyArray<Token>;
  readonly refs: ReadonlyArray<ColoredRef>;
  readonly completion: CompletionState | null;
  readonly signature: SignatureState | null;
  /** Excel value AutoComplete: suffix shown selected after the typed text. */
  readonly suggestion: string;
  /** A reference can be picked at the caret (grid clicks/arrows insert refs). */
  readonly canPick: boolean;
  /** Spanish error message to show in a dialog (invalid formula…). */
  readonly error: string | null;
  /** Details of the edited cell (style/format for the in-cell editor). */
  readonly details: CellDetails | null;
  /** Waiting for the cell's current input (F2 before details arrived). */
  readonly loading: boolean;
  /** Incremented when the active view should take DOM focus. */
  readonly focusRequest: number;
}

export interface EditKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** IME composition in progress: never treat these keys as commands. */
  readonly isComposing?: boolean;
  /** 229 while an IME processes the key. */
  readonly keyCode?: number;
}

export interface EditSessionOptions {
  readonly engine: WorkbookEngine;
  readonly doc: DocumentId;
  readonly selection: SelectionStore;
  readonly getGrid: () => GridHandle | null;
  /**
   * Applies the ops as one undo step (normally `engine.apply(doc, ops)`).
   * The selection has already been moved by the session; do not apply
   * `ApplyResult.selection` for editor commits. Reject with `EngineError` to
   * reopen the editor with the error message.
   */
  readonly onCommit: (ops: EngineOp[], move: CommitMove) => Promise<unknown> | void;
  /** Sheets of the document (names for sheet-qualified refs and the name box). */
  readonly getSheets?: () => ReadonlyArray<SheetMeta>;
  /** The name box asked for a range on another sheet: switch to it and select the range. */
  readonly onNavigateSheet?: (sheet: SheetId, range: CellRange) => void;
  readonly locale?: Locale;
  /** Excel-style value AutoComplete from the same column (default off). */
  readonly valueAutoComplete?: boolean;
  /** Clock for dates typed without a year (tests). */
  readonly now?: () => Date;
}

/** Hard cap for Ctrl+Enter fills (each cell is one entry in the `setCells` op). */
export const MAX_FILL_CELLS = 200_000;

export const NAME_BOX_ERROR = "Referencia no válida.";
const GENERIC_COMMIT_ERROR = "No se pudo introducir el contenido de la celda.";

interface PickSlot {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly anchor: CellAddress;
  readonly active: CellAddress;
}

interface Snapshot {
  readonly text: string;
  readonly selStart: number;
  readonly selEnd: number;
}

type Listener = () => void;

const EMPTY_TOKENS: ReadonlyArray<Token> = [];
const EMPTY_REFS: ReadonlyArray<ColoredRef> = [];

export class EditSession {
  readonly cache: CellDetailsCache;
  readonly locale: Locale;
  private state: EditState;
  private readonly listeners = new Set<Listener>();
  private readonly opts: EditSessionOptions;
  private readonly unsubscribeSelection: () => void;
  private readonly unsubscribeEngine: () => void;

  private source: EditRequest["source"] | "bar" = "type";
  private originalText = "";
  private pick: PickSlot | null = null;
  private completionDismissedFor: string | null = null;
  private forcedCompletion = false;
  private suppressSuggestion = false;
  private tabChain: { startCol: number; expect: CellAddress } | null = null;
  private applyingSelection = false;
  private startToken = 0;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private functionList: FunctionInfo[] = buildFunctionList(null);
  private functionsLoaded = false;
  private readonly columnSamples = new Map<string, string[]>();
  private gridHighlightsKey = "";
  private pickerInstalled = false;
  private readonly picker: ReferencePicker = {
    onPick: (range, final) => this.pickRange(range, final),
  };

  constructor(options: EditSessionOptions) {
    this.opts = options;
    this.locale = options.locale ?? DEFAULT_LOCALE;
    this.cache = new CellDetailsCache(options.engine, options.doc);
    this.state = idleState(options.selection.get().sheet, 0);
    this.unsubscribeSelection = options.selection.subscribe((next) => this.onSelectionChange(next));
    this.unsubscribeEngine = options.engine.subscribe((event) => {
      if ("doc" in event && event.doc === options.doc && (event.type === "cells" || event.type === "sheetData")) {
        this.columnSamples.clear();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // store API (useSyncExternalStore)
  // ---------------------------------------------------------------------------

  getState = (): EditState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Selection store of the document (the formula bar and name box read the active cell). */
  get selection(): SelectionStore {
    return this.opts.selection;
  }

  /** Returns keyboard focus to the grid (name box Esc, ✕ button). */
  focusGrid(): void {
    this.opts.getGrid()?.focus();
  }

  isEditing(): boolean {
    return this.state.status === "editing";
  }

  dispose(): void {
    this.unsubscribeSelection();
    this.unsubscribeEngine();
    this.syncGrid(true);
    this.cache.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // starting
  // ---------------------------------------------------------------------------

  /** Starts editing from the grid (`GridProps.onEditRequest`). */
  start = (request: EditRequest): void => {
    if (this.state.status === "editing") {
      if (sameCell(this.state.cell, request.cell)) return;
      this.commit("none");
    }
    this.begin(request.cell, request.source, request.initialText);
  };

  /** Starts editing the active cell in the formula bar (click/focus while idle). */
  startInBar(): void {
    if (this.state.status === "editing") {
      this.setSurface("bar");
      return;
    }
    this.begin(this.opts.selection.get().active, "bar");
  }

  private begin(cell: CellAddress, source: EditRequest["source"] | "bar", initialText?: string): void {
    const sheet = this.opts.selection.get().sheet;
    const token = ++this.startToken;
    this.source = source;
    this.pick = null;
    this.completionDismissedFor = null;
    this.forcedCompletion = false;
    this.suppressSuggestion = false;
    this.undoStack = [];
    this.redoStack = [];
    if (this.tabChain && !sameCell(this.tabChain.expect, cell)) this.tabChain = null;

    const cached = this.cache.peek(sheet, cell) ?? null;
    const loadsInput = source === "f2" || source === "dblclick" || source === "bar";
    let text = "";
    if (source === "type") text = initialText ?? "";
    else if (loadsInput && cached) text = toEditText(cached, this.locale);
    this.originalText = loadsInput && cached ? text : "";
    const loading = loadsInput && !cached;

    this.setState(
      this.derive({
        ...idleState(sheet, this.state.focusRequest + 1),
        status: "editing",
        cell,
        text,
        selStart: text.length,
        selEnd: text.length,
        mode: source === "type" || source === "backspace" ? "enter" : "edit",
        surface: source === "bar" ? "bar" : "cell",
        details: cached,
        loading,
      }),
    );

    void this.cache.get(sheet, cell).then(
      (details) => {
        if (token !== this.startToken || this.state.status !== "editing") return;
        if (this.state.loading) {
          const loaded = toEditText(details, this.locale);
          this.originalText = loaded;
          const text = loaded + this.state.text;
          this.setState(this.derive({ ...this.state, details, loading: false, text, selStart: text.length, selEnd: text.length }));
        } else {
          this.setState({ ...this.state, details });
        }
      },
      () => {
        if (token === this.startToken && this.state.loading) this.setState({ ...this.state, loading: false });
      },
    );
    this.loadFunctions();
    if (this.opts.valueAutoComplete) this.loadColumnSamples(sheet, cell.col);
  }

  // ---------------------------------------------------------------------------
  // input from the views
  // ---------------------------------------------------------------------------

  /**
   * The displayed value changed (input event). `value` includes whatever the
   * browser produced (a typed char replaces a selected suggestion).
   */
  setText(value: string, selStart: number, selEnd: number, inputType?: string): void {
    if (this.state.status !== "editing") return;
    this.pushUndo();
    this.pick = null;
    this.forcedCompletion = false;
    const deleting = inputType !== undefined && inputType.startsWith("delete");
    this.suppressSuggestion = deleting;
    const mode = this.state.mode === "point" ? "enter" : this.state.mode;
    this.setState(this.derive({ ...this.state, text: value, selStart, selEnd, suggestion: "", mode, loading: this.state.loading }, true));
  }

  /** Caret/selection moved in the focused view. */
  setSelection(selStart: number, selEnd: number): void {
    const s = this.state;
    if (s.status !== "editing" || (s.selStart === selStart && s.selEnd === selEnd)) return;
    if (s.suggestion !== "") {
      // Moving the caret accepts the suggestion (Excel).
      const text = s.text + s.suggestion;
      this.setState(this.derive({ ...s, text, suggestion: "", selStart, selEnd }));
      return;
    }
    this.setState(this.derive({ ...s, selStart, selEnd }));
  }

  /** A view got focus by user action (click): Excel switches to Edit mode. */
  setSurface(surface: EditSurface): void {
    const s = this.state;
    if (s.status !== "editing") return;
    if (s.surface === surface && s.mode === "edit") return;
    this.pick = null;
    this.setState(this.derive({ ...s, surface, mode: "edit" }));
  }

  /**
   * Keyboard handling for both views. Returns true when the key was handled
   * (the view must `preventDefault()`); false lets the textarea do its thing.
   */
  handleKey(e: EditKeyEvent): boolean {
    const s = this.state;
    if (s.status !== "editing") return false;
    if (e.isComposing || e.keyCode === 229 || e.key === "Process" || e.key === "Dead") return false;
    const ctrl = e.ctrlKey || e.metaKey;

    if (s.error !== null) {
      if (e.key === "Enter" || e.key === "Escape") {
        this.dismissError();
        return true;
      }
      return false;
    }

    if (s.completion && !ctrl && !e.altKey) {
      const n = s.completion.items.length;
      switch (e.key) {
        case "ArrowDown":
          this.setCompletionIndex((s.completion.index + 1) % n);
          return true;
        case "ArrowUp":
          this.setCompletionIndex((s.completion.index - 1 + n) % n);
          return true;
        case "PageDown":
          this.setCompletionIndex(Math.min(n - 1, s.completion.index + 8));
          return true;
        case "PageUp":
          this.setCompletionIndex(Math.max(0, s.completion.index - 8));
          return true;
        case "Tab":
          this.acceptCompletion();
          return true;
        case "Enter":
          if (e.shiftKey) break;
          this.acceptCompletion();
          return true;
        case "Escape":
          this.completionDismissedFor = s.text;
          this.forcedCompletion = false;
          this.setState({ ...s, completion: null });
          return true;
        default:
          break;
      }
    }

    switch (e.key) {
      case "Enter":
        if (e.altKey && !ctrl) {
          this.insertText("\n");
          return true;
        }
        if (ctrl) {
          this.commit("none", "fill");
          return true;
        }
        this.commit(e.shiftKey ? "up" : "down", "enter");
        return true;
      case "Tab":
        if (ctrl || e.altKey) return false;
        this.commit(e.shiftKey ? "left" : "right", "tab");
        return true;
      case "Escape":
        this.cancel();
        return true;
      case "F2":
        if (s.surface === "bar") return true;
        this.pick = null;
        this.setState(this.derive({ ...s, mode: s.mode === "edit" ? "enter" : "edit" }));
        return true;
      case "F4": {
        if (!s.isFormula) return true;
        const r = cycleRefsInText(s.text, s.selStart, s.selEnd);
        if (r) {
          this.pushUndo();
          this.pick = null;
          this.setState(this.derive({ ...s, text: r.text, selStart: r.selStart, selEnd: r.selEnd }));
        }
        return true;
      }
      case "ArrowUp":
      case "ArrowDown":
      case "ArrowLeft":
      case "ArrowRight": {
        if (ctrl || e.altKey || s.mode === "edit") return false;
        const dir = arrowDirection(e.key);
        if (s.isFormula && s.canPick) {
          this.movePick(dir, e.shiftKey);
          return true;
        }
        if (s.mode === "point") {
          // caret no longer at a pickable spot: behave like enter mode
          this.commit(dir, "arrow");
          return true;
        }
        this.commit(dir, "arrow");
        return true;
      }
      case "z":
      case "Z":
        if (ctrl && !e.altKey) {
          if (e.shiftKey) this.redo();
          else this.undo();
          return true;
        }
        return false;
      case "y":
      case "Y":
        if (ctrl && !e.altKey) {
          this.redo();
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // completion & functions
  // ---------------------------------------------------------------------------

  setCompletionIndex(index: number): void {
    const c = this.state.completion;
    if (!c || index < 0 || index >= c.items.length) return;
    this.setState({ ...this.state, completion: { ...c, index } });
  }

  /** Inserts `NAME(` for the selected (or given) completion item. */
  acceptCompletion(index?: number): void {
    const s = this.state;
    const c = s.completion;
    if (!c) return;
    const item = c.items[index ?? c.index];
    if (!item) return;
    this.insertFunctionAt(item.name, c.start, c.end);
  }

  /**
   * fx button: start editing in the bar if needed, make sure the text is a
   * formula and show the whole function list.
   */
  openFunctionList(): void {
    if (this.state.status !== "editing") this.begin(this.opts.selection.get().active, "bar");
    const s = this.state;
    let text = s.text;
    let caret = s.selEnd;
    if (!text.startsWith("=")) {
      text = "=";
      caret = 1;
    }
    this.pushUndo();
    this.forcedCompletion = true;
    this.setState(this.derive({ ...s, text, selStart: caret, selEnd: caret, surface: "bar", mode: "edit", focusRequest: s.focusRequest + 1 }));
  }

  private insertFunctionAt(name: string, start: number, end: number): void {
    const s = this.state;
    this.pushUndo();
    const hasParen = s.text[end] === "(";
    const insert = hasParen ? name : `${name}(`;
    const text = s.text.slice(0, start) + insert + s.text.slice(end);
    const caret = start + insert.length + (hasParen ? 1 : 0);
    this.forcedCompletion = false;
    this.pick = null;
    this.setState(this.derive({ ...s, text, selStart: caret, selEnd: caret, mode: s.mode === "point" ? "enter" : s.mode, focusRequest: s.focusRequest + 1 }));
  }

  private loadFunctions(): void {
    if (this.functionsLoaded) return;
    this.functionsLoaded = true;
    this.opts.engine.listFunctions().then(
      (names) => {
        if (names.length > 0) this.functionList = buildFunctionList(names.map((n) => n.name));
      },
      () => {
        /* keep the catalog */
      },
    );
  }

  private loadColumnSamples(sheet: SheetId, col: number): void {
    const key = `${sheet}:${col}`;
    if (this.columnSamples.has(key)) return;
    this.columnSamples.set(key, []);
    this.opts.engine.getColumnTextSamples(this.opts.doc, sheet, col, 1000).then(
      (samples) => {
        const texts = samples.map((s) => s.text).filter((t) => t !== "" && parseUserInput(t, this.locale).kind === "text");
        this.columnSamples.set(key, texts);
      },
      () => {
        this.columnSamples.delete(key);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // reference picking
  // ---------------------------------------------------------------------------

  private pickSlotValid(s: EditState = this.state): boolean {
    const p = this.pick;
    return p !== null && s.selStart === s.selEnd && s.selEnd === p.end && s.text.slice(p.start, p.end) === p.text;
  }

  /** Grid click/drag while picking (`GridHandle.setReferencePicker`). */
  private pickRange(range: CellRange, final: boolean): void {
    const s = this.state;
    if (s.status !== "editing" || !s.isFormula) return;
    if (!this.pickSlotValid() && !s.canPick) return;
    this.placePick(range, { row: range.r0, col: range.c0 }, { row: range.r1, col: range.c1 }, final);
  }

  private movePick(dir: Direction, extend: boolean): void {
    const s = this.state;
    if (!s.cell) return;
    let anchor: CellAddress;
    let active: CellAddress;
    if (this.pickSlotValid() && this.pick) {
      active = moveCell(this.pick.active, dir);
      anchor = extend ? this.pick.anchor : active;
    } else {
      active = moveCell(s.cell, dir);
      anchor = active;
    }
    this.placePick(normRange(anchor, active), anchor, active, false);
    this.opts.getGrid()?.scrollIntoView(active);
  }

  private placePick(range: CellRange, anchor: CellAddress, active: CellAddress, final: boolean): void {
    const s = this.state;
    const refText = rangeToRefText(range);
    let start: number;
    let end: number;
    if (this.pickSlotValid() && this.pick) {
      start = this.pick.start;
      end = this.pick.end;
    } else {
      this.pushUndo();
      start = Math.min(s.selStart, s.selEnd);
      end = Math.max(s.selStart, s.selEnd);
    }
    const text = s.text.slice(0, start) + refText + s.text.slice(end);
    const caret = start + refText.length;
    this.pick = { start, end: caret, text: refText, anchor, active };
    this.setState(
      this.derive({
        ...s,
        text,
        selStart: caret,
        selEnd: caret,
        mode: s.mode === "edit" ? "edit" : "point",
        focusRequest: final ? s.focusRequest + 1 : s.focusRequest,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // commit / cancel
  // ---------------------------------------------------------------------------

  /**
   * Commits the edit. `trigger` refines Excel's movement rules: Enter/Tab walk
   * a multi-cell selection and Enter after a Tab sequence returns to the
   * starting column; `fill` (Ctrl+Enter) writes every selected cell.
   */
  commit(move: CommitMove, trigger: "enter" | "tab" | "arrow" | "fill" | "button" | "click" = "button"): boolean {
    const s = this.state;
    if (s.status !== "editing" || !s.cell) return false;
    const cell = s.cell;
    const sheet = s.sheet;
    const typed = s.text + s.suggestion;
    const finalText = typed.startsWith("=") ? autoCloseFormula(typed) : typed;
    const parsed = parseUserInput(finalText, this.locale, {
      today: this.opts.now?.() ?? new Date(),
      cellNumFmt: s.details?.format.numFmt,
    });
    if (parsed.kind === "formula") {
      const error = validateFormula(parsed.input);
      if (error) {
        const caret = finalText.length;
        this.setState(this.derive({ ...s, text: finalText, suggestion: "", selStart: caret, selEnd: caret, error }));
        return false;
      }
    }

    const selection = this.opts.selection.get();
    const fill = trigger === "fill" && isMultiCellSelection(selection);
    const unchanged = !fill && this.source !== "type" && this.source !== "backspace" && !s.loading && typed === this.originalText;
    const ops = unchanged ? [] : this.buildOps(sheet, cell, parsed.input, parsed.numFmt, parsed.kind === "formula", fill ? selection.ranges : null, finalText.includes("\n") && parsed.kind !== "formula");

    // Close the editor and move first (optimistic): fast typing never waits for the engine.
    const snapshot = { ...s, text: finalText, suggestion: "" };
    this.close();
    this.applyMove(sheet, cell, move, trigger);

    if (ops.length > 0) {
      let result: Promise<unknown> | void;
      try {
        result = this.opts.onCommit(ops, move);
      } catch (error) {
        this.reopenWithError(snapshot, error);
        return false;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") {
        (result as Promise<unknown>).catch((error: unknown) => this.reopenWithError(snapshot, error));
      }
    }
    return true;
  }

  /** Esc / ✕: discard the edit. */
  cancel(): void {
    if (this.state.status !== "editing") return;
    this.close();
    this.opts.getGrid()?.focus();
  }

  dismissError(): void {
    if (this.state.error === null) return;
    this.setState({ ...this.state, error: null, focusRequest: this.state.focusRequest + 1 });
  }

  private buildOps(
    sheet: SheetId,
    cell: CellAddress,
    input: string,
    numFmt: string | undefined,
    isFormula: boolean,
    fillRanges: ReadonlyArray<CellRange> | null,
    wrap: boolean,
  ): EngineOp[] {
    const make = (row: number, col: number, text: string): CellInput => (numFmt !== undefined ? { row, col, input: text, numFmt } : { row, col, input: text });
    const cells: CellInput[] = [];
    if (fillRanges) {
      outer: for (const r of fillRanges) {
        for (let row = r.r0; row <= r.r1; row += 1) {
          for (let col = r.c0; col <= r.c1; col += 1) {
            if (cells.length >= MAX_FILL_CELLS) break outer;
            cells.push(make(row, col, isFormula ? shiftFormula(input, row - cell.row, col - cell.col) : input));
          }
        }
      }
    } else {
      cells.push(make(cell.row, cell.col, input));
    }
    const ops: EngineOp[] = [{ type: "setCells", sheet, cells }];
    if (wrap) ops.push({ type: "setStyle", sheet, ranges: fillRanges ?? [cellRange(cell)], patch: { wrap: true } });
    return ops;
  }

  private applyMove(sheet: SheetId, cell: CellAddress, move: CommitMove, trigger: string): void {
    const grid = this.opts.getGrid();
    const selection = this.opts.selection.get();
    if (move === "none") {
      if (trigger !== "click") grid?.focus();
      return;
    }
    let next: SelectionState;
    if ((trigger === "enter" || trigger === "tab") && selection.sheet === sheet && isMultiCellSelection(selection) && sameCell(selection.active, cell)) {
      next = nextInSelection(selection, move);
      this.tabChain = null;
    } else {
      let target = moveCell(cell, move);
      if (trigger === "tab") {
        const startCol = this.tabChain && sameCell(this.tabChain.expect, cell) ? this.tabChain.startCol : cell.col;
        this.tabChain = { startCol, expect: target };
      } else if (trigger === "enter" && this.tabChain && sameCell(this.tabChain.expect, cell)) {
        target = { row: target.row, col: this.tabChain.startCol };
        this.tabChain = null;
      } else {
        this.tabChain = null;
      }
      next = {
        sheet,
        ranges: [cellRange(target)],
        activeRange: 0,
        active: target,
        anchor: target,
        kind: "cells",
      };
    }
    this.setSelectionInternal(next);
    grid?.scrollIntoView(next.active);
    grid?.focus();
  }

  private reopenWithError(snapshot: EditState, error: unknown): void {
    const message =
      error instanceof EngineError ? error.message : error instanceof Error && error.message ? error.message : GENERIC_COMMIT_ERROR;
    if (!(error instanceof EngineError)) console.error("Editor commit failed", error);
    if (!snapshot.cell) return;
    if (this.state.status === "editing") this.close();
    const sel = this.opts.selection.get();
    if (sel.sheet === snapshot.sheet && !sameCell(sel.active, snapshot.cell)) {
      this.setSelectionInternal({
        sheet: snapshot.sheet,
        ranges: [cellRange(snapshot.cell)],
        activeRange: 0,
        active: snapshot.cell,
        anchor: snapshot.cell,
        kind: "cells",
      });
      this.opts.getGrid()?.scrollIntoView(snapshot.cell);
    }
    this.startToken += 1;
    this.source = "f2";
    this.originalText = "";
    const caret = snapshot.text.length;
    this.setState(
      this.derive({
        ...snapshot,
        status: "editing",
        mode: "edit",
        selStart: caret,
        selEnd: caret,
        error: message || GENERIC_COMMIT_ERROR,
        focusRequest: this.state.focusRequest + 1,
      }),
    );
  }

  private close(): void {
    this.pick = null;
    this.startToken += 1;
    this.setState(idleState(this.state.sheet, this.state.focusRequest));
  }

  // ---------------------------------------------------------------------------
  // name box
  // ---------------------------------------------------------------------------

  /**
   * Name box: `B7`, `A1:C10`, `A:C`, `3:5`, `Hoja2!A1`, `'Mi hoja'!B2:C3`.
   * Selects the range (or asks the shell to switch sheet). Returns an error
   * message, or null on success.
   */
  navigateTo(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed === "") return NAME_BOX_ERROR;
    const tokens = tokenize(`=${trimmed}`);
    if (tokens.length !== 2 || tokens[1].type !== "ref" || !tokens[1].ref || tokens[1].ref.spill) return NAME_BOX_ERROR;
    const ref = tokens[1].ref;
    const range = refToRange(ref);
    const current = this.opts.selection.get();
    if (ref.sheet !== null) {
      const target = this.opts.getSheets?.().find((sh) => sh.name.toLowerCase() === ref.sheet?.toLowerCase());
      if (!target) return NAME_BOX_ERROR;
      if (target.id !== current.sheet) {
        if (this.state.status === "editing") this.commit("none");
        this.opts.onNavigateSheet?.(target.id, range);
        return null;
      }
    }
    if (this.state.status === "editing") this.commit("none");
    const active = { row: range.r0, col: range.c0 };
    const wholeCols = range.r0 === 0 && range.r1 === MAX_ROWS - 1;
    const wholeRows = range.c0 === 0 && range.c1 === MAX_COLS - 1;
    const kind: SelectionKind = wholeCols && wholeRows ? "all" : wholeCols ? "cols" : wholeRows ? "rows" : "cells";
    this.setSelectionInternal({ sheet: current.sheet, ranges: [range], activeRange: 0, active, anchor: active, kind });
    const grid = this.opts.getGrid();
    grid?.scrollIntoView(active);
    grid?.focus();
    return null;
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  private onSelectionChange(next: SelectionState): void {
    if (this.applyingSelection) return;
    const s = this.state;
    if (s.status !== "editing" || !s.cell) {
      if (s.status === "idle" && next.sheet !== s.sheet) this.setState({ ...s, sheet: next.sheet });
      return;
    }
    if (next.sheet !== s.sheet || !sameCell(next.active, s.cell)) {
      // Clicked another cell (no reference picking): Excel commits the edit.
      this.commit("none", "click");
    }
  }

  private setSelectionInternal(next: SelectionState): void {
    this.applyingSelection = true;
    try {
      this.opts.selection.set(next);
    } finally {
      this.applyingSelection = false;
    }
  }

  private insertText(insert: string): void {
    const s = this.state;
    this.pushUndo();
    const start = Math.min(s.selStart, s.selEnd);
    const end = Math.max(s.selStart, s.selEnd);
    const base = s.text + s.suggestion;
    const text = base.slice(0, start) + insert + base.slice(end);
    const caret = start + insert.length;
    this.pick = null;
    this.suppressSuggestion = true;
    this.setState(this.derive({ ...s, text, suggestion: "", selStart: caret, selEnd: caret, mode: s.mode === "point" ? "enter" : s.mode }));
  }

  private pushUndo(): void {
    const s = this.state;
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.text === s.text) return;
    this.undoStack.push({ text: s.text, selStart: Math.min(s.selStart, s.text.length), selEnd: Math.min(s.selEnd, s.text.length) });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const s = this.state;
    this.redoStack.push({ text: s.text, selStart: s.selStart, selEnd: s.selEnd });
    this.pick = null;
    this.suppressSuggestion = true;
    this.setState(this.derive({ ...s, ...prev, suggestion: "" }));
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    const s = this.state;
    this.undoStack.push({ text: s.text, selStart: s.selStart, selEnd: s.selEnd });
    this.pick = null;
    this.suppressSuggestion = true;
    this.setState(this.derive({ ...s, ...next, suggestion: "" }));
  }

  /** Recomputes everything that depends on text/caret. */
  private derive(s: EditState, typed = false): EditState {
    if (s.status !== "editing") return s;
    const isFormula = s.text.startsWith("=");
    const tokens = isFormula ? tokenize(s.text) : EMPTY_TOKENS;
    const refs = isFormula ? colorRefs(tokens) : EMPTY_REFS;
    const collapsed = s.selStart === s.selEnd;
    const caret = s.selEnd;

    let completion: CompletionState | null = null;
    let signature: SignatureState | null = null;
    let canPick = false;
    if (isFormula && caret <= s.text.length) {
      if (collapsed) {
        canPick = this.pickSlotValid(s) || canInsertRefAt(s.text, caret, tokens);
        if (this.completionDismissedFor !== s.text) {
          const ctx = completionContext(s.text, caret, tokens);
          if (ctx) {
            const items = filterFunctions(ctx.prefix, this.functionList);
            if (items.length > 0) completion = { items, index: 0, start: ctx.start, end: ctx.end };
          } else if (this.forcedCompletion) {
            completion = { items: this.functionList, index: 0, start: caret, end: caret };
          }
        }
      }
      const sig = signatureContext(tokens, caret);
      if (sig) {
        const fn = getFunctionInfo(sig.name) ?? genericFunctionInfo(sig.name);
        signature = { fn, argIndex: sig.argIndex };
      }
    }
    if (completion && s.completion && sameItems(completion.items, s.completion.items)) {
      completion = { ...completion, index: s.completion.index };
    }

    let suggestion = s.suggestion;
    let selStart = s.selStart;
    let selEnd = s.selEnd;
    if (typed) {
      suggestion = "";
      if (
        this.opts.valueAutoComplete &&
        !isFormula &&
        !this.suppressSuggestion &&
        collapsed &&
        caret === s.text.length &&
        s.cell
      ) {
        const samples = this.columnSamples.get(`${s.sheet}:${s.cell.col}`);
        const completionText = samples ? valueCompletion(s.text, samples) : null;
        if (completionText) {
          suggestion = completionText;
          selStart = s.text.length;
          selEnd = s.text.length + completionText.length;
        }
      }
    }
    if (this.completionDismissedFor !== null && this.completionDismissedFor !== s.text) this.completionDismissedFor = null;
    return { ...s, isFormula, tokens, refs, completion, signature, canPick, suggestion, selStart, selEnd };
  }

  private setState(next: EditState): void {
    if (next === this.state) return;
    this.state = next;
    this.syncGrid(false);
    for (const listener of this.listeners) listener();
  }

  /** Pushes ref highlights and the reference picker to the grid. */
  private syncGrid(clear: boolean): void {
    const grid = this.opts.getGrid();
    if (!grid) return;
    const s = this.state;
    const editingFormula = !clear && s.status === "editing" && s.isFormula;
    const sheetName = this.opts.getSheets?.().find((sh) => sh.id === s.sheet)?.name ?? null;
    const highlights: RefHighlight[] = editingFormula ? refHighlights(s.refs, sheetName) : [];
    const key = highlights.map((h) => `${h.color}:${h.range.r0},${h.range.c0},${h.range.r1},${h.range.c1}`).join("|");
    if (key !== this.gridHighlightsKey) {
      this.gridHighlightsKey = key;
      grid.setRefHighlights(highlights);
    }
    const wantPicker = editingFormula && s.canPick && s.error === null;
    if (wantPicker !== this.pickerInstalled) {
      this.pickerInstalled = wantPicker;
      grid.setReferencePicker(wantPicker ? this.picker : null);
    }
  }
}

export function createEditSession(options: EditSessionOptions): EditSession {
  return new EditSession(options);
}

function idleState(sheet: SheetId, focusRequest: number): EditState {
  return {
    status: "idle",
    sheet,
    cell: null,
    text: "",
    selStart: 0,
    selEnd: 0,
    mode: "enter",
    surface: "cell",
    isFormula: false,
    tokens: EMPTY_TOKENS,
    refs: EMPTY_REFS,
    completion: null,
    signature: null,
    suggestion: "",
    canPick: false,
    error: null,
    details: null,
    loading: false,
    focusRequest,
  };
}

function sameCell(a: CellAddress | null | undefined, b: CellAddress | null | undefined): boolean {
  return !!a && !!b && a.row === b.row && a.col === b.col;
}

function sameItems(a: ReadonlyArray<FunctionInfo>, b: ReadonlyArray<FunctionInfo>): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return false;
  return true;
}

function arrowDirection(key: string): Direction {
  switch (key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    default:
      return "right";
  }
}

/** Number of cells a Ctrl+Enter fill would write (for UI hints). */
export function fillCellCount(ranges: ReadonlyArray<CellRange>): number {
  return ranges.reduce((n, r) => n + rangeCellCount(r), 0);
}
