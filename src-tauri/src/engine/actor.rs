//! The engine actor: one dedicated thread owns every open document, so
//! IronCalc (not `Sync`) never crosses threads and long operations never
//! block the webview. Commands send closures (`Job`s) through a channel and
//! await the reply on a oneshot.
//!
//! The actor also implements the document-level parts of the contract that
//! do not belong to a backend: open/save, CSV-store promotion, block
//! encoding, `DocState` events and the dirty flag.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Instant;

use super::backend::{ApplyOutcome, DocumentBackend, EventSink, ImportedSheet, ImportedWorkbook};
use super::blocks::{BlockCells, BlocksWriter};
use super::types::*;
use super::workbook::{self, SheetExtra, WorkbookBackend};
use crate::xlsx_package::{self, OriginalPackage, SheetSaveInfo};

/// Engine thread stack: IronCalc evaluation recurses on long reference chains.
const ENGINE_STACK: usize = 64 * 1024 * 1024;
/// Largest range `copy` / `getRangeValues` accept (cells).
const MAX_RANGE_CELLS: u64 = 5_000_000;

type Job = Box<dyn FnOnce(&mut EngineState) + Send>;

/// The document's data: the IronCalc workbook, or another backend (CSV store).
pub enum Backend {
    Workbook(Box<WorkbookBackend>),
    Other(Box<dyn DocumentBackend>),
}

impl Backend {
    pub fn get(&self) -> &dyn DocumentBackend {
        match self {
            Backend::Workbook(w) => w.as_ref(),
            Backend::Other(o) => o.as_ref(),
        }
    }

    pub fn get_mut(&mut self) -> &mut dyn DocumentBackend {
        match self {
            Backend::Workbook(w) => w.as_mut(),
            Backend::Other(o) => o.as_mut(),
        }
    }
}

pub struct Document {
    pub id: DocumentId,
    pub backend: Backend,
    pub source_format: SourceFormat,
    pub path: Option<String>,
    pub warnings: Vec<FidelityWarning>,
    pub csv: Option<CsvOptions>,
    pub original: Option<OriginalPackage>,
    pub dirty: bool,
    /// Set by the CSV store's sink until its `loadProgress { done }`.
    pub loading: Arc<AtomicBool>,
}

impl Document {
    fn info(&self) -> DocumentInfo {
        let backend = self.backend.get();
        DocumentInfo {
            doc: self.id,
            source_format: self.source_format,
            backend: backend.kind(),
            path: self.path.clone(),
            sheets: backend.sheets(),
            active_sheet: backend.active_sheet(),
            warnings: self.warnings.clone(),
            csv: self.csv.clone(),
            loading: self.loading.load(Ordering::Relaxed),
            dirty: self.dirty,
            can_undo: backend.can_undo(),
            can_redo: backend.can_redo(),
        }
    }

    fn doc_state(&self) -> EngineEvent {
        let backend = self.backend.get();
        EngineEvent::DocState { doc: self.id, dirty: self.dirty, can_undo: backend.can_undo(), can_redo: backend.can_redo() }
    }
}

/// State owned by the engine thread.
pub struct EngineState {
    docs: HashMap<DocumentId, Document>,
    next_doc: DocumentId,
    sink: EventSink,
    scratch: BlockCells,
}

/// Sets the document id of an event produced by a backend (which uses 0).
fn with_doc(event: EngineEvent, id: DocumentId) -> EngineEvent {
    use EngineEvent as E;
    match event {
        E::Cells { sheet, ranges, .. } => E::Cells { doc: id, sheet, ranges },
        E::SheetData { sheet, .. } => E::SheetData { doc: id, sheet },
        E::SheetInfo { sheet, version, .. } => E::SheetInfo { doc: id, sheet, version },
        E::Structure { sheet, axis, op, index, count, .. } => E::Structure { doc: id, sheet, axis, op, index, count },
        E::Styles { .. } => E::Styles { doc: id },
        E::Sheets { sheets, active_sheet, .. } => E::Sheets { doc: id, sheets, active_sheet },
        E::Charts { sheet, .. } => E::Charts { doc: id, sheet },
        E::DocState { dirty, can_undo, can_redo, .. } => E::DocState { doc: id, dirty, can_undo, can_redo },
        E::LoadProgress { rows_loaded, bytes_read, bytes_total, done, error, .. } => {
            E::LoadProgress { doc: id, rows_loaded, bytes_read, bytes_total, done, error }
        }
        E::BackendChanged { backend, .. } => E::BackendChanged { doc: id, backend },
    }
}

fn file_stem(path: &str) -> String {
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Libro1".to_string())
}

