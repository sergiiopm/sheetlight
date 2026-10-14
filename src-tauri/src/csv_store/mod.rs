//! Large-CSV fast path (WS3): a native typed-column store that implements
//! `DocumentBackend` without IronCalc, so a 1M-row CSV opens in seconds with
//! ~100 MB instead of ~940 MB.
//!
//! - Detects encoding (UTF-8 ± BOM, UTF-16LE/BE, Windows-1252), delimiter and
//!   decimal separator (`CsvOptions` fields left `None`).
//! - Parses on a background thread and publishes rows in chunks; emits
//!   `EngineEvent::LoadProgress`, `Cells` and `SheetInfo` events through the
//!   `EventSink` so the grid can scroll while loading (unloaded rows are
//!   `CellKind::Pending`).
//! - Columns are typed (f64 + number format / dictionary-encoded strings) with
//!   per-cell exceptions and a mixed fallback (`column.rs`).
//! - Supports value edits, clear, sort, filter, sizes, hidden, frozen panes,
//!   gridlines and row/col insert/delete with its own undo; other ops make
//!   `supports()` return false and the engine promotes the document to a
//!   workbook (reading the store through `export_cells` +
//!   `export_number_formats`).

mod column;
mod data;
mod loader;
mod ops;
mod parse;
mod query;
mod value;
mod write;

#[cfg(test)]
mod tests;

use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock, RwLockReadGuard};

use crate::engine::backend::{ApplyOutcome, DocumentBackend, EventSink};
use crate::engine::blocks::BlockCells;
use crate::engine::types::*;

use data::Data;
use parse::Enc;

/// The CSV store has exactly one sheet.
pub const SHEET_ID: SheetId = 1;
const SNIFF_BYTES: usize = 256 * 1024;
const DEFAULT_ROW_HEIGHT: f64 = 20.0;
const DEFAULT_COL_WIDTH: f64 = 64.0;

/// State shared with the loader thread.
pub(crate) struct Shared {
    data: RwLock<Data>,
    cancel: AtomicBool,
    done: Mutex<bool>,
    done_cv: Condvar,
    /// Rows already announced through `Cells` events.
    notified_rows: AtomicU32,
}

impl Shared {
    fn new(data: Data, done: bool) -> Self {
        Self { data: RwLock::new(data), cancel: AtomicBool::new(false), done: Mutex::new(done), done_cv: Condvar::new(), notified_rows: AtomicU32::new(0) }
    }
}

/// Resolved options of an open CSV document.
#[derive(Debug, Clone, Copy)]
pub struct Resolved {
    pub enc: Enc,
    pub delim: u8,
    pub decimal: u8,
}

impl Resolved {
    pub fn to_options(self) -> CsvOptions {
        CsvOptions {
            delimiter: Some(char::from(self.delim).to_string()),
            encoding: Some(self.enc.name().to_string()),
            decimal: Some(char::from(self.decimal).to_string()),
        }
    }
}

fn delimiter_from(option: Option<&str>) -> Option<u8> {
    match option? {
        "," => Some(b','),
        ";" => Some(b';'),
        "\t" | "\\t" | "tab" => Some(b'\t'),
        "|" => Some(b'|'),
        _ => None,
    }
}

fn decimal_from(option: Option<&str>) -> Option<u8> {
    match option? {
        "." => Some(b'.'),
        "," => Some(b','),
        _ => None,
    }
}

/// Detects (or validates) the options for `sample` (the first bytes).
pub fn detect(sample: &[u8], options: &CsvOptions, whole_file: bool) -> EngineResult<Resolved> {
    let enc = match options.encoding.as_deref() {
        Some(name) => Enc::from_name(name).ok_or_else(|| EngineError::new(EngineErrorCode::InvalidOp, format!("Codificación no admitida: {name}.")))?,
        None => parse::detect_encoding(sample),
    };
    let (text, _, _) = enc.encoding().decode(sample);
    // `decode` sniffs BOMs itself; drop a possibly cut last line.
    let text: &str = &text;
    let delim = match options.delimiter.as_deref() {
        Some(d) => delimiter_from(Some(d)).ok_or_else(|| EngineError::new(EngineErrorCode::InvalidOp, format!("Separador no admitido: {d}.")))?,
        None => parse::detect_delimiter(text, whole_file),
    };
    let decimal = match options.decimal.as_deref() {
        Some(d) => decimal_from(Some(d)).ok_or_else(|| EngineError::new(EngineErrorCode::InvalidOp, format!("Separador decimal no admitido: {d}.")))?,
        None => parse::detect_decimal(text, delim, whole_file),
    };
    Ok(Resolved { enc, delim, decimal })
}

