import { buildBlock } from "@/engine/block-codec";
import {
  BLOCK_COLS,
  BLOCK_ROWS,
  CellKind,
  type AxisOverride,
  type BlockRequest,
  type CellBlock,
  type CellStyle,
  type SheetInfo,
  type TextSample,
} from "@/engine/contract";
import { MemoryEngine } from "@/engine/memory-engine";
import { MAX_COLS, MAX_ROWS, type CellAddress, type CellRange, type Direction, type DocumentId, type SheetId, type StyleId } from "@/engine/types";

/**
 * Deterministic synthetic sheet for the headless grid tests: a large data
 * area with every rendering feature the grid supports (overflowing text,
 * numbers that turn into ####, booleans, errors, fills, borders, fonts,
 * alignment, wrap, merges, hidden rows/cols, custom sizes, autofilter) and
 * a small async latency so blocks arrive over several frames.
 *
 * Only the grid read path is synthetic; everything else is `MemoryEngine`.
 */
export interface SyntheticOptions {
  readonly rows?: number;
  readonly cols?: number;
  readonly frozenRows?: number;
  readonly frozenCols?: number;
  /** Max artificial latency per `fetchBlocks` (ms). 0 = resolve on the next microtask. */
  readonly latencyMs?: number;
}

const STYLES: ReadonlyArray<CellStyle> = [
  {},
  { fill: "#fde68a" },
  { bold: true, color: "#1d4ed8" },
  { italic: true, underline: true, hAlign: "center" },
  { hAlign: "right", fill: "#dcfce7", borderBottom: { style: "thin", color: "#16a34a" } },
  { borderTop: { style: "medium", color: "#dc2626" }, borderLeft: { style: "dashed", color: "#7c3aed" }, borderRight: { style: "double", color: "#0f766e" }, borderBottom: { style: "dotted", color: "#334155" } },
  { wrap: true, vAlign: "top", fontSize: 9 },
  { fontFamily: "Georgia", fontSize: 14, strike: true, vAlign: "middle" },
  { hAlign: "fill" },
  { fill: "#e0e7ff", hAlign: "center", vAlign: "middle", bold: true },
];

const WORDS = ["Ventas", "Enero", "Total general", "Madrid", "Barcelona", "Producto", "Descripción larga que desborda", "x", "Año"];

export class SyntheticEngine extends MemoryEngine {
  readonly rows: number;
  readonly cols: number;
  private readonly frozenRows: number;
  private readonly frozenCols: number;
  private readonly latencyMs: number;
  private seq = 0;
  /** Every `fetchBlocks` request (tests inspect priorities / knownVersions). */
  readonly requests: BlockRequest[] = [];