fn extension(path: &str) -> String {
    Path::new(path).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn read_file(path: &str) -> EngineResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => EngineError::not_found("No se encontró el archivo."),
        std::io::ErrorKind::PermissionDenied => EngineError::io("No hay permiso para abrir el archivo."),
        _ => EngineError::io(format!("No se pudo leer el archivo: {e}")),
    })
}

/// Writes through a temporary file in the same folder, then renames it over
/// the target, so a failed save never leaves a truncated file.
pub fn write_atomic(path: &str, bytes: &[u8]) -> EngineResult<()> {
    let target = Path::new(path);
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = target.with_file_name(format!(".{name}.sheetlight-tmp"));
    let io_error = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::PermissionDenied => {
            EngineError::io("No hay permiso para guardar el archivo (¿está abierto en otro programa?).")
        }
        _ => EngineError::io(format!("No se pudo guardar el archivo: {e}")),
    };
    std::fs::write(&temp, bytes).map_err(io_error)?;
    if let Err(e) = std::fs::rename(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(io_error(e));
    }
    Ok(())
}

/// Encodes UTF-8 text for a CSV file.
fn encode_csv(text: &str, encoding: Option<&str>) -> Vec<u8> {
    match encoding {
        Some("utf-16le") => {
            let mut out = vec![0xff, 0xfe];
            for unit in text.encode_utf16() {
                out.extend_from_slice(&unit.to_le_bytes());
            }
            out
        }
        Some("windows-1252") => text.chars().map(encode_1252).collect(),
        // UTF-8 with BOM: Excel needs the BOM to read accents correctly.
        _ => {
            let mut out = vec![0xef, 0xbb, 0xbf];
            out.extend_from_slice(text.as_bytes());
            out
        }
    }
}

fn encode_1252(c: char) -> u8 {
    const HIGH: [(char, u8); 27] = [
        ('€', 0x80), ('‚', 0x82), ('ƒ', 0x83), ('„', 0x84), ('…', 0x85), ('†', 0x86), ('‡', 0x87), ('ˆ', 0x88),
        ('‰', 0x89), ('Š', 0x8a), ('‹', 0x8b), ('Œ', 0x8c), ('Ž', 0x8e), ('‘', 0x91), ('’', 0x92), ('“', 0x93),
        ('”', 0x94), ('•', 0x95), ('–', 0x96), ('—', 0x97), ('˜', 0x98), ('™', 0x99), ('š', 0x9a), ('›', 0x9b),
        ('œ', 0x9c), ('ž', 0x9e), ('Ÿ', 0x9f),
    ];
    let code = c as u32;
    if code < 0x80 || (0xa0..=0xff).contains(&code) {
        return code as u8;
    }
    HIGH.iter().find(|(ch, _)| *ch == c).map(|(_, b)| *b).unwrap_or(b'?')
}

impl EngineState {
    pub fn new(sink: EventSink) -> Self {
        Self { docs: HashMap::new(), next_doc: 1, sink, scratch: BlockCells::new() }
    }

    fn emit(&self, event: EngineEvent) {
        (self.sink)(event);
    }

    fn doc(&self, id: DocumentId) -> EngineResult<&Document> {
        self.docs.get(&id).ok_or_else(|| EngineError::not_found("El libro no está abierto."))
    }

    fn doc_mut(&mut self, id: DocumentId) -> EngineResult<&mut Document> {
        self.docs.get_mut(&id).ok_or_else(|| EngineError::not_found("El libro no está abierto."))
    }

    fn insert(&mut self, mut doc: Document) -> DocumentInfo {
        doc.id = self.next_doc;
        self.next_doc += 1;
        let info = doc.info();
        self.docs.insert(doc.id, doc);
        info
    }

    fn reserve_id(&mut self) -> DocumentId {
        let id = self.next_doc;
        self.next_doc += 1;
        id
    }

    fn workbook_doc(backend: WorkbookBackend, source_format: SourceFormat, path: Option<String>) -> Document {
        Document {
            id: 0,
            backend: Backend::Workbook(Box::new(backend)),
            source_format,
            path,
            warnings: Vec::new(),
            csv: None,
            original: None,
            dirty: false,
            loading: Arc::new(AtomicBool::new(false)),
        }
    }

    // ----- documents -----------------------------------------------------------

    pub fn new_document(&mut self) -> EngineResult<DocumentInfo> {
        let backend = workbook::new_workbook()?;
        Ok(self.insert(Self::workbook_doc(backend, SourceFormat::New, None)))
    }

