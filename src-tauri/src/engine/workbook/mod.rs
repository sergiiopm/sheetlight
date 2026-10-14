//! IronCalc workbook backend: one `UserModel` (locale/language `en`, so
//! formulas stay en-US) plus the metadata Sheetlight models itself (comments,
//! autofilter, charts), a render style table and a batch undo history.
//!
//! Coordinates: the contract is 0-based (`u32`), IronCalc is 1-based (`i32`);
//! conversions happen at the edges of this module (`ic_row`, `ic_col`, `area`).

mod clipboard;
mod display;
mod fill;
mod functions;
mod filter;
mod find;
mod history;
mod io;
mod locale_in;
mod ops;
mod paste;
mod queries;
mod sheets;
mod sort;
mod styles;
mod units;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

use ironcalc_base::expressions::types::Area;
use ironcalc_base::types::{Style, Worksheet};
use ironcalc_base::{Model, UserModel};

use super::backend::{ApplyOutcome, DocumentBackend};
use super::blocks::BlockCells;
use super::types::*;

pub use clipboard::{take_clip, Clip};
pub use display::{format_number_es, parse_canonical, Parsed};
pub use io::{
    import_csv_small, import_workbook, load_xlsx, new_workbook, CsvImport, DEFAULT_TIMEZONE, MODEL_LANGUAGE,
    MODEL_LOCALE,
};
pub use functions::FUNCTION_NAMES;

use history::History;
use styles::StyleTable;

/// Autofilter modeled by Sheetlight (IronCalc drops `<autoFilter>`): the
/// header row is `range.r0`; rows `r0+1..=r1` are filtered.
#[derive(Debug, Clone, PartialEq)]
pub struct AutoFilter {
    pub range: CellRange,
    /// Absolute column → display values to keep visible ("" = blanks).
    pub criteria: BTreeMap<u32, Vec<String>>,
}

/// Sheetlight-owned data of one sheet. Cloned into undo snapshots.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SheetExtra {
    /// (row, col) → note text.
    pub comments: BTreeMap<(u32, u32), String>,
    pub filter: Option<AutoFilter>,
    pub charts: Vec<ChartSpec>,
    /// Index of the sheet in the original xlsx package (None for new sheets).
    pub original_index: Option<usize>,
}

/// Metadata snapshot used by undo/redo.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Meta {
    pub sheets: HashMap<SheetId, SheetExtra>,
}

/// Per-xf (IronCalc style index) info cached for rendering.
#[derive(Debug, Clone)]
struct XfInfo {
    num_fmt: String,
    quote_prefix: bool,
}

pub struct WorkbookBackend {
    um: UserModel<'static>,
    meta: Meta,
    next_chart_id: ChartId,
    /// `SheetInfo.version` per sheet (monotonic, never restored by undo).
    info_versions: HashMap<SheetId, u32>,
    styles: RefCell<StyleTable>,
    xf_cache: RefCell<HashMap<i32, XfInfo>>,
    /// Workbook default style (index 0), the reference for "absent" fields.
    base_style: Style,
    history: History,
    /// Length of `flush_send_queue()` when nothing was queued.
    empty_queue_len: usize,
    /// Identifies this backend for internal cut/paste.
    token: u64,
    /// Scratch model used to check how IronCalc would read a text input.
    scratch: RefCell<Model<'static>>,
}

static NEXT_TOKEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub(crate) fn sheet_not_found() -> EngineError {
    EngineError::not_found("La hoja no existe.")
}

/// Maps an IronCalc error string to a user-facing Spanish error.
pub(crate) fn ic_error(message: String) -> EngineError {
    let lower = message.to_lowercase();
    let text = if lower.contains("merged cell") {
        "No se puede cambiar parte de una celda combinada."
    } else if lower.contains("array formula") {
        "No se puede cambiar parte de una matriz."
    } else if lower.contains("invalid sheet") || lower.contains("invalid worksheet") {
        "La hoja no existe."
    } else if lower.contains("more than one cell with content") {
        "Solo se puede combinar si como mucho una celda tiene datos."
    } else {
        eprintln!("[engine] IronCalc error: {message}");
        "No se pudo completar la operación."
    };
    EngineError::new(EngineErrorCode::InvalidOp, text)
}

pub(crate) fn ic_row(row: u32) -> i32 {
    row as i32 + 1
}

pub(crate) fn ic_col(col: u32) -> i32 {
    col as i32 + 1
}

pub(crate) fn area(sheet_index: u32, range: &CellRange) -> Area {
    Area {
        sheet: sheet_index,
        row: ic_row(range.r0),
        column: ic_col(range.c0),
        width: (range.c1 - range.c0 + 1) as i32,
        height: (range.r1 - range.r0 + 1) as i32,
    }
}

pub(crate) fn norm(range: CellRange) -> CellRange {
    CellRange {
        r0: range.r0.min(range.r1).min(MAX_ROWS - 1),
        c0: range.c0.min(range.c1).min(MAX_COLS - 1),
        r1: range.r0.max(range.r1).min(MAX_ROWS - 1),
        c1: range.c0.max(range.c1).min(MAX_COLS - 1),
    }
}

