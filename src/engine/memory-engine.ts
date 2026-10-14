import {
  BLOCK_COLS,
  BLOCK_ROWS,
  CellFlag,
  CellKind,
  EngineError,
  type ApplyResult,
  type BlockRequest,
  type CellBlock,
  type CellDetails,
  type CellStyle,
  type CellValue,
  type ChartSpec,
  type ClipboardData,
  type DocumentInfo,
  type EngineEvent,
  type EngineEventListener,
  type EngineOp,
  type FilterValue,
  type FindMatch,
  type FindQuery,
  type FunctionName,
  type RangeValues,
  type SaveOptions,
  type SaveResult,
  type SelectionStats,
  type SheetInfo,
  type SheetMeta,
  type StylePatch,
  type TextSample,
  type WorkbookEngine,
} from "@/engine/contract";
import { buildBlock } from "@/engine/block-codec";
import {
  MAX_COLS,
  MAX_ROWS,
  rangeContains,
  type CellAddress,
  type CellRange,
  type Direction,
  type DocumentId,
  type SheetId,
  type StyleId,
} from "@/engine/types";

/**
 * In-memory fake of `WorkbookEngine` for unit tests and for developing the UI
 * in a plain browser (`npm run dev`) without the native engine.
 *
 * Deliberately simple: formulas are NOT evaluated (the display shows the
 * formula text), numbers are displayed with a Spanish-style decimal comma,
 * undo/redo snapshots the whole document. Unsupported ops throw
 * `EngineError("unsupported")`. Do not use it for performance work.
 */

interface MemCell {
  input: string;
  styleId: StyleId;
}

interface MemSheet {
  meta: SheetMeta;
  cells: Map<string, MemCell>;
  rowSizes: Map<number, number>;
  colSizes: Map<number, number>;
  hiddenRows: Set<number>;
  hiddenCols: Set<number>;
  merges: CellRange[];
  frozenRows: number;
  frozenCols: number;
  showGridLines: boolean;
  version: number;
}

interface MemDoc {
  id: DocumentId;
  path: string | null;
  sheets: MemSheet[];
  activeSheet: SheetId;
  nextSheetId: number;
  dirty: boolean;
  undo: string[];
  redo: string[];
}

const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_COL_WIDTH = 64;

const key = (row: number, col: number) => `${row}:${col}`;

function parseKey(k: string): CellAddress {
  const [row, col] = k.split(":").map(Number);
  return { row, col };
}

