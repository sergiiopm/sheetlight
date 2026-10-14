//! The seam between the engine actor (WS2) and the document backends:
//! the IronCalc workbook backend (WS2, `engine/workbook.rs`) and the large-CSV
//! typed-column store (WS3, `csv_store`). The actor routes every request for a
//! document to its `Box<dyn DocumentBackend>`.
//!
//! Promotion: before applying a batch, the actor asks `supports(op)` for each
//! op. If the CSV store cannot apply one, the actor converts the document
//! into a workbook backend (reading the store through `export_cells`),
//! emits `BackendChanged`, and applies the batch there.

use std::sync::Arc;

use super::blocks::BlockCells;
use super::types::*;

/// Pushes events to the webview (`engine://event`). Cloneable, usable from
/// background threads (CSV loader).
pub type EventSink = Arc<dyn Fn(EngineEvent) + Send + Sync>;

/// What a backend reports after applying a batch / undo / redo.
#[derive(Debug, Default)]
pub struct ApplyOutcome {
    pub selection: Option<SelectionHint>,
    /// Ids created by the batch (sheets, charts), in op order.
    pub created: Vec<u32>,
    pub affected: u64,
    /// Invalidation events to emit (cells / sheetData / sheetInfo / structure /
    /// sheets / charts). The actor adds `DocState` itself.
    pub events: Vec<EngineEvent>,
}

/// Neutral workbook produced by importers that cannot build an IronCalc model
/// themselves (legacy `.xls` via calamine). The workbook backend turns it into
/// a model.
#[derive(Debug, Default)]
pub struct ImportedWorkbook {
    pub sheets: Vec<ImportedSheet>,
}

#[derive(Debug, Default)]
pub struct ImportedSheet {
    pub name: String,
    /// (row, col, canonical input) — formulas en-US with leading `=`.
    pub cells: Vec<(u32, u32, String)>,
    /// (col, width in CSS px)
    pub col_widths: Vec<(u32, f64)>,
    pub merges: Vec<CellRange>,
    /// (range, numFmt) for cells with a non-General number format (dates).
    pub number_formats: Vec<(CellRange, String)>,
}

pub trait DocumentBackend: Send {
    fn kind(&self) -> BackendKind;
    fn sheets(&self) -> Vec<SheetMeta>;
    fn active_sheet(&self) -> SheetId;
    /// True while rows are still streaming in (CSV store). `DocumentInfo.loading`.
    fn loading(&self) -> bool {
        false
    }

    // ----- grid data ---------------------------------------------------------
    fn sheet_info(&self, sheet: SheetId) -> EngineResult<SheetInfo>;
    /// Fills `cells` (already cleared) with the display data of one block.
    fn write_block(&self, sheet: SheetId, key: BlockKey, cells: &mut BlockCells) -> EngineResult<()>;
    fn styles(&self, ids: &[StyleId]) -> Vec<(StyleId, CellStyle)>;
    fn find_data_edge(&self, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress>;
    fn column_text_samples(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>>;

    // ----- cell queries ------------------------------------------------------
    fn cell_details(&self, sheet: SheetId, cell: CellAddress) -> EngineResult<CellDetails>;
    fn range_values(&self, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues>;
    fn selection_stats(&self, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats>;
    fn find(&self, query: &FindQuery) -> EngineResult<Vec<FindMatch>>;
    fn filter_values(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>>;

    // ----- mutations ---------------------------------------------------------
    /// Whether this backend can apply `op` itself (CSV store: values, clear,
    /// sort, filter, sizes, frozen panes…; anything else triggers promotion).
    fn supports(&self, op: &EngineOp) -> bool;
    /// Applies a batch atomically as one undo step.
    fn apply(&mut self, ops: &[EngineOp]) -> EngineResult<ApplyOutcome>;
    fn undo(&mut self) -> EngineResult<ApplyOutcome>;
    fn redo(&mut self) -> EngineResult<ApplyOutcome>;
    fn can_undo(&self) -> bool;
    fn can_redo(&self) -> bool;

    // ----- export --------------------------------------------------------------
    /// Visits every non-empty cell of a sheet in row-major order with its
    /// canonical input (formula or raw value, en-US). Used for promotion and
    /// CSV export of workbooks.
    fn export_cells(&self, sheet: SheetId, visit: &mut dyn FnMut(u32, u32, &str)) -> EngineResult<()>;
    /// Visits ranges whose cells carry a non-General number format (dates,
    /// percentages) as `(range, numFmt)`. Used together with `export_cells`
    /// when promoting the CSV store, so dates stay dates. Default: none.
    fn export_number_formats(&self, sheet: SheetId, visit: &mut dyn FnMut(CellRange, &str)) -> EngineResult<()> {
        let _ = (sheet, visit);
        Ok(())
    }
    /// Writes one sheet as CSV (display values, `options` resolved by the caller).
    fn write_csv(&self, sheet: SheetId, out: &mut dyn std::io::Write, options: &CsvOptions) -> EngineResult<()>;
}