pub(crate) fn full_cols(range: &CellRange) -> bool {
    range.r0 == 0 && range.r1 >= MAX_ROWS - 1
}

pub(crate) fn full_rows(range: &CellRange) -> bool {
    range.c0 == 0 && range.c1 >= MAX_COLS - 1
}

impl WorkbookBackend {
    /// Wraps a loaded model (no undo history). `extras` seeds per-sheet
    /// metadata by sheet index (comments are also imported from the model).
    pub fn from_model(model: Model<'static>, mut extras: Vec<SheetExtra>) -> Self {
        let base_style = styles::style_at(&model.workbook.styles, 0).unwrap_or_default();
        let mut meta = Meta::default();
        for (index, ws) in model.workbook.worksheets.iter().enumerate() {
            let mut extra = if index < extras.len() { std::mem::take(&mut extras[index]) } else { SheetExtra::default() };
            for comment in &ws.comments {
                if let Some((row, col)) = parse_a1(&comment.cell_ref) {
                    extra.comments.entry((row, col)).or_insert_with(|| comment.text.clone());
                }
            }
            meta.sheets.insert(ws.sheet_id, extra);
        }
        let mut next_chart_id = 1;
        for extra in meta.sheets.values_mut() {
            for chart in &mut extra.charts {
                chart.id = next_chart_id;
                next_chart_id += 1;
            }
        }
        let mut um = UserModel::from_model(model);
        let _ = um.flush_send_queue();
        let empty_queue_len = um.flush_send_queue().len();
        #[allow(clippy::expect_used)]
        let scratch = Model::new_empty("scratch", MODEL_LOCALE, "UTC", MODEL_LANGUAGE).expect("scratch model");
        Self {
            um,
            meta,
            next_chart_id,
            info_versions: HashMap::new(),
            styles: RefCell::new(StyleTable::default()),
            xf_cache: RefCell::new(HashMap::new()),
            base_style,
            history: History::default(),
            empty_queue_len,
            token: NEXT_TOKEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            scratch: RefCell::new(scratch),
        }
    }

    pub fn model(&self) -> &Model<'_> {
        self.um.get_model()
    }

    pub fn token(&self) -> u64 {
        self.token
    }

    pub(crate) fn sheet_index(&self, sheet: SheetId) -> EngineResult<u32> {
        self.model()
            .workbook
            .worksheets
            .iter()
            .position(|ws| ws.sheet_id == sheet)
            .map(|i| i as u32)
            .ok_or_else(sheet_not_found)
    }

    pub(crate) fn worksheet(&self, sheet: SheetId) -> EngineResult<&Worksheet> {
        let index = self.sheet_index(sheet)?;
        Ok(&self.model().workbook.worksheets[index as usize])
    }

    pub(crate) fn sheet_id_at(&self, index: u32) -> Option<SheetId> {
        self.model().workbook.worksheets.get(index as usize).map(|ws| ws.sheet_id)
    }

    pub(crate) fn extra(&self, sheet: SheetId) -> Option<&SheetExtra> {
        self.meta.sheets.get(&sheet)
    }

    pub(crate) fn extra_mut(&mut self, sheet: SheetId) -> &mut SheetExtra {
        self.meta.sheets.entry(sheet).or_default()
    }

    pub(crate) fn bump_info(&mut self, sheet: SheetId) -> u32 {
        let version = self.info_versions.entry(sheet).or_insert(0);
        *version += 1;
        *version
    }

    pub(crate) fn info_version(&self, sheet: SheetId) -> u32 {
        self.info_versions.get(&sheet).copied().unwrap_or(0)
    }

    /// Number format and quote-prefix flag of an IronCalc style index.
    fn xf_info(&self, xf: i32) -> XfInfo {
        if let Some(info) = self.xf_cache.borrow().get(&xf) {
            return info.clone();
        }
        let style = styles::style_at(&self.model().workbook.styles, xf).unwrap_or_default();
        let info = XfInfo { num_fmt: style.num_fmt.clone(), quote_prefix: style.quote_prefix };
        self.xf_cache.borrow_mut().insert(xf, info.clone());
        info
    }

    /// Render style id of an IronCalc style index (+ number-format color).
    fn render_style_id(&self, xf: i32, nf_color: Option<&'static str>) -> StyleId {
        if xf == 0 && nf_color.is_none() {
            return 0;
        }
        if let Some(id) = self.styles.borrow().cached_xf(xf, nf_color) {
            return id;
        }
        let model = self.model();
        let style = styles::style_at(&model.workbook.styles, xf).unwrap_or_default();
        let cell_style = styles::to_cell_style(&style, &self.base_style, &model.workbook.theme, nf_color);
        let mut table = self.styles.borrow_mut();
        let id = table.intern(cell_style);
        table.cache_xf(xf, nf_color, id);
        id
    }

    /// Render style id of a fully resolved style (conditional formatting).
    fn render_style_id_for(&self, style: &Style, nf_color: Option<&'static str>) -> StyleId {
        let cell_style = styles::to_cell_style(style, &self.base_style, &self.model().workbook.theme, nf_color);
        self.styles.borrow_mut().intern(cell_style)
    }

    pub fn charts(&self, sheet: SheetId) -> Vec<ChartSpec> {
        self.extra(sheet).map(|e| e.charts.clone()).unwrap_or_default()
    }

    pub fn all_charts(&self) -> Vec<ChartSpec> {
        let mut charts = Vec::new();
        for ws in &self.model().workbook.worksheets {
            if let Some(extra) = self.extra(ws.sheet_id) {
                charts.extend(extra.charts.iter().cloned());
            }
        }
        charts
    }

    /// (sheet id, name, original index, autofilter) in workbook order, for saving.
    pub fn save_sheets(&self) -> Vec<(SheetId, String, Option<usize>, Option<CellRange>)> {
        self.model()
            .workbook
            .worksheets
            .iter()
            .map(|ws| {
                let extra = self.extra(ws.sheet_id);
                (
                    ws.sheet_id,
                    ws.name.clone(),
                    extra.and_then(|e| e.original_index),
                    extra.and_then(|e| e.filter.as_ref().map(|f| f.range)),
                )
            })
            .collect()
    }

    /// Fresh xlsx bytes from IronCalc (before `xlsx_package::post_process`).
    pub fn xlsx_bytes(&self) -> EngineResult<Vec<u8>> {
        io::export_xlsx(self.model())
    }
}

