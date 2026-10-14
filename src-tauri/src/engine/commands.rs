//! Tauri commands, one per `WorkbookEngine` method (`src/engine/tauri-engine.ts`
//! calls them by these exact names). Arguments arrive camelCase from JS and
//! map to the snake_case parameters below. Every command rejects with
//! `EngineError` (`{ code, message }`).
//!
//! Phase 1 stubs: WS2 replaces the bodies with calls into the engine actor.
//! The names and signatures are the contract; change them only together with
//! `tauri-engine.ts`.

use tauri::ipc::Response;

use super::types::*;

#[tauri::command]
pub async fn engine_new_document() -> EngineResult<DocumentInfo> {
    Err(EngineError::unsupported("crear libros"))
}

#[tauri::command]
pub async fn engine_open_document(path: String, options: Option<OpenOptions>) -> EngineResult<DocumentInfo> {
    let _ = (path, options);
    Err(EngineError::unsupported("abrir libros"))
}

#[tauri::command]
pub async fn engine_get_document_info(doc: DocumentId) -> EngineResult<DocumentInfo> {
    let _ = doc;
    Err(EngineError::unsupported("información del libro"))
}

#[tauri::command]
pub async fn engine_save_document(doc: DocumentId, path: String, options: SaveOptions) -> EngineResult<SaveResult> {
    let _ = (doc, path, options);
    Err(EngineError::unsupported("guardar"))
}

#[tauri::command]
pub async fn engine_close_document(doc: DocumentId) -> EngineResult<()> {
    let _ = doc;
    Ok(())
}

#[tauri::command]
pub async fn engine_get_sheet_info(doc: DocumentId, sheet: SheetId) -> EngineResult<SheetInfo> {
    let _ = (doc, sheet);
    Err(EngineError::unsupported("información de la hoja"))
}

/// Returns the binary block payload (see `blocks.rs`) as a raw IPC response.
#[tauri::command]
pub async fn engine_fetch_blocks(doc: DocumentId, req: BlockRequest) -> EngineResult<Response> {
    let _ = (doc, req);
    Err(EngineError::unsupported("leer celdas"))
}

#[tauri::command]
pub async fn engine_get_styles(doc: DocumentId, ids: Vec<StyleId>) -> EngineResult<Vec<(StyleId, CellStyle)>> {
    let _ = (doc, ids);
    Err(EngineError::unsupported("estilos"))
}

#[tauri::command]
pub async fn engine_find_data_edge(
    doc: DocumentId,
    sheet: SheetId,
    from: CellAddress,
    dir: Direction,
) -> EngineResult<CellAddress> {
    let _ = (doc, sheet, dir);
    Ok(from)
}

#[tauri::command]
pub async fn engine_get_column_text_samples(
    doc: DocumentId,
    sheet: SheetId,
    col: u32,
    limit: u32,
) -> EngineResult<Vec<TextSample>> {
    let _ = (doc, sheet, col, limit);
    Ok(Vec::new())
}

#[tauri::command]
pub async fn engine_get_cell(doc: DocumentId, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails> {
    let _ = (doc, sheet, cell);
    Err(EngineError::unsupported("leer celda"))
}

#[tauri::command]
pub async fn engine_get_range_values(doc: DocumentId, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
    let _ = (doc, sheet, range);
    Err(EngineError::unsupported("leer rango"))
}

#[tauri::command]
pub async fn engine_get_selection_stats(
    doc: DocumentId,
    sheet: SheetId,
    ranges: Vec<CellRange>,
) -> EngineResult<SelectionStats> {
    let _ = (doc, sheet, ranges);
    Ok(SelectionStats::default())
}

#[tauri::command]
pub async fn engine_find(doc: DocumentId, query: FindQuery) -> EngineResult<Vec<FindMatch>> {
    let _ = (doc, query);
    Ok(Vec::new())
}

#[tauri::command]
pub async fn engine_get_filter_values(
    doc: DocumentId,
    sheet: SheetId,
    col: u32,
    limit: u32,
) -> EngineResult<Vec<FilterValue>> {
    let _ = (doc, sheet, col, limit);
    Ok(Vec::new())
}

#[tauri::command]
pub async fn engine_get_charts(doc: DocumentId, sheet: SheetId) -> EngineResult<Vec<ChartSpec>> {
    let _ = (doc, sheet);
    Ok(Vec::new())
}

#[tauri::command]
pub async fn engine_apply(doc: DocumentId, ops: Vec<EngineOp>) -> EngineResult<ApplyResult> {
    let _ = (doc, ops);
    Err(EngineError::unsupported("editar"))
}

#[tauri::command]
pub async fn engine_undo(doc: DocumentId) -> EngineResult<ApplyResult> {
    let _ = doc;
    Err(EngineError::unsupported("deshacer"))
}

#[tauri::command]
pub async fn engine_redo(doc: DocumentId) -> EngineResult<ApplyResult> {
    let _ = doc;
    Err(EngineError::unsupported("rehacer"))
}

#[tauri::command]
pub async fn engine_copy(doc: DocumentId, sheet: SheetId, range: CellRange) -> EngineResult<ClipboardData> {
    let _ = (doc, sheet, range);
    Err(EngineError::unsupported("copiar"))
}

#[tauri::command]
pub async fn engine_list_functions() -> EngineResult<Vec<FunctionName>> {
    Ok(Vec::new())
}
