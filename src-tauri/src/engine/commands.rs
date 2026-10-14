//! Tauri commands, one per `WorkbookEngine` method (`src/engine/tauri-engine.ts`
//! calls them by these exact names). Arguments arrive camelCase from JS and
//! map to the snake_case parameters below. Every command rejects with
//! `EngineError` (`{ code, message }`).
//!
//! Each command forwards to the engine actor (`actor.rs`), which owns the
//! documents on its own thread. The names and JS-visible parameters are the
//! contract; change them only together with `tauri-engine.ts`.

use std::sync::Arc;

use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, State};

use super::actor::{function_names, Engine};
use super::backend::EventSink;
use super::types::*;

/// Starts the engine thread; its events go to the webview as `engine://event`.
pub fn start_engine(app: AppHandle) -> Engine {
    let sink: EventSink = Arc::new(move |event: EngineEvent| {
        let _ = app.emit(ENGINE_EVENT, event);
    });
    Engine::start(sink)
}

#[tauri::command]
pub async fn engine_new_document(engine: State<'_, Engine>) -> EngineResult<DocumentInfo> {
    engine.call(|s| s.new_document()).await
}

#[tauri::command]
pub async fn engine_open_document(
    engine: State<'_, Engine>,
    path: String,
    options: Option<OpenOptions>,
) -> EngineResult<DocumentInfo> {
    engine.call(move |s| s.open_document(&path, options)).await
}

#[tauri::command]
pub async fn engine_get_document_info(engine: State<'_, Engine>, doc: DocumentId) -> EngineResult<DocumentInfo> {
    engine.call(move |s| s.document_info(doc)).await
}

#[tauri::command]
pub async fn engine_save_document(
    engine: State<'_, Engine>,
    doc: DocumentId,
    path: String,
    options: SaveOptions,
) -> EngineResult<SaveResult> {
    engine.call(move |s| s.save_document(doc, &path, options)).await
}

#[tauri::command]
pub async fn engine_close_document(engine: State<'_, Engine>, doc: DocumentId) -> EngineResult<()> {
    engine
        .call(move |s| {
            s.close_document(doc);
            Ok(())
        })
        .await
}

#[tauri::command]
pub async fn engine_get_sheet_info(engine: State<'_, Engine>, doc: DocumentId, sheet: SheetId) -> EngineResult<SheetInfo> {
    engine.call(move |s| s.sheet_info(doc, sheet)).await
}

/// Returns the binary block payload (see `blocks.rs`) as a raw IPC response.
#[tauri::command]
pub async fn engine_fetch_blocks(engine: State<'_, Engine>, doc: DocumentId, req: BlockRequest) -> EngineResult<Response> {
    let bytes = engine.call(move |s| s.fetch_blocks(doc, &req)).await?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn engine_get_styles(
    engine: State<'_, Engine>,
    doc: DocumentId,
    ids: Vec<StyleId>,
) -> EngineResult<Vec<(StyleId, CellStyle)>> {
    engine.call(move |s| s.styles(doc, &ids)).await
}

#[tauri::command]
pub async fn engine_find_data_edge(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    from: CellAddress,
    dir: Direction,
) -> EngineResult<CellAddress> {
    engine.call(move |s| s.find_data_edge(doc, sheet, from, dir)).await
}

#[tauri::command]
pub async fn engine_get_column_text_samples(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    col: u32,
    limit: u32,
) -> EngineResult<Vec<TextSample>> {
    engine.call(move |s| s.column_text_samples(doc, sheet, col, limit)).await
}

#[tauri::command]
pub async fn engine_get_cell(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    cell: CellAddress,
) -> EngineResult<CellDetails> {
    engine.call(move |s| s.cell(doc, sheet, cell)).await
}

#[tauri::command]
pub async fn engine_get_range_values(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    range: CellRange,
) -> EngineResult<RangeValues> {
    engine.call(move |s| s.range_values(doc, sheet, range)).await
}

#[tauri::command]
pub async fn engine_get_selection_stats(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    ranges: Vec<CellRange>,
) -> EngineResult<SelectionStats> {
    engine.call(move |s| s.selection_stats(doc, sheet, &ranges)).await
}

#[tauri::command]
pub async fn engine_find(engine: State<'_, Engine>, doc: DocumentId, query: FindQuery) -> EngineResult<Vec<FindMatch>> {
    engine.call(move |s| s.find(doc, &query)).await
}

#[tauri::command]
pub async fn engine_get_filter_values(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    col: u32,
    limit: u32,
) -> EngineResult<Vec<FilterValue>> {
    engine.call(move |s| s.filter_values(doc, sheet, col, limit)).await
}

#[tauri::command]
pub async fn engine_get_charts(engine: State<'_, Engine>, doc: DocumentId, sheet: SheetId) -> EngineResult<Vec<ChartSpec>> {
    engine.call(move |s| s.charts(doc, sheet)).await
}

#[tauri::command]
pub async fn engine_apply(engine: State<'_, Engine>, doc: DocumentId, ops: Vec<EngineOp>) -> EngineResult<ApplyResult> {
    engine.call(move |s| s.apply(doc, &ops)).await
}

#[tauri::command]
pub async fn engine_undo(engine: State<'_, Engine>, doc: DocumentId) -> EngineResult<ApplyResult> {
    engine.call(move |s| s.undo(doc)).await
}

#[tauri::command]
pub async fn engine_redo(engine: State<'_, Engine>, doc: DocumentId) -> EngineResult<ApplyResult> {
    engine.call(move |s| s.redo(doc)).await
}

#[tauri::command]
pub async fn engine_copy(
    engine: State<'_, Engine>,
    doc: DocumentId,
    sheet: SheetId,
    range: CellRange,
) -> EngineResult<ClipboardData> {
    engine.call(move |s| s.copy(doc, sheet, range)).await
}

#[tauri::command]
pub async fn engine_list_functions() -> EngineResult<Vec<FunctionName>> {
    Ok(function_names())
}