/// `"B7"` → (6, 1), 0-based.
pub(crate) fn parse_a1(text: &str) -> Option<(u32, u32)> {
    let text = text.trim().trim_start_matches('$');
    let split = text.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = text.split_at(split);
    let letters = letters.trim_end_matches('$');
    if letters.is_empty() || letters.len() > 3 {
        return None;
    }
    let mut col: u32 = 0;
    for ch in letters.chars() {
        if !ch.is_ascii_alphabetic() {
            return None;
        }
        col = col * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 || row > MAX_ROWS || col == 0 || col > MAX_COLS {
        return None;
    }
    Some((row - 1, col - 1))
}

/// 0 → "A".
pub(crate) fn col_name(col: u32) -> String {
    let mut n = col + 1;
    let mut out = Vec::new();
    while n > 0 {
        let m = (n - 1) % 26;
        out.push(b'A' + m as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

impl DocumentBackend for WorkbookBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Workbook
    }

    fn sheets(&self) -> Vec<SheetMeta> {
        self.sheet_metas()
    }

    fn active_sheet(&self) -> SheetId {
        let index = self.um.get_selected_sheet();
        self.sheet_id_at(index).or_else(|| self.sheet_id_at(0)).unwrap_or(0)
    }

    fn sheet_info(&self, sheet: SheetId) -> EngineResult<SheetInfo> {
        self.sheet_info_impl(sheet)
    }

    fn write_block(&self, sheet: SheetId, key: BlockKey, cells: &mut BlockCells) -> EngineResult<()> {
        self.write_block_impl(sheet, key, cells)
    }

    fn styles(&self, ids: &[StyleId]) -> Vec<(StyleId, CellStyle)> {
        let table = self.styles.borrow();
        ids.iter().filter_map(|id| table.get(*id).map(|s| (*id, s.clone()))).collect()
    }

    fn find_data_edge(&self, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress> {
        self.find_data_edge_impl(sheet, from, dir)
    }

    fn column_text_samples(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>> {
        self.column_text_samples_impl(sheet, col, limit)
    }

    fn cell_details(&self, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails> {
        self.cell_details_impl(sheet, cell)
    }

    fn range_values(&self, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
        self.range_values_impl(sheet, range)
    }

    fn selection_stats(&self, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats> {
        self.selection_stats_impl(sheet, ranges)
    }

    fn find(&self, query: &FindQuery) -> EngineResult<Vec<FindMatch>> {
        self.find_impl(query)
    }

    fn filter_values(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>> {
        self.filter_values_impl(sheet, col, limit)
    }

    fn supports(&self, _op: &EngineOp) -> bool {
        true
    }

    fn apply(&mut self, ops: &[EngineOp]) -> EngineResult<ApplyOutcome> {
        self.apply_batch(ops)
    }

    fn undo(&mut self) -> EngineResult<ApplyOutcome> {
        self.undo_impl()
    }

    fn redo(&mut self) -> EngineResult<ApplyOutcome> {
        self.redo_impl()
    }

    fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    fn export_cells(&self, sheet: SheetId, visit: &mut dyn FnMut(u32, u32, &str)) -> EngineResult<()> {
        self.export_cells_impl(sheet, visit)
    }

    fn write_csv(&self, sheet: SheetId, out: &mut dyn std::io::Write, options: &CsvOptions) -> EngineResult<()> {
        self.write_csv_impl(sheet, out, options)
    }
}