    pub fn open_document(&mut self, path: &str, options: Option<OpenOptions>) -> EngineResult<DocumentInfo> {
        let csv_options = options.and_then(|o| o.csv).unwrap_or_default();
        match extension(path).as_str() {
            "xlsx" | "xlsm" => {
                let bytes = read_file(path)?;
                self.open_xlsx_bytes(&bytes, &file_stem(path), Some(path.to_string()))
            }
            "xls" => {
                let bytes = read_file(path)?;
                let imported = xlsx_package::import_xls(&bytes)?;
                let backend = workbook::import_workbook(imported, &file_stem(path))?;
                Ok(self.insert(Self::workbook_doc(backend, SourceFormat::Xls, Some(path.to_string()))))
            }
            "csv" | "txt" | "tsv" => self.open_csv(path, &csv_options),
            _ => Err(EngineError::new(EngineErrorCode::Unsupported, "Este tipo de archivo no se puede abrir.")),
        }
    }

    pub fn open_xlsx_bytes(&mut self, bytes: &[u8], name: &str, path: Option<String>) -> EngineResult<DocumentInfo> {
        let original = xlsx_package::inspect(bytes)?;
        let model = workbook::load_xlsx(bytes, name)?;
        let sheet_ids: Vec<SheetId> = model.workbook.worksheets.iter().map(|ws| ws.sheet_id).collect();
        let mut extras: Vec<SheetExtra> =
            (0..sheet_ids.len()).map(|i| SheetExtra { original_index: Some(i), ..SheetExtra::default() }).collect();
        for (index, range) in &original.auto_filters {
            if let Some(extra) = extras.get_mut(*index) {
                extra.filter = Some(workbook::AutoFilter { range: *range, criteria: Default::default() });
            }
        }
        for (index, chart) in &original.charts {
            if let (Some(extra), Some(id)) = (extras.get_mut(*index), sheet_ids.get(*index)) {
                let mut chart = chart.clone();
                chart.draft.sheet = *id;
                chart.from_file = true;
                extra.charts.push(chart);
            }
        }
        let backend = WorkbookBackend::from_model(model, extras);
        let mut doc = Self::workbook_doc(backend, SourceFormat::Xlsx, path);
        doc.warnings = original.warnings.clone();
        doc.original = Some(original);
        Ok(self.insert(doc))
    }

    fn open_csv(&mut self, path: &str, options: &CsvOptions) -> EngineResult<DocumentInfo> {
        let id = self.reserve_id();
        let loading = Arc::new(AtomicBool::new(true));
        let sink = {
            let outer = self.sink.clone();
            let loading = loading.clone();
            let sink: EventSink = Arc::new(move |event: EngineEvent| {
                if let EngineEvent::LoadProgress { done: true, .. } = event {
                    loading.store(false, Ordering::Relaxed);
                }
                outer(with_doc(event, id));
            });
            sink
        };
        let (backend, used, loading) = match crate::csv_store::open(path, options, id, sink) {
            Ok((store, used)) => (Backend::Other(store), used, loading),
            Err(e) if e.code == EngineErrorCode::Unsupported => {
                // No fast store: read the CSV into a workbook.
                let bytes = read_file(path)?;
                let import = workbook::import_csv_small(&bytes, options, &file_stem(path))?;
                (Backend::Workbook(Box::new(import.backend)), import.options, Arc::new(AtomicBool::new(false)))
            }
            Err(e) => return Err(e),
        };
        let doc = Document {
            id,
            backend,
            source_format: SourceFormat::Csv,
            path: Some(path.to_string()),
            warnings: Vec::new(),
            csv: Some(used),
            original: None,
            dirty: false,
            loading,
        };
        let info = doc.info();
        self.docs.insert(id, doc);
        Ok(info)
    }

    pub fn document_info(&self, doc: DocumentId) -> EngineResult<DocumentInfo> {
        Ok(self.doc(doc)?.info())
    }

    pub fn close_document(&mut self, doc: DocumentId) {
        self.docs.remove(&doc);
    }