/// Opens `path` as a CSV store. Returns immediately after detection; rows keep
/// streaming in the background. The returned options are the detected ones.
#[allow(dead_code)] // Called by the engine actor (WS2).
pub fn open(path: &str, options: &CsvOptions, doc: DocumentId, events: EventSink) -> EngineResult<(Box<dyn DocumentBackend>, CsvOptions)> {
    let mut file = std::fs::File::open(path).map_err(|e| crate::files::io_error(&e, path))?;
    let bytes_total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut sample = vec![0u8; SNIFF_BYTES];
    let mut filled = 0;
    while filled < sample.len() {
        let n = file.read(&mut sample[filled..]).map_err(|e| crate::files::io_error(&e, path))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    sample.truncate(filled);
    let resolved = detect(&sample, options, (filled as u64) >= bytes_total)?;
    // The loader re-reads from the start (simplest correct handling of BOMs
    // and records that straddle the sample boundary).
    let file = std::fs::File::open(path).map_err(|e| crate::files::io_error(&e, path))?;
    let name = sheet_name_from_path(path);
    let store = CsvStore::start(Box::new(file), name, resolved, doc, bytes_total, events);
    Ok((Box::new(store), resolved.to_options()))
}

/// Canonical cell input of a text value (shared with the `.xls` importer):
/// prefixed with `'` when the engine would otherwise read it as a number,
/// boolean, date or formula.
pub(crate) fn write_text_input(text: &str, out: &mut String) {
    if value::type_input(text) != Some(value::Typed::Text) || text.starts_with('\'') {
        out.push('\'');
    }
    out.push_str(text);
}

/// Canonical en-US input of a number (shortest round-trip form).
pub(crate) fn write_number_input(value: f64, out: &mut String) {
    value::write_canonical_number(value, out);
}

/// Excel names the sheet after the file (`ventas.csv` -> `ventas`), max 31 chars.
pub fn sheet_name_from_path(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let stem = match file.rfind('.') {
        Some(i) if i > 0 => &file[..i],
        _ => file,
    };
    let cleaned: String = stem.chars().map(|c| if "[]:*?/\\".contains(c) { '_' } else { c }).take(31).collect();
    if cleaned.trim().is_empty() {
        "Hoja1".to_string()
    } else {
        cleaned
    }
}

/// The CSV document backend.
pub struct CsvStore {
    shared: Arc<Shared>,
    doc: DocumentId,
    name: String,
    resolved: Resolved,
    undo: Vec<ops::Step>,
    redo: Vec<ops::Step>,
}

impl Drop for CsvStore {
    fn drop(&mut self) {
        self.shared.cancel.store(true, Ordering::Relaxed);
    }
}

impl CsvStore {
    fn start(file: Box<dyn Read + Send>, name: String, resolved: Resolved, doc: DocumentId, bytes_total: u64, events: EventSink) -> Self {
        let data = Data { loading: true, ..Data::default() };
        let shared = Arc::new(Shared::new(data, false));
        let params = loader::LoadParams { doc, enc: resolved.enc, delim: resolved.delim, decimal: resolved.decimal, bytes_total, events };
        let thread_shared = shared.clone();
        let spawned = std::thread::Builder::new().name("csv-loader".into()).spawn(move || loader::run(thread_shared, file, params));
        if spawned.is_err() {
            let mut data = shared.data.write().unwrap_or_else(|e| e.into_inner());
            data.loading = false;
            *shared.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        }
        Self { shared, doc, name, resolved, undo: Vec::new(), redo: Vec::new() }
    }

    /// Builds a store synchronously from in-memory text (tests, paste-as-new).
    #[allow(dead_code)] // Public API for the engine; used by tests.
    pub fn from_text(text: &str, name: &str, options: &CsvOptions) -> EngineResult<Self> {
        let resolved = detect(text.as_bytes(), options, true)?;
        let resolved = Resolved { enc: Enc::Utf8, ..resolved };
        let events: EventSink = Arc::new(|_| {});
        let reader = std::io::Cursor::new(text.as_bytes().to_vec());
        let store = Self::start(Box::new(reader), name.to_string(), resolved, 0, text.len() as u64, events);
        store.wait_loaded();
        Ok(store)
    }

    /// Sets the document id of the invalidation events in `outcome`.
    fn stamp(&self, mut outcome: ApplyOutcome) -> ApplyOutcome {
        for event in &mut outcome.events {
            match event {
                EngineEvent::Cells { doc, .. }
                | EngineEvent::SheetData { doc, .. }
                | EngineEvent::SheetInfo { doc, .. }
                | EngineEvent::Structure { doc, .. }
                | EngineEvent::Styles { doc }
                | EngineEvent::Sheets { doc, .. }
                | EngineEvent::Charts { doc, .. }
                | EngineEvent::DocState { doc, .. }
                | EngineEvent::LoadProgress { doc, .. }
                | EngineEvent::BackendChanged { doc, .. } => *doc = self.doc,
            }
        }
        outcome
    }

    #[allow(dead_code)] // Public API; used by tests.
    pub fn resolved(&self) -> Resolved {
        self.resolved
    }

    /// Blocks until the background load finished.
    pub fn wait_loaded(&self) {
        let mut done = self.shared.done.lock().unwrap_or_else(|e| e.into_inner());
        while !*done {
            done = self.shared.done_cv.wait(done).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn read(&self) -> RwLockReadGuard<'_, Data> {
        self.shared.data.read().unwrap_or_else(|e| e.into_inner())
    }

    fn check_sheet(sheet: SheetId) -> EngineResult<()> {
        if sheet == SHEET_ID {
            Ok(())
        } else {
            Err(EngineError::not_found("La hoja no existe."))
        }
    }

    /// Approximate heap use of the loaded data (bench/diagnostics).
    #[allow(dead_code)] // Diagnostics for benches.
    pub fn heap_bytes(&self) -> usize {
        self.read().heap_bytes()
    }
}

impl DocumentBackend for CsvStore {
    fn kind(&self) -> BackendKind {
        BackendKind::Csv
    }

    fn sheets(&self) -> Vec<SheetMeta> {
        vec![SheetMeta { id: SHEET_ID, name: self.name.clone(), hidden: false, color: None }]
    }

    fn active_sheet(&self) -> SheetId {
        SHEET_ID
    }

    fn loading(&self) -> bool {
        self.read().loading
    }

    fn sheet_info(&self, sheet: SheetId) -> EngineResult<SheetInfo> {
        Self::check_sheet(sheet)?;
        let data = self.read();
        let view = &data.view;
        let mut row_overrides: Vec<AxisOverride> = Vec::new();
        {
            let hidden: std::collections::BTreeSet<u32> = view.hidden_rows.iter().chain(view.filter_hidden.iter()).collect();
            let mut heights = view.row_heights.iter().peekable();
            let mut hidden_iter = hidden.into_iter().peekable();
            loop {
                let next_h = heights.peek().map(|(r, _)| **r);
                let next_x = hidden_iter.peek().copied();
                let index = match (next_h, next_x) {
                    (None, None) => break,
                    (Some(a), Some(b)) => a.min(b),
                    (Some(a), None) => a,
                    (None, Some(b)) => b,
                };
                let size = if next_h == Some(index) { heights.next().map(|(_, s)| *s) } else { None };
                let hidden = if next_x == Some(index) {
                    hidden_iter.next();
                    Some(true)
                } else {
                    None
                };
                row_overrides.push(AxisOverride { index, size, hidden });
            }
        }
        let mut col_overrides: Vec<AxisOverride> = Vec::new();
        let cols: std::collections::BTreeSet<u32> = view.col_widths.keys().copied().chain(view.hidden_cols.iter().copied()).collect();
        for c in cols {
            col_overrides.push(AxisOverride { index: c, size: view.col_widths.get(&c).copied(), hidden: view.hidden_cols.contains(&c).then_some(true) });
        }
        Ok(SheetInfo {
            sheet: SHEET_ID,
            row_count: MAX_ROWS,
            col_count: MAX_COLS,
            default_row_height: DEFAULT_ROW_HEIGHT,
            default_col_width: DEFAULT_COL_WIDTH,
            used_range: data.used_range(),
            row_overrides,
            col_overrides,
            merges: Vec::new(),
            frozen_rows: view.frozen_rows,
            frozen_cols: view.frozen_cols,
            show_grid_lines: view.show_grid_lines,
            auto_filter: view.auto_filter.map(|range| AutoFilterInfo { range, filtered_cols: view.filters.keys().copied().collect() }),
            version: data.info_version,
        })
    }

    fn write_block(&self, sheet: SheetId, key: BlockKey, cells: &mut BlockCells) -> EngineResult<()> {
        Self::check_sheet(sheet)?;
        let data = self.read();
        query::write_block(&data, key, cells);
        Ok(())
    }

    fn styles(&self, ids: &[StyleId]) -> Vec<(StyleId, CellStyle)> {
        // The store has no formatting: every cell uses style 0.
        ids.iter().map(|id| (*id, CellStyle::default())).collect()
    }

    fn find_data_edge(&self, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress> {
        Self::check_sheet(sheet)?;
        Ok(query::find_data_edge(&self.read(), from, dir))
    }

    fn column_text_samples(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>> {
        Self::check_sheet(sheet)?;
        Ok(query::column_text_samples(&self.read(), col, limit))
    }

    fn cell_details(&self, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails> {
        Self::check_sheet(sheet)?;
        Ok(query::cell_details(&self.read(), cell))
    }

    fn range_values(&self, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
        Self::check_sheet(sheet)?;
        Ok(query::range_values(&self.read(), range))
    }

    fn selection_stats(&self, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats> {
        Self::check_sheet(sheet)?;
        Ok(query::selection_stats(&self.read(), ranges))
    }

    fn find(&self, query: &FindQuery) -> EngineResult<Vec<FindMatch>> {
        if let Some(sheet) = query.sheet {
            if sheet != SHEET_ID {
                return Ok(Vec::new());
            }
        }
        Ok(query::find(&self.read(), query))
    }

    fn filter_values(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>> {
        Self::check_sheet(sheet)?;
        Ok(query::filter_values(&self.read(), col, limit))
    }

    fn supports(&self, op: &EngineOp) -> bool {
        ops::supports(op)
    }

    fn apply(&mut self, ops: &[EngineOp]) -> EngineResult<ApplyOutcome> {
        let loading = self.read().loading;
        if loading && !ops.iter().all(ops::allowed_while_loading) {
            return Err(EngineError::new(EngineErrorCode::InvalidOp, "El archivo todavía se está cargando. Espera a que termine para editarlo."));
        }
        let mut data = self.shared.data.write().unwrap_or_else(|e| e.into_inner());
        let (step, outcome) = ops::apply(&mut data, ops)?;
        drop(data);
        if !step.is_empty() {
            self.undo.push(step);
            self.redo.clear();
        }
        Ok(self.stamp(outcome))
    }

    fn undo(&mut self) -> EngineResult<ApplyOutcome> {
        let Some(step) = self.undo.pop() else {
            return Ok(ApplyOutcome::default());
        };
        let mut data = self.shared.data.write().unwrap_or_else(|e| e.into_inner());
        let outcome = ops::revert(&mut data, &step);
        drop(data);
        self.redo.push(step);
        Ok(self.stamp(outcome))
    }

    fn redo(&mut self) -> EngineResult<ApplyOutcome> {
        let Some(step) = self.redo.pop() else {
            return Ok(ApplyOutcome::default());
        };
        let mut data = self.shared.data.write().unwrap_or_else(|e| e.into_inner());
        let (new_step, outcome) = ops::apply(&mut data, &step.ops)?;
        drop(data);
        self.undo.push(new_step);
        Ok(self.stamp(outcome))
    }

    fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    fn export_cells(&self, sheet: SheetId, visit: &mut dyn FnMut(u32, u32, &str)) -> EngineResult<()> {
        Self::check_sheet(sheet)?;
        self.wait_loaded();
        write::export_cells(&self.read(), visit);
        Ok(())
    }

    fn export_number_formats(&self, sheet: SheetId, visit: &mut dyn FnMut(CellRange, &str)) -> EngineResult<()> {
        Self::check_sheet(sheet)?;
        self.wait_loaded();
        write::export_number_formats(&self.read(), visit);
        Ok(())
    }

    fn write_csv(&self, sheet: SheetId, out: &mut dyn std::io::Write, options: &CsvOptions) -> EngineResult<()> {
        Self::check_sheet(sheet)?;
        self.wait_loaded();
        let target = write::CsvTarget::resolve(options, self.resolved)?;
        write::write_csv(&self.read(), out, target)
    }
}
