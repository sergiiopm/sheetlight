import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decodeBlocks } from "@/engine/block-codec";
import {
  EngineError,
  type ApplyResult,
  type BlockRequest,
  type CellBlock,
  type CellDetails,
  type CellStyle,
  type ChartSpec,
  type ClipboardData,
  type DocumentInfo,
  type EngineErrorCode,
  type EngineEvent,
  type EngineEventListener,
  type EngineOp,
  type FilterValue,
  type FindMatch,
  type FindQuery,
  type FunctionName,
  type OpenOptions,
  type RangeValues,
  type SaveOptions,
  type SaveResult,
  type SelectionStats,
  type SheetInfo,
  type TextSample,
  type WorkbookEngine,
} from "@/engine/contract";
import type { CellAddress, CellRange, Direction, DocumentId, SheetId, StyleId } from "@/engine/types";

/** Tauri event carrying `EngineEvent`s (see `src-tauri/src/engine/types.rs`). */
export const ENGINE_EVENT = "engine://event";

function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const { code, message } = error as { code: EngineErrorCode; message: string };
    return new EngineError(code, message);
  }
  return new EngineError("internal", typeof error === "string" ? error : "Error inesperado del motor.");
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toEngineError(error);
  }
}

/** `WorkbookEngine` backed by the native engine in `src-tauri/src/engine`. */
export class TauriEngine implements WorkbookEngine {
  private readonly listeners = new Set<EngineEventListener>();
  private unlisten: Promise<() => void> | null = null;

  newDocument(): Promise<DocumentInfo> {
    return call("engine_new_document");
  }

  openDocument(path: string, options?: OpenOptions): Promise<DocumentInfo> {
    return call("engine_open_document", { path, options: options ?? null });
  }

  async openBytes(): Promise<DocumentInfo> {
    throw new EngineError("unsupported", "En la aplicación de escritorio los libros se abren por ruta.");
  }

  getDocumentInfo(doc: DocumentId): Promise<DocumentInfo> {
    return call("engine_get_document_info", { doc });
  }

  saveDocument(doc: DocumentId, path: string, options: SaveOptions): Promise<SaveResult> {
    return call("engine_save_document", { doc, path, options });
  }

  closeDocument(doc: DocumentId): Promise<void> {
    return call("engine_close_document", { doc });
  }

  getSheetInfo(doc: DocumentId, sheet: SheetId): Promise<SheetInfo> {
    return call("engine_get_sheet_info", { doc, sheet });
  }

  async fetchBlocks(doc: DocumentId, req: BlockRequest): Promise<CellBlock[]> {
    const buffer = await call<ArrayBuffer>("engine_fetch_blocks", { doc, req });
    return decodeBlocks(buffer).blocks;
  }

  getStyles(doc: DocumentId, ids: ReadonlyArray<StyleId>): Promise<ReadonlyArray<readonly [StyleId, CellStyle]>> {
    return call("engine_get_styles", { doc, ids });
  }

  findDataEdge(doc: DocumentId, sheet: SheetId, from: CellAddress, dir: Direction): Promise<CellAddress> {
    return call("engine_find_data_edge", { doc, sheet, from, dir });
  }

  getColumnTextSamples(doc: DocumentId, sheet: SheetId, col: number, limit: number): Promise<TextSample[]> {
    return call("engine_get_column_text_samples", { doc, sheet, col, limit });
  }

  getCell(doc: DocumentId, sheet: SheetId, cell: CellAddress): Promise<CellDetails> {
    return call("engine_get_cell", { doc, sheet, cell });
  }

  getRangeValues(doc: DocumentId, sheet: SheetId, range: CellRange): Promise<RangeValues> {
    return call("engine_get_range_values", { doc, sheet, range });
  }

  getSelectionStats(doc: DocumentId, sheet: SheetId, ranges: ReadonlyArray<CellRange>): Promise<SelectionStats> {
    return call("engine_get_selection_stats", { doc, sheet, ranges });
  }

  find(doc: DocumentId, query: FindQuery): Promise<FindMatch[]> {
    return call("engine_find", { doc, query });
  }

  getFilterValues(doc: DocumentId, sheet: SheetId, col: number, limit: number): Promise<FilterValue[]> {
    return call("engine_get_filter_values", { doc, sheet, col, limit });
  }

  getCharts(doc: DocumentId, sheet: SheetId): Promise<ChartSpec[]> {
    return call("engine_get_charts", { doc, sheet });
  }

  apply(doc: DocumentId, ops: ReadonlyArray<EngineOp>): Promise<ApplyResult> {
    return call("engine_apply", { doc, ops });
  }

  undo(doc: DocumentId): Promise<ApplyResult> {
    return call("engine_undo", { doc });
  }

  redo(doc: DocumentId): Promise<ApplyResult> {
    return call("engine_redo", { doc });
  }

  copy(doc: DocumentId, sheet: SheetId, range: CellRange): Promise<ClipboardData> {
    return call("engine_copy", { doc, sheet, range });
  }

  listFunctions(): Promise<FunctionName[]> {
    return call("engine_list_functions");
  }

  subscribe(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    this.unlisten ??= listen<EngineEvent>(ENGINE_EVENT, ({ payload }) => {
      for (const l of this.listeners) l(payload);
    });
    return () => {
      this.listeners.delete(listener);
    };
  }
}
