//! xlsx package fidelity layer and legacy imports (WS3).
//!
//! IronCalc reads cells/styles/merges/sizes/frozen panes/defined names/
//! conditional formatting/hyperlinks but drops charts, images, shapes,
//! comments, data validation, tables, sparklines and page setup, and writes a
//! fresh package on save. This module:
//!
//! 1. `inspect`: on open, scans the original package and reports
//!    `FidelityWarning`s, keeps the parts it can re-insert, and extracts chart
//!    anchors + chart XML (parsed by `crate::charts`), autofilter ranges and
//!    data-validation ranges so the engine can expose them.
//! 2. `post_process`: on save, takes IronCalc's fresh xlsx bytes and re-inserts
//!    the preserved parts (drawings, media, comments/VML, data validation,
//!    tables, sparklines, page setup), writes the autofilter, plus charts
//!    created/edited in Sheetlight (XML from `crate::charts`), fixing
//!    relationships and content types. Sheets are matched by
//!    `SheetSaveInfo::original_index`, so renames/reorders/deletes are safe.
//! 3. `import_xls`: legacy `.xls` -> `ImportedWorkbook` (calamine).
//!
//! Chart ids: `inspect` numbers the charts it models `1..=n` in package order
//! (`OriginalPackage::charts`). The engine keeps those ids for the document's
//! charts; on save a from-file chart that is missing from `charts` was
//! deleted, one with `from_file == false` was edited, and any other id is a
//! new chart.

mod a1;
mod drawing;
mod inspect;
mod package;
mod post;
mod xls;
mod xml;

#[cfg(test)]
mod tests;

use crate::engine::backend::ImportedWorkbook;
use crate::engine::types::{CellRange, ChartId, ChartSpec, EngineResult, FidelityWarning, SheetId};

/// What `inspect` keeps from the original package.
#[derive(Debug, Default)]
pub struct OriginalPackage {
    pub warnings: Vec<FidelityWarning>,
    /// Charts found in the file, per original sheet index, with `from_file = true`.
    /// `draft.sheet` is a placeholder (0): the engine assigns `SheetId`s.
    pub charts: Vec<(usize, ChartSpec)>,
    /// Autofilter range per original sheet index.
    pub auto_filters: Vec<(usize, CellRange)>,
    /// Data-validation ranges per original sheet index (for `cell_flag::VALIDATION`).
    pub data_validations: Vec<(usize, Vec<CellRange>)>,
    /// Package state needed by `post_process`.
    pub(crate) state: inspect::State,
}

/// One sheet of the document being saved, in final order.
#[derive(Debug, Clone)]
pub struct SheetSaveInfo {
    pub id: SheetId,
    pub name: String,
    /// Index of this sheet in the original package (None for new sheets).
    pub original_index: Option<usize>,
    pub auto_filter: Option<CellRange>,
}

/// Scans an `.xlsx` / `.xlsm` package. Fails only when the bytes are not a
/// zip package at all (IronCalc would fail too).
pub fn inspect(bytes: &[u8]) -> EngineResult<OriginalPackage> {
    inspect::inspect(bytes)
}

/// `fresh` is IronCalc's output. Returns the final package bytes.
///
/// New or edited charts the chart writer cannot serialize are left out (an
/// edited one keeps its original version); `post_process_report` also
/// returns their ids so the engine can report them as lost.
pub fn post_process(fresh: Vec<u8>, original: Option<&OriginalPackage>, sheets: &[SheetSaveInfo], charts: &[ChartSpec]) -> EngineResult<Vec<u8>> {
    post::post_process(fresh, original, sheets, charts, &crate::charts::write_chart_xml).map(|(bytes, _)| bytes)
}

/// Like `post_process`, also returning the ids of charts that could not be
/// written (new or edited charts whose XML the chart writer rejected).
pub fn post_process_report(fresh: Vec<u8>, original: Option<&OriginalPackage>, sheets: &[SheetSaveInfo], charts: &[ChartSpec]) -> EngineResult<(Vec<u8>, Vec<ChartId>)> {
    post::post_process(fresh, original, sheets, charts, &crate::charts::write_chart_xml)
}

/// Legacy `.xls` (BIFF8) -> neutral workbook.
pub fn import_xls(bytes: &[u8]) -> EngineResult<ImportedWorkbook> {
    xls::import_xls(bytes)
}