    pub fn save_document(&mut self, id: DocumentId, path: &str, options: SaveOptions) -> EngineResult<SaveResult> {
        let lost = match options.format {
            SaveFormat::Xlsx => {
                self.promote(id)?;
                let doc = self.doc(id)?;
                let Backend::Workbook(wb) = &doc.backend else {
                    return Err(EngineError::internal("El libro no se pudo convertir."));
                };
                let fresh = wb.xlsx_bytes()?;
                let sheets: Vec<SheetSaveInfo> = wb
                    .save_sheets()
                    .into_iter()
                    .map(|(id, name, original_index, auto_filter)| SheetSaveInfo { id, name, original_index, auto_filter })
                    .collect();
                let bytes = xlsx_package::post_process(fresh, doc.original.as_ref(), &sheets, &wb.all_charts())?;
                write_atomic(path, &bytes)?;
                let mut lost: Vec<FidelityFeature> =
                    doc.warnings.iter().filter(|w| w.on_save == OnSave::Lost).map(|w| w.feature).collect();
                lost.dedup();
                lost
            }
            SaveFormat::Csv => {
                let doc = self.doc(id)?;
                let backend = doc.backend.get();
                let sheet = options.sheet.unwrap_or_else(|| backend.active_sheet());
                let base = doc.csv.clone().unwrap_or_default();
                let requested = options.csv.clone().unwrap_or_default();
                let resolved = CsvOptions {
                    delimiter: requested.delimiter.or(base.delimiter).or_else(|| Some(";".to_string())),
                    encoding: requested.encoding.or(base.encoding).or_else(|| Some("utf-8".to_string())),
                    decimal: requested.decimal.or(base.decimal).or_else(|| Some(",".to_string())),
                };
                let mut text = Vec::new();
                backend.write_csv(sheet, &mut text, &resolved)?;
                let text = String::from_utf8_lossy(&text);
                write_atomic(path, &encode_csv(&text, resolved.encoding.as_deref()))?;
                // Everything but the values of one sheet is dropped.
                let mut lost: Vec<FidelityFeature> = doc.warnings.iter().map(|w| w.feature).collect();
                if let Backend::Workbook(wb) = &doc.backend {
                    if !wb.all_charts().is_empty() && !lost.contains(&FidelityFeature::Charts) {
                        lost.push(FidelityFeature::Charts);
                    }
                }
                if backend.sheets().len() > 1 {
                    lost.push(FidelityFeature::Other);
                }
                lost.dedup();
                lost
            }
        };
        let doc = self.doc_mut(id)?;
        doc.dirty = false;
        doc.path = Some(path.to_string());
        let state = doc.doc_state();
        self.emit(state);
        Ok(SaveResult { path: path.to_string(), format: options.format, lost })
    }

    /// Converts a non-workbook backend into a workbook (first op the CSV store
    /// cannot apply, or xlsx save). The old backend's undo history is dropped.
    fn promote(&mut self, id: DocumentId) -> EngineResult<bool> {
        let doc = self.doc_mut(id)?;
        let Backend::Other(other) = &doc.backend else { return Ok(false) };
        if doc.loading.load(Ordering::Relaxed) {
            return Err(EngineError::new(
                EngineErrorCode::InvalidOp,
                "Espera a que termine de cargarse el archivo para hacer este cambio.",
            ));
        }
        let mut imported = ImportedWorkbook::default();
        for meta in other.sheets() {
            let mut sheet = ImportedSheet { name: meta.name.clone(), ..ImportedSheet::default() };
            other.export_cells(meta.id, &mut |row, col, input| sheet.cells.push((row, col, input.to_string())))?;
            if let Ok(info) = other.sheet_info(meta.id) {
                sheet.col_widths = info.col_overrides.iter().filter_map(|o| o.size.map(|s| (o.index, s))).collect();
                sheet.merges = info.merges.clone();
            }
            imported.sheets.push(sheet);
        }
        let name = doc.path.as_deref().map(file_stem).unwrap_or_else(|| "Libro1".to_string());
        let backend = workbook::import_workbook(imported, &name)?;
        doc.backend = Backend::Workbook(Box::new(backend));
        doc.dirty = true;
        let backend = doc.backend.get();
        let sheets = backend.sheets();
        let active_sheet = backend.active_sheet();
        let mut events = vec![
            EngineEvent::BackendChanged { doc: id, backend: BackendKind::Workbook },
            EngineEvent::Sheets { doc: id, sheets: sheets.clone(), active_sheet },
        ];
        for meta in &sheets {
            events.push(EngineEvent::SheetData { doc: id, sheet: meta.id });
            let version = backend.sheet_info(meta.id).map(|i| i.version).unwrap_or(0);
            events.push(EngineEvent::SheetInfo { doc: id, sheet: meta.id, version });
        }
        for event in events {
            self.emit(event);
        }
        Ok(true)
    }

    // ----- grid data -----------------------------------------------------------

    pub fn sheet_info(&self, doc: DocumentId, sheet: SheetId) -> EngineResult<SheetInfo> {
        self.doc(doc)?.backend.get().sheet_info(sheet)
    }