  constructor(options: SyntheticOptions = {}) {
    super();
    this.rows = options.rows ?? 5000;
    this.cols = options.cols ?? 40;
    this.frozenRows = options.frozenRows ?? 0;
    this.frozenCols = options.frozenCols ?? 0;
    this.latencyMs = options.latencyMs ?? 3;
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    const ms = (this.seq++ * 7) % (this.latencyMs + 1);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Content of a cell: [text, kind, styleId] or null when empty. */
  cell(r: number, c: number): readonly [string, number, StyleId] | null {
    if (r >= this.rows || c >= this.cols) return null;
    if (r === 0) return [c % 3 === 0 ? `Encabezado de columna ${c}` : `Col ${c}`, CellKind.Text, 9];
    const h = (r * 31 + c * 17) % 23;
    if (h === 0 || h === 5 || h === 11) return null;
    const style = ((r * 7 + c * 3) % 37) % STYLES.length;
    if (c % 5 === 1) return [String(((r * 97 + c * 13) % 100000) / 100), CellKind.Number, style === 8 ? 0 : style];
    if (c % 7 === 2 && r % 3 === 0) return [String(123456789 * (r % 9 + 1)), CellKind.Number, 0];
    if (h === 7) return [r % 2 === 0 ? "VERDADERO" : "FALSO", CellKind.Bool, 0];
    if (h === 13) return ["#DIV/0!", CellKind.Error, 0];
    if (c % 4 === 0 && h % 4 === 1) return [`${WORDS[6]} ${r}:${c} — texto muy largo para probar el desbordamiento`, CellKind.Text, style];
    return [`${WORDS[(r + c) % WORDS.length]} ${r}`, CellKind.Text, style];
  }

  merges(): CellRange[] {
    const out: CellRange[] = [{ r0: 3, c0: 2, r1: 5, c1: 4 }];
    for (let r = 40; r < this.rows; r += 50) out.push({ r0: r, c0: 1, r1: r + 1, c1: 3 });
    return out;
  }

  override async getSheetInfo(doc: DocumentId, sheet: SheetId): Promise<SheetInfo> {
    const base = await super.getSheetInfo(doc, sheet);
    const rowOverrides: AxisOverride[] = [
      { index: 6, size: 42 },
      { index: 9, hidden: true },
      { index: 17, size: 8 },
      { index: 60, hidden: true },
      { index: 61, hidden: true },
      { index: 62, hidden: true },
      { index: 100, size: 64 },
    ];
    const colOverrides: AxisOverride[] = [
      { index: 2, size: 120 },
      { index: 6, hidden: true },
      { index: 9, size: 30 },
      { index: 12, size: 150 },
    ];
    return {
      ...base,
      rowCount: MAX_ROWS,
      colCount: MAX_COLS,
      usedRange: { r0: 0, c0: 0, r1: this.rows - 1, c1: this.cols - 1 },
      rowOverrides,
      colOverrides,
      merges: this.merges(),
      frozenRows: this.frozenRows,
      frozenCols: this.frozenCols,
      autoFilter: { range: { r0: 0, c0: 0, r1: this.rows - 1, c1: 8 }, filteredCols: [3] },
    };
  }

  override async fetchBlocks(_doc: DocumentId, req: BlockRequest): Promise<CellBlock[]> {
    this.requests.push(req);
    await this.delay();
    const cells: Array<{ text: string; kind: number; styleId: number; flags: number } | null> = [];
    return req.keys.map(({ br, bc }) => {
      cells.length = 0;
      for (let r = 0; r < BLOCK_ROWS; r++) {
        for (let c = 0; c < BLOCK_COLS; c++) {
          const v = this.cell(br * BLOCK_ROWS + r, bc * BLOCK_COLS + c);
          cells.push(v ? { text: v[0], kind: v[1], styleId: v[2], flags: 0 } : null);
        }
      }
      return buildBlock(req.sheet, br, bc, 1, cells);
    });
  }

  override async getStyles(_doc: DocumentId, ids: ReadonlyArray<StyleId>): Promise<ReadonlyArray<readonly [StyleId, CellStyle]>> {
    await this.delay();
    return ids.map((id) => [id, STYLES[id] ?? {}] as const);
  }

  override async findDataEdge(_doc: DocumentId, _sheet: SheetId, from: CellAddress, dir: Direction): Promise<CellAddress> {
    const [dr, dc] = dir === "up" ? [-1, 0] : dir === "down" ? [1, 0] : dir === "left" ? [0, -1] : [0, 1];
    const filled = (r: number, c: number) => this.cell(r, c) !== null;
    const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < MAX_ROWS && c < MAX_COLS;
    let { row, col } = from;
    if (!inside(row + dr, col + dc)) return from;
    const run = filled(row, col) && filled(row + dr, col + dc);
    for (let i = 0; i < 2_000_000 && inside(row + dr, col + dc); i++) {
      const next = filled(row + dr, col + dc);
      if (run ? !next : next) return run ? { row, col } : { row: row + dr, col: col + dc };
      row += dr;
      col += dc;
    }
    return { row, col };
  }

  override async getColumnTextSamples(_doc: DocumentId, _sheet: SheetId, col: number, limit: number): Promise<TextSample[]> {
    const out: TextSample[] = [];
    for (let r = 0; r < Math.min(this.rows, 400); r++) {
      const v = this.cell(r, col);
      if (v) out.push({ text: v[0], styleId: v[2] });
    }
    return out.sort((a, b) => b.text.length - a.text.length).slice(0, limit);
  }
}