function valueOf(input: string): CellValue {
  if (input === "") return { type: "empty" };
  if (input.startsWith("'")) return { type: "text", value: input.slice(1) };
  if (input.startsWith("=")) return { type: "text", value: input };
  if (/^(TRUE|FALSE)$/i.test(input)) return { type: "bool", value: input.toUpperCase() === "TRUE" };
  if (/^#[A-Z/0!?]+[!?A]?$/.test(input)) return { type: "error", value: input };
  const n = Number(input);
  if (input.trim() !== "" && Number.isFinite(n)) return { type: "number", value: n };
  return { type: "text", value: input };
}

function displayOf(value: CellValue): string {
  switch (value.type) {
    case "empty":
      return "";
    case "number":
      return String(value.value).replace(".", ",");
    case "bool":
      return value.value ? "VERDADERO" : "FALSO";
    default:
      return value.value;
  }
}

function kindOf(value: CellValue): number {
  switch (value.type) {
    case "empty":
      return CellKind.Empty;
    case "number":
      return CellKind.Number;
    case "bool":
      return CellKind.Bool;
    case "error":
      return CellKind.Error;
    default:
      return CellKind.Text;
  }
}

export class MemoryEngine implements WorkbookEngine {
  private readonly docs = new Map<DocumentId, MemDoc>();
  private readonly listeners = new Set<EngineEventListener>();
  private readonly styles: CellStyle[] = [{}];
  private readonly styleKeys = new Map<string, StyleId>([["{}", 0]]);
  private readonly numFmts: string[] = ["General"];
  private nextDoc = 1;

  // ----- documents -------------------------------------------------------

  async newDocument(): Promise<DocumentInfo> {
    const doc: MemDoc = {
      id: this.nextDoc++,
      path: null,
      sheets: [],
      activeSheet: 1,
      nextSheetId: 1,
      dirty: false,
      undo: [],
      redo: [],
    };
    this.addSheet(doc, "Hoja1");
    this.docs.set(doc.id, doc);
    return this.info(doc);
  }

  async openDocument(path: string): Promise<DocumentInfo> {
    throw new EngineError("unsupported", `El motor de pruebas no puede abrir «${path}».`);
  }

  async openBytes(fileName: string, bytes: Uint8Array): Promise<DocumentInfo> {
    if (!fileName.toLowerCase().endsWith(".csv")) {
      throw new EngineError("unsupported", "El motor de pruebas solo abre CSV.");
    }
    const info = await this.newDocument();
    const doc = this.doc(info.doc);
    const sheet = doc.sheets[0];
    const text = new TextDecoder().decode(bytes);
    const delimiter = text.includes(";") && !text.includes(",") ? ";" : ",";
    text.split(/\r?\n/).forEach((line, row) => {
      if (line === "") return;
      line.split(delimiter).forEach((input, col) => {
        if (input !== "") sheet.cells.set(key(row, col), { input, styleId: 0 });
      });
    });
    doc.path = fileName;
    return { ...this.info(doc), sourceFormat: "csv", backend: "csv" };
  }

  async getDocumentInfo(id: DocumentId): Promise<DocumentInfo> {
    return this.info(this.doc(id));
  }

  async saveDocument(id: DocumentId, path: string, options: SaveOptions): Promise<SaveResult> {
    const doc = this.doc(id);
    doc.path = path;
    doc.dirty = false;
    this.emitDocState(doc);
    return { path, format: options.format, lost: [] };
  }

  async closeDocument(id: DocumentId): Promise<void> {
    this.docs.delete(id);
  }

  // ----- grid data -------------------------------------------------------

  async getSheetInfo(id: DocumentId, sheetId: SheetId): Promise<SheetInfo> {
    const sheet = this.sheet(this.doc(id), sheetId);
    let usedRange: CellRange | null = null;
    for (const k of sheet.cells.keys()) {
      const { row, col } = parseKey(k);
      usedRange = usedRange
        ? { r0: Math.min(usedRange.r0, row), c0: Math.min(usedRange.c0, col), r1: Math.max(usedRange.r1, row), c1: Math.max(usedRange.c1, col) }
        : { r0: row, c0: col, r1: row, c1: col };
    }
    const overrides = (sizes: Map<number, number>, hidden: Set<number>) => {
      const indices = new Set([...sizes.keys(), ...hidden]);
      return [...indices].sort((a, b) => a - b).map((index) => ({
        index,
        size: sizes.get(index),
        hidden: hidden.has(index) || undefined,
      }));
    };
    return {
      sheet: sheetId,
      rowCount: MAX_ROWS,
      colCount: MAX_COLS,
      defaultRowHeight: DEFAULT_ROW_HEIGHT,
      defaultColWidth: DEFAULT_COL_WIDTH,
      usedRange,
      rowOverrides: overrides(sheet.rowSizes, sheet.hiddenRows),
      colOverrides: overrides(sheet.colSizes, sheet.hiddenCols),
      merges: sheet.merges,
      frozenRows: sheet.frozenRows,
      frozenCols: sheet.frozenCols,
      showGridLines: sheet.showGridLines,
      autoFilter: null,
      version: sheet.version,
    };
  }

  async fetchBlocks(id: DocumentId, req: BlockRequest): Promise<CellBlock[]> {
    const sheet = this.sheet(this.doc(id), req.sheet);
    return req.keys.map(({ br, bc }) => {
      const cells = [];
      for (let r = 0; r < BLOCK_ROWS; r += 1) {
        for (let c = 0; c < BLOCK_COLS; c += 1) {
          const cell = sheet.cells.get(key(br * BLOCK_ROWS + r, bc * BLOCK_COLS + c));
          if (!cell) {
            cells.push(null);
            continue;
          }
          const value = valueOf(cell.input);
          cells.push({
            text: displayOf(value),
            kind: kindOf(value),
            styleId: cell.styleId,
            flags: cell.input.startsWith("=") ? CellFlag.Formula : 0,
          });
        }
      }
      return buildBlock(req.sheet, br, bc, sheet.version, cells);
    });
  }

  async getStyles(_doc: DocumentId, ids: ReadonlyArray<StyleId>): Promise<ReadonlyArray<readonly [StyleId, CellStyle]>> {
    return ids.map((id) => [id, this.styles[id] ?? {}] as const);
  }

  async findDataEdge(id: DocumentId, sheetId: SheetId, from: CellAddress, dir: Direction): Promise<CellAddress> {
    const sheet = this.sheet(this.doc(id), sheetId);
    const filled = (row: number, col: number) => sheet.cells.has(key(row, col));
    const [dr, dc] = dir === "up" ? [-1, 0] : dir === "down" ? [1, 0] : dir === "left" ? [0, -1] : [0, 1];
    const inside = (row: number, col: number) => row >= 0 && col >= 0 && row < MAX_ROWS && col < MAX_COLS;
    let row = from.row;
    let col = from.col;
    if (!inside(row + dr, col + dc)) return from;
    const startFilled = filled(row, col) && filled(row + dr, col + dc);
    // Bounded scan: the fake is for small sheets.
    for (let steps = 0; steps < 100_000 && inside(row + dr, col + dc); steps += 1) {
      const next = filled(row + dr, col + dc);
      if (startFilled ? !next : next) {
        if (!startFilled) {
          row += dr;
          col += dc;
        }
        return { row, col };
      }
      row += dr;
      col += dc;
    }
    return { row: dr === 0 ? row : dr > 0 ? MAX_ROWS - 1 : 0, col: dc === 0 ? col : dc > 0 ? MAX_COLS - 1 : 0 };
  }

  async getColumnTextSamples(id: DocumentId, sheetId: SheetId, col: number, limit: number): Promise<TextSample[]> {
    const sheet = this.sheet(this.doc(id), sheetId);
    const samples: TextSample[] = [];
    for (const [k, cell] of sheet.cells) {
      if (parseKey(k).col === col) samples.push({ text: displayOf(valueOf(cell.input)), styleId: cell.styleId });
    }
    return samples.sort((a, b) => b.text.length - a.text.length).slice(0, limit);
  }

  // ----- cell queries ----------------------------------------------------

  async getCell(id: DocumentId, sheetId: SheetId, cell: CellAddress): Promise<CellDetails> {
    const sheet = this.sheet(this.doc(id), sheetId);
    const mem = sheet.cells.get(key(cell.row, cell.col));
    const value = valueOf(mem?.input ?? "");
    const styleId = mem?.styleId ?? 0;
    return {
      sheet: sheetId,
      row: cell.row,
      col: cell.col,
      input: mem?.input ?? "",
      value,
      display: displayOf(value),
      format: { style: this.styles[styleId] ?? {}, numFmt: this.numFmts[styleId] ?? "General" },
      merge: sheet.merges.find((m) => rangeContains(m, cell.row, cell.col)) ?? null,
      spillAnchor: null,
      comment: null,
      hyperlink: null,
    };
  }

  async getRangeValues(id: DocumentId, sheetId: SheetId, range: CellRange): Promise<RangeValues> {
    const sheet = this.sheet(this.doc(id), sheetId);
    const values: CellValue[][] = [];
    const display: string[][] = [];
    for (let row = range.r0; row <= range.r1; row += 1) {
      const vRow: CellValue[] = [];
      const dRow: string[] = [];
      for (let col = range.c0; col <= range.c1; col += 1) {
        const value = valueOf(sheet.cells.get(key(row, col))?.input ?? "");
        vRow.push(value);
        dRow.push(displayOf(value));
      }
      values.push(vRow);
      display.push(dRow);
    }
    return { range, values, display };
  }

  async getSelectionStats(id: DocumentId, sheetId: SheetId, ranges: ReadonlyArray<CellRange>): Promise<SelectionStats> {
    const sheet = this.sheet(this.doc(id), sheetId);
    let count = 0;
    let numericCount = 0;
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    for (const [k, cell] of sheet.cells) {
      const { row, col } = parseKey(k);
      if (!ranges.some((r) => rangeContains(r, row, col))) continue;
      const value = valueOf(cell.input);
      if (value.type === "empty") continue;
      count += 1;
      if (value.type === "number") {
        numericCount += 1;
        sum += value.value;
        min = min === null ? value.value : Math.min(min, value.value);
        max = max === null ? value.value : Math.max(max, value.value);
      }
    }
    return { count, numericCount, sum, average: numericCount ? sum / numericCount : null, min, max };
  }

  async find(id: DocumentId, query: FindQuery): Promise<FindMatch[]> {
    const doc = this.doc(id);
    const needle = query.matchCase ? query.text : query.text.toLowerCase();
    const matches: FindMatch[] = [];
    for (const sheet of doc.sheets) {
      if (query.sheet !== null && sheet.meta.id !== query.sheet) continue;
      for (const [k, cell] of sheet.cells) {
        const { row, col } = parseKey(k);
        if (query.within && !query.within.some((r) => rangeContains(r, row, col))) continue;
        const display = displayOf(valueOf(cell.input));
        const hay0 = query.lookIn === "formulas" ? cell.input : display;
        const hay = query.matchCase ? hay0 : hay0.toLowerCase();
        if (query.wholeCell ? hay === needle : hay.includes(needle)) {
          matches.push({ sheet: sheet.meta.id, row, col, display });
          if (matches.length >= query.limit) return matches;
        }
      }
    }
    return matches;
  }

  async getFilterValues(): Promise<FilterValue[]> {
    return [];
  }

  async getCharts(): Promise<ChartSpec[]> {
    return [];
  }

  // ----- mutations -------------------------------------------------------

  async apply(id: DocumentId, ops: ReadonlyArray<EngineOp>): Promise<ApplyResult> {
    const started = performance.now();
    const doc = this.doc(id);
    const snapshot = this.serialize(doc);
    const created: number[] = [];
    let affected = 0;
    const touched = new Set<SheetId>();
    let sheetsChanged = false;
    try {
      for (const op of ops) {
        if ("sheet" in op && typeof op.sheet === "number") touched.add(op.sheet);
        switch (op.type) {
          case "setCells": {
            const sheet = this.sheet(doc, op.sheet);
            for (const cell of op.cells) {
              const existing = sheet.cells.get(key(cell.row, cell.col));
              if (cell.input === "" && !existing?.styleId) sheet.cells.delete(key(cell.row, cell.col));
              else sheet.cells.set(key(cell.row, cell.col), { input: cell.input, styleId: existing?.styleId ?? 0 });
              affected += 1;
            }
            break;
          }
          case "clear": {
            const sheet = this.sheet(doc, op.sheet);
            for (const [k, cell] of [...sheet.cells]) {
              const { row, col } = parseKey(k);
              if (!op.ranges.some((r) => rangeContains(r, row, col))) continue;
              if (op.what === "all" || (op.what === "contents" && !cell.styleId)) sheet.cells.delete(k);
              else if (op.what === "contents") cell.input = "";
              else if (op.what === "formats") cell.styleId = 0;
              affected += 1;
            }
            break;
          }
          case "setStyle": {
            const sheet = this.sheet(doc, op.sheet);
            for (const range of op.ranges) {
              for (let row = range.r0; row <= Math.min(range.r1, range.r0 + 10_000); row += 1) {
                for (let col = range.c0; col <= Math.min(range.c1, range.c0 + 1_000); col += 1) {
                  const cell = sheet.cells.get(key(row, col)) ?? { input: "", styleId: 0 };
                  cell.styleId = this.patchStyle(cell.styleId, op.patch);
                  sheet.cells.set(key(row, col), cell);
                }
              }
            }
            break;
          }
          case "setRowHeights":
          case "setColWidths": {
            const sheet = this.sheet(doc, op.sheet);
            const sizes = op.type === "setRowHeights" ? sheet.rowSizes : sheet.colSizes;
            const indices = op.type === "setRowHeights" ? op.rows : op.cols;
            for (const index of indices) {
              if (op.size === null) sizes.delete(index);
              else sizes.set(index, op.size);
            }
            sheet.version += 1;
            break;
          }
          case "setHidden": {
            const sheet = this.sheet(doc, op.sheet);
            const set = op.axis === "row" ? sheet.hiddenRows : sheet.hiddenCols;
            for (const index of op.indices) {
              if (op.hidden) set.add(index);
              else set.delete(index);
            }
            sheet.version += 1;
            break;
          }
          case "setFrozen": {
            const sheet = this.sheet(doc, op.sheet);
            sheet.frozenRows = op.rows;
            sheet.frozenCols = op.cols;
            sheet.version += 1;
            break;
          }
          case "setShowGridLines": {
            const sheet = this.sheet(doc, op.sheet);
            sheet.showGridLines = op.show;
            sheet.version += 1;
            break;
          }
          case "merge":
          case "unmerge": {
            const sheet = this.sheet(doc, op.sheet);
            const ranges = op.type === "merge" ? [op.range] : op.ranges;
            sheet.merges = sheet.merges.filter((m) => !ranges.some((r) => m.r0 === r.r0 && m.c0 === r.c0 && m.r1 === r.r1 && m.c1 === r.c1));
            if (op.type === "merge") sheet.merges.push(op.range);
            sheet.version += 1;
            break;
          }
          case "insertRows":
          case "deleteRows":
          case "insertCols":
          case "deleteCols": {
            const sheet = this.sheet(doc, op.sheet);
            const isRow = op.type === "insertRows" || op.type === "deleteRows";
            const isInsert = op.type === "insertRows" || op.type === "insertCols";
            const moved = new Map<string, MemCell>();
            for (const [k, cell] of sheet.cells) {
              const { row, col } = parseKey(k);
              const pos = isRow ? row : col;
              if (pos < op.index) {
                moved.set(k, cell);
              } else if (isInsert) {
                moved.set(isRow ? key(row + op.count, col) : key(row, col + op.count), cell);
              } else if (pos >= op.index + op.count) {
                moved.set(isRow ? key(row - op.count, col) : key(row, col - op.count), cell);
              }
            }
            sheet.cells = moved;
            sheet.version += 1;
            break;
          }
          case "addSheet":
          case "duplicateSheet": {
            const source = op.type === "duplicateSheet" ? this.sheet(doc, op.sheet) : null;
            const name = op.type === "addSheet" && op.name ? op.name : this.freeSheetName(doc, source ? `${source.meta.name} (2)` : null);
            const sheet = this.addSheet(doc, name);
            if (source) sheet.cells = new Map([...source.cells].map(([k, c]) => [k, { ...c }]));
            created.push(sheet.meta.id);
            sheetsChanged = true;
            break;
          }
          case "deleteSheet": {
            if (doc.sheets.length === 1) throw new EngineError("invalidOp", "Un libro debe contener al menos una hoja visible.");
            doc.sheets = doc.sheets.filter((s) => s.meta.id !== op.sheet);
            if (doc.activeSheet === op.sheet) doc.activeSheet = doc.sheets[0].meta.id;
            sheetsChanged = true;
            break;
          }
          case "renameSheet": {
            const name = op.name.trim();
            if (!name || name.length > 31 || /[\\/?*[\]:]/.test(name)) {
              throw new EngineError("sheetName", "El nombre de la hoja no es válido.");
            }
            if (doc.sheets.some((s) => s.meta.id !== op.sheet && s.meta.name.toLowerCase() === name.toLowerCase())) {
              throw new EngineError("sheetName", "Ya existe una hoja con ese nombre.");
            }
            const sheet = this.sheet(doc, op.sheet);
            sheet.meta = { ...sheet.meta, name };
            sheetsChanged = true;
            break;
          }
          case "moveSheet": {
            const sheet = this.sheet(doc, op.sheet);
            doc.sheets = doc.sheets.filter((s) => s !== sheet);
            doc.sheets.splice(op.index, 0, sheet);
            sheetsChanged = true;
            break;
          }
          case "setSheetHidden":
          case "setSheetColor": {
            const sheet = this.sheet(doc, op.sheet);
            sheet.meta = op.type === "setSheetHidden"
              ? { ...sheet.meta, hidden: op.hidden }
              : { ...sheet.meta, color: op.color ?? undefined };
            sheetsChanged = true;
            break;
          }
          case "setActiveSheet": {
            this.sheet(doc, op.sheet);
            doc.activeSheet = op.sheet;
            sheetsChanged = true;
            break;
          }
          default:
            throw new EngineError("unsupported", `Operación no disponible en el motor de pruebas: ${op.type}.`);
        }
      }
    } catch (error) {
      this.restore(doc, snapshot);
      throw error;
    }

    doc.undo.push(snapshot);
    doc.redo = [];
    doc.dirty = true;
    this.emitChanges(doc, touched, sheetsChanged);
    return this.result(doc, started, created, affected);
  }

  async undo(id: DocumentId): Promise<ApplyResult> {
    return this.step(id, "undo");
  }

  async redo(id: DocumentId): Promise<ApplyResult> {
    return this.step(id, "redo");
  }

  async copy(id: DocumentId, sheetId: SheetId, range: CellRange): Promise<ClipboardData> {
    // The fake only produces clipboard text; pasting `internal` sources is unsupported.
    const values = await this.getRangeValues(id, sheetId, range);
    const text = values.display.map((row) => row.join("\t")).join("\r\n");
    const html = `<table>${values.display.map((row) => `<tr>${row.map((v) => `<td>${v}</td>`).join("")}</tr>`).join("")}</table>`;
    return { clipId: 1, text, html };
  }

  async listFunctions(): Promise<FunctionName[]> {
    return ["SUM", "AVERAGE", "COUNT", "COUNTA", "MIN", "MAX", "IF", "VLOOKUP", "XLOOKUP", "SUMIF", "SUMIFS", "ROUND", "TODAY"].map((name) => ({ name }));
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ----- internals -------------------------------------------------------

  private doc(id: DocumentId): MemDoc {
    const doc = this.docs.get(id);
    if (!doc) throw new EngineError("notFound", "El documento ya no está abierto.");
    return doc;
  }

  private sheet(doc: MemDoc, id: SheetId): MemSheet {
    const sheet = doc.sheets.find((s) => s.meta.id === id);
    if (!sheet) throw new EngineError("notFound", "La hoja no existe.");
    return sheet;
  }

  private addSheet(doc: MemDoc, name: string): MemSheet {
    const sheet: MemSheet = {
      meta: { id: doc.nextSheetId++, name, hidden: false },
      cells: new Map(),
      rowSizes: new Map(),
      colSizes: new Map(),
      hiddenRows: new Set(),
      hiddenCols: new Set(),
      merges: [],
      frozenRows: 0,
      frozenCols: 0,
      showGridLines: true,
      version: 1,
    };
    doc.sheets.push(sheet);
    if (doc.sheets.length === 1) doc.activeSheet = sheet.meta.id;
    return sheet;
  }

  private freeSheetName(doc: MemDoc, preferred: string | null): string {
    const taken = new Set(doc.sheets.map((s) => s.meta.name.toLowerCase()));
    if (preferred && !taken.has(preferred.toLowerCase())) return preferred;
    let n = doc.sheets.length + 1;
    while (taken.has(`hoja${n}`)) n += 1;
    return `Hoja${n}`;
  }

  private patchStyle(base: StyleId, patch: StylePatch): StyleId {
    const { numFmt, ...rest } = patch;
    const merged: Record<string, unknown> = { ...this.styles[base] };
    for (const [field, value] of Object.entries(rest)) {
      if (value === null || value === undefined) delete merged[field];
      else merged[field] = value;
    }
    const fmt = numFmt ?? this.numFmts[base] ?? "General";
    const styleKey = JSON.stringify([merged, fmt]);
    let id = this.styleKeys.get(styleKey);
    if (id === undefined) {
      id = this.styles.length;
      this.styles.push(merged as CellStyle);
      this.numFmts.push(fmt);
      this.styleKeys.set(styleKey, id);
    }
    return id;
  }

  private serialize(doc: MemDoc): string {
    return JSON.stringify({
      activeSheet: doc.activeSheet,
      nextSheetId: doc.nextSheetId,
      sheets: doc.sheets.map((s) => ({
        ...s,
        cells: [...s.cells],
        rowSizes: [...s.rowSizes],
        colSizes: [...s.colSizes],
        hiddenRows: [...s.hiddenRows],
        hiddenCols: [...s.hiddenCols],
      })),
    });
  }

  private restore(doc: MemDoc, snapshot: string) {
    const data = JSON.parse(snapshot) as {
      activeSheet: SheetId;
      nextSheetId: number;
      sheets: (Omit<MemSheet, "cells" | "rowSizes" | "colSizes" | "hiddenRows" | "hiddenCols"> & {
        cells: [string, MemCell][];
        rowSizes: [number, number][];
        colSizes: [number, number][];
        hiddenRows: number[];
        hiddenCols: number[];
      })[];
    };
    doc.activeSheet = data.activeSheet;
    doc.nextSheetId = data.nextSheetId;
    doc.sheets = data.sheets.map((s) => ({
      ...s,
      cells: new Map(s.cells),
      rowSizes: new Map(s.rowSizes),
      colSizes: new Map(s.colSizes),
      hiddenRows: new Set(s.hiddenRows),
      hiddenCols: new Set(s.hiddenCols),
      version: s.version + 1,
    }));
  }

  private step(id: DocumentId, direction: "undo" | "redo"): ApplyResult {
    const started = performance.now();
    const doc = this.doc(id);
    const from = direction === "undo" ? doc.undo : doc.redo;
    const to = direction === "undo" ? doc.redo : doc.undo;
    const snapshot = from.pop();
    if (snapshot) {
      to.push(this.serialize(doc));
      this.restore(doc, snapshot);
      doc.dirty = true;
      this.emitChanges(doc, new Set(doc.sheets.map((s) => s.meta.id)), true);
    }
    return this.result(doc, started, [], 0);
  }

  private emitChanges(doc: MemDoc, sheets: Set<SheetId>, sheetsChanged: boolean) {
    for (const sheet of sheets) {
      if (!doc.sheets.some((s) => s.meta.id === sheet)) continue;
      this.emit({ type: "sheetData", doc: doc.id, sheet });
      this.emit({ type: "sheetInfo", doc: doc.id, sheet, version: this.sheet(doc, sheet).version });
    }
    if (sheetsChanged) {
      this.emit({ type: "sheets", doc: doc.id, sheets: doc.sheets.map((s) => s.meta), activeSheet: doc.activeSheet });
    }
    this.emitDocState(doc);
  }

  private emitDocState(doc: MemDoc) {
    this.emit({ type: "docState", doc: doc.id, dirty: doc.dirty, canUndo: doc.undo.length > 0, canRedo: doc.redo.length > 0 });
  }

  private emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private result(doc: MemDoc, started: number, created: number[], affected: number): ApplyResult {
    return {
      dirty: doc.dirty,
      canUndo: doc.undo.length > 0,
      canRedo: doc.redo.length > 0,
      selection: null,
      created,
      affected,
      elapsedMs: performance.now() - started,
    };
  }

  private info(doc: MemDoc): DocumentInfo {
    return {
      doc: doc.id,
      sourceFormat: "new",
      backend: "workbook",
      path: doc.path,
      sheets: doc.sheets.map((s) => s.meta),
      activeSheet: doc.activeSheet,
      warnings: [],
      csv: null,
      loading: false,
      dirty: doc.dirty,
      canUndo: doc.undo.length > 0,
      canRedo: doc.redo.length > 0,
    };
  }
}