    pub fn fetch_blocks(&mut self, doc: DocumentId, req: &BlockRequest) -> EngineResult<Vec<u8>> {
        let mut cells = std::mem::take(&mut self.scratch);
        let result = (|| {
            let backend = self.doc(doc)?.backend.get();
            let mut writer = BlocksWriter::new(req.sheet);
            for (i, key) in req.keys.iter().enumerate() {
                cells.clear();
                backend.write_block(req.sheet, *key, &mut cells)?;
                let version = cells.content_hash();
                let known = req.known_versions.as_ref().and_then(|v| v.get(i)).copied();
                if known == Some(version) {
                    writer.unchanged(*key, version);
                } else {
                    writer.block(*key, version, &cells);
                }
            }
            Ok(writer.finish())
        })();
        self.scratch = cells;
        result
    }

    pub fn styles(&self, doc: DocumentId, ids: &[StyleId]) -> EngineResult<Vec<(StyleId, CellStyle)>> {
        Ok(self.doc(doc)?.backend.get().styles(ids))
    }

    pub fn find_data_edge(&self, doc: DocumentId, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress> {
        self.doc(doc)?.backend.get().find_data_edge(sheet, from, dir)
    }

    pub fn column_text_samples(&self, doc: DocumentId, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>> {
        self.doc(doc)?.backend.get().column_text_samples(sheet, col, limit)
    }

    // ----- cell queries --------------------------------------------------------

    pub fn cell(&self, doc: DocumentId, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails> {
        self.doc(doc)?.backend.get().cell_details(sheet, cell)
    }

    pub fn range_values(&self, doc: DocumentId, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
        check_range_size(&range)?;
        self.doc(doc)?.backend.get().range_values(sheet, range)
    }

    pub fn selection_stats(&self, doc: DocumentId, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats> {
        self.doc(doc)?.backend.get().selection_stats(sheet, ranges)
    }

    pub fn find(&self, doc: DocumentId, query: &FindQuery) -> EngineResult<Vec<FindMatch>> {
        self.doc(doc)?.backend.get().find(query)
    }

    pub fn filter_values(&self, doc: DocumentId, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>> {
        self.doc(doc)?.backend.get().filter_values(sheet, col, limit)
    }

    pub fn charts(&self, doc: DocumentId, sheet: SheetId) -> EngineResult<Vec<ChartSpec>> {
        match &self.doc(doc)?.backend {
            Backend::Workbook(wb) => Ok(wb.charts(sheet)),
            Backend::Other(_) => Ok(Vec::new()),
        }
    }

    // ----- mutations -----------------------------------------------------------

    fn finish(&mut self, id: DocumentId, outcome: ApplyOutcome, started: Instant, changed: bool) -> EngineResult<ApplyResult> {
        let doc = self.doc_mut(id)?;
        if changed {
            doc.dirty = true;
        }
        let backend = doc.backend.get();
        let result = ApplyResult {
            dirty: doc.dirty,
            can_undo: backend.can_undo(),
            can_redo: backend.can_redo(),
            selection: outcome.selection,
            created: outcome.created,
            affected: outcome.affected,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        };
        let state = doc.doc_state();
        for event in outcome.events {
            self.emit(with_doc(event, id));
        }
        self.emit(state);
        Ok(result)
    }

    pub fn apply(&mut self, id: DocumentId, ops: &[EngineOp]) -> EngineResult<ApplyResult> {
        let started = Instant::now();
        let needs_promotion = {
            let backend = self.doc(id)?.backend.get();
            backend.kind() != BackendKind::Workbook && ops.iter().any(|op| !backend.supports(op))
        };
        if needs_promotion {
            self.promote(id)?;
        }
        let outcome = self.doc_mut(id)?.backend.get_mut().apply(ops)?;
        let changed = !outcome.events.is_empty() || !outcome.created.is_empty();
        self.finish(id, outcome, started, changed)
    }

    pub fn undo(&mut self, id: DocumentId) -> EngineResult<ApplyResult> {
        let started = Instant::now();
        let backend = self.doc_mut(id)?.backend.get_mut();
        let changed = backend.can_undo();
        let outcome = backend.undo()?;
        self.finish(id, outcome, started, changed)
    }

    pub fn redo(&mut self, id: DocumentId) -> EngineResult<ApplyResult> {
        let started = Instant::now();
        let backend = self.doc_mut(id)?.backend.get_mut();
        let changed = backend.can_redo();
        let outcome = backend.redo()?;
        self.finish(id, outcome, started, changed)
    }

    pub fn copy(&self, id: DocumentId, sheet: SheetId, range: CellRange) -> EngineResult<ClipboardData> {
        match &self.doc(id)?.backend {
            Backend::Workbook(wb) => wb.copy(sheet, range),
            Backend::Other(other) => {
                check_range_size(&range)?;
                let values = other.range_values(sheet, range)?;
                Ok(workbook::copy_values(sheet, &values))
            }
        }
    }
}

fn check_range_size(range: &CellRange) -> EngineResult<()> {
    let rows = u64::from(range.r1.abs_diff(range.r0)) + 1;
    let cols = u64::from(range.c1.abs_diff(range.c0)) + 1;
    if rows * cols > MAX_RANGE_CELLS {
        return Err(EngineError::new(EngineErrorCode::TooLarge, "El rango es demasiado grande."));
    }
    Ok(())
}

pub fn function_names() -> Vec<FunctionName> {
    workbook::FUNCTION_NAMES.iter().map(|name| FunctionName { name: (*name).to_string() }).collect()
}

/// Handle to the engine thread (managed as Tauri state).
pub struct Engine {
    tx: mpsc::Sender<Job>,
}

impl Engine {
    pub fn start(sink: EventSink) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        #[allow(clippy::expect_used)]
        std::thread::Builder::new()
            .name("sheetlight-engine".to_string())
            .stack_size(ENGINE_STACK)
            .spawn(move || {
                let mut state = EngineState::new(sink);
                while let Ok(job) = rx.recv() {
                    // A panic inside IronCalc must not kill the engine thread.
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&mut state)));
                    if result.is_err() {
                        eprintln!("[engine] job panicked");
                    }
                }
            })
            .expect("engine thread");
        Self { tx }
    }

    fn send<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut EngineState) -> EngineResult<T> + Send + 'static,
    ) -> EngineResult<tokio::sync::oneshot::Receiver<EngineResult<T>>> {
        let (reply, rx) = tokio::sync::oneshot::channel();
        let job: Job = Box::new(move |state| {
            let _ = reply.send(f(state));
        });
        self.tx.send(job).map_err(|_| EngineError::internal("El motor de cálculo no está disponible."))?;
        Ok(rx)
    }

    /// Runs `f` on the engine thread and awaits its result.
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut EngineState) -> EngineResult<T> + Send + 'static,
    ) -> EngineResult<T> {
        let rx = self.send(f)?;
        rx.await.unwrap_or_else(|_| Err(EngineError::internal("Error interno del motor de cálculo.")))
    }

    /// Blocking variant (tests).
    #[cfg(test)]
    pub fn call_blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut EngineState) -> EngineResult<T> + Send + 'static,
    ) -> EngineResult<T> {
        let rx = self.send(f)?;
        rx.blocking_recv().unwrap_or_else(|_| Err(EngineError::internal("Error interno del motor de cálculo.")))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::engine::blocks::{BLOCKS_MAGIC, BLOCK_STATE_UNCHANGED};

    fn collecting() -> (EventSink, Arc<Mutex<Vec<EngineEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let inner = events.clone();
        let sink: EventSink = Arc::new(move |event| inner.lock().unwrap().push(event));
        (sink, events)
    }

    fn set(sheet: SheetId, row: u32, col: u32, input: &str) -> EngineOp {
        EngineOp::SetCells { sheet, cells: vec![CellInput { row, col, input: input.into(), num_fmt: None }] }
    }

    fn temp_path(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("sheetlight-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name).to_string_lossy().into_owned()
    }

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn apply_emits_events_with_doc_id_and_doc_state() {
        let (sink, events) = collecting();
        let mut state = EngineState::new(sink);
        let info = state.new_document().unwrap();
        assert!(!info.dirty && !info.can_undo);
        let sheet = info.active_sheet;
        let result = state.apply(info.doc, &[set(sheet, 0, 0, "=2*21")]).unwrap();
        assert!(result.dirty && result.can_undo && !result.can_redo);
        assert_eq!(result.selection.as_ref().map(|s| s.active), Some(CellAddress { row: 0, col: 0 }));
        let events = events.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, EngineEvent::Cells { doc, .. } | EngineEvent::SheetData { doc, .. } if *doc == info.doc)));
        assert!(matches!(events.last(), Some(EngineEvent::DocState { doc, dirty: true, can_undo: true, .. }) if *doc == info.doc));
        drop(events);
        let cell = state.cell(info.doc, sheet, CellAddress { row: 0, col: 0 }).unwrap();
        assert_eq!(cell.value, CellValue::Number { value: 42.0 });
        let undone = state.undo(info.doc).unwrap();
        assert!(!undone.can_undo && undone.can_redo);
    }

    #[test]
    fn fetch_blocks_skips_known_versions() {
        let (sink, _) = collecting();
        let mut state = EngineState::new(sink);
        let info = state.new_document().unwrap();
        let sheet = info.active_sheet;
        state.apply(info.doc, &[set(sheet, 0, 0, "hola")]).unwrap();
        let key = BlockKey { br: 0, bc: 0 };
        let req = BlockRequest { sheet, keys: vec![key], known_versions: None, priority: 0 };
        let bytes = state.fetch_blocks(info.doc, &req).unwrap();
        assert_eq!(u32_at(&bytes, 0), BLOCKS_MAGIC);
        assert_eq!(u32_at(&bytes, 4), 1);
        let version = u32_at(&bytes, 16 + 8);
        let req = BlockRequest { known_versions: Some(vec![version]), ..req };
        let bytes = state.fetch_blocks(info.doc, &req).unwrap();
        assert_eq!(bytes.len(), 16 + 24);
        assert_eq!(u32_at(&bytes, 16 + 12), BLOCK_STATE_UNCHANGED);
    }

    #[test]
    fn unknown_document_is_not_found() {
        let (sink, _) = collecting();
        let state = EngineState::new(sink);
        assert_eq!(state.document_info(99).unwrap_err().code, EngineErrorCode::NotFound);
    }

    #[test]
    fn save_and_reopen_xlsx_and_csv() {
        let (sink, events) = collecting();
        let mut state = EngineState::new(sink);
        let info = state.new_document().unwrap();
        let sheet = info.active_sheet;
        state.apply(info.doc, &[set(sheet, 0, 0, "1,5 kg"), set(sheet, 0, 1, "2.5"), set(sheet, 1, 1, "=B1*2")]).unwrap();
        let xlsx = temp_path("libro.xlsx");
        let saved = state.save_document(info.doc, &xlsx, SaveOptions { format: SaveFormat::Xlsx, sheet: None, csv: None }).unwrap();
        assert!(saved.lost.is_empty());
        assert!(!state.document_info(info.doc).unwrap().dirty);
        assert!(matches!(events.lock().unwrap().last(), Some(EngineEvent::DocState { dirty: false, .. })));

        let reopened = state.open_document(&xlsx, None).unwrap();
        assert_eq!(reopened.source_format, SourceFormat::Xlsx);
        assert_eq!(reopened.backend, BackendKind::Workbook);
        let cell = state.cell(reopened.doc, reopened.active_sheet, CellAddress { row: 1, col: 1 }).unwrap();
        assert_eq!(cell.input, "=B1*2");
        assert_eq!(cell.value, CellValue::Number { value: 5.0 });

        let csv = temp_path("datos.csv");
        state.save_document(info.doc, &csv, SaveOptions { format: SaveFormat::Csv, sheet: None, csv: None }).unwrap();
        let bytes = std::fs::read(&csv).unwrap();
        assert_eq!(&bytes[..3], &[0xef, 0xbb, 0xbf]);
        assert_eq!(String::from_utf8_lossy(&bytes[3..]), "1,5 kg;2,5\r\n;5\r\n");
        let from_csv = state.open_document(&csv, None).unwrap();
        assert_eq!(from_csv.source_format, SourceFormat::Csv);
        assert_eq!(from_csv.csv.as_ref().and_then(|c| c.delimiter.as_deref()), Some(";"));
        let cell = state.cell(from_csv.doc, from_csv.active_sheet, CellAddress { row: 0, col: 1 }).unwrap();
        assert_eq!(cell.value, CellValue::Number { value: 2.5 });
        state.close_document(from_csv.doc);
        assert!(state.document_info(from_csv.doc).is_err());
    }

    #[test]
    fn open_rejects_missing_and_unknown_files() {
        let (sink, _) = collecting();
        let mut state = EngineState::new(sink);
        assert_eq!(state.open_document(&temp_path("nope.xlsx"), None).unwrap_err().code, EngineErrorCode::NotFound);
        assert_eq!(state.open_document("archivo.pdf", None).unwrap_err().code, EngineErrorCode::Unsupported);
        let broken = temp_path("roto.xlsx");
        std::fs::write(&broken, b"not a zip").unwrap();
        assert_eq!(state.open_document(&broken, None).unwrap_err().code, EngineErrorCode::Parse);
    }

    /// A stand-in for the CSV store: a workbook that only accepts value edits.
    struct FakeStore(WorkbookBackend);

    impl DocumentBackend for FakeStore {
        fn kind(&self) -> BackendKind {
            BackendKind::Csv
        }
        fn sheets(&self) -> Vec<SheetMeta> {
            self.0.sheets()
        }
        fn active_sheet(&self) -> SheetId {
            self.0.active_sheet()
        }
        fn sheet_info(&self, sheet: SheetId) -> EngineResult<SheetInfo> {
            self.0.sheet_info(sheet)
        }
        fn write_block(&self, sheet: SheetId, key: BlockKey, cells: &mut BlockCells) -> EngineResult<()> {
            self.0.write_block(sheet, key, cells)
        }
        fn styles(&self, ids: &[StyleId]) -> Vec<(StyleId, CellStyle)> {
            DocumentBackend::styles(&self.0, ids)
        }
        fn find_data_edge(&self, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress> {
            self.0.find_data_edge(sheet, from, dir)
        }
        fn column_text_samples(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>> {
            self.0.column_text_samples(sheet, col, limit)
        }
        fn cell_details(&self, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails> {
            self.0.cell_details(sheet, cell)
        }
        fn range_values(&self, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
            self.0.range_values(sheet, range)
        }
        fn selection_stats(&self, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats> {
            self.0.selection_stats(sheet, ranges)
        }
        fn find(&self, query: &FindQuery) -> EngineResult<Vec<FindMatch>> {
            self.0.find(query)
        }
        fn filter_values(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>> {
            self.0.filter_values(sheet, col, limit)
        }
        fn supports(&self, op: &EngineOp) -> bool {
            matches!(op, EngineOp::SetCells { cells, .. } if cells.iter().all(|c| !c.input.starts_with('=')))
        }
        fn apply(&mut self, ops: &[EngineOp]) -> EngineResult<ApplyOutcome> {
            self.0.apply(ops)
        }
        fn undo(&mut self) -> EngineResult<ApplyOutcome> {
            self.0.undo()
        }
        fn redo(&mut self) -> EngineResult<ApplyOutcome> {
            self.0.redo()
        }
        fn can_undo(&self) -> bool {
            self.0.can_undo()
        }
        fn can_redo(&self) -> bool {
            self.0.can_redo()
        }
        fn export_cells(&self, sheet: SheetId, visit: &mut dyn FnMut(u32, u32, &str)) -> EngineResult<()> {
            self.0.export_cells(sheet, visit)
        }
        fn write_csv(&self, sheet: SheetId, out: &mut dyn std::io::Write, options: &CsvOptions) -> EngineResult<()> {
            self.0.write_csv(sheet, out, options)
        }
    }

    #[test]
    fn unsupported_op_promotes_the_store_to_a_workbook() {
        let (sink, events) = collecting();
        let mut state = EngineState::new(sink);
        let doc = Document {
            id: 0,
            backend: Backend::Other(Box::new(FakeStore(workbook::new_workbook().unwrap()))),
            source_format: SourceFormat::Csv,
            path: Some("ventas.csv".into()),
            warnings: Vec::new(),
            csv: Some(CsvOptions::default()),
            original: None,
            dirty: false,
            loading: Arc::new(AtomicBool::new(false)),
        };
        let info = state.insert(doc);
        let sheet = info.active_sheet;
        state.apply(info.doc, &[set(sheet, 0, 0, "4")]).unwrap();
        assert_eq!(state.document_info(info.doc).unwrap().backend, BackendKind::Csv);
        let clip = state.copy(info.doc, sheet, CellRange { r0: 0, c0: 0, r1: 0, c1: 0 }).unwrap();
        assert_eq!(clip.text, "4\r\n");

        state.apply(info.doc, &[set(sheet, 0, 1, "=A1*3")]).unwrap();
        let now = state.document_info(info.doc).unwrap();
        assert_eq!(now.backend, BackendKind::Workbook);
        assert!(events.lock().unwrap().iter().any(|e| matches!(e, EngineEvent::BackendChanged { backend: BackendKind::Workbook, .. })));
        let sheet = now.active_sheet;
        let cell = state.cell(info.doc, sheet, CellAddress { row: 0, col: 1 }).unwrap();
        assert_eq!(cell.value, CellValue::Number { value: 12.0 });
        // The clip made by the store pastes into the promoted workbook.
        let paste = EngineOp::Paste {
            sheet,
            target: CellRange { r0: 5, c0: 0, r1: 5, c1: 0 },
            source: PasteSource::Internal { clip_id: clip.clip_id, cut: false },
            mode: PasteMode::All,
        };
        state.apply(info.doc, &[paste]).unwrap();
        assert_eq!(state.cell(info.doc, sheet, CellAddress { row: 5, col: 0 }).unwrap().input, "4");
    }

    #[test]
    fn engine_thread_answers_calls() {
        let (sink, _) = collecting();
        let engine = Engine::start(sink);
        let info = engine.call_blocking(|s| s.new_document()).unwrap();
        let doc = info.doc;
        let names = engine.call_blocking(move |s| s.document_info(doc).map(|i| i.sheets.len())).unwrap();
        assert_eq!(names, 1);
        assert!(function_names().iter().any(|f| f.name == "XLOOKUP"));
    }
}
