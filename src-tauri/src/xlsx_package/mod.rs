//! xlsx package fidelity layer and legacy imports (WS3).
//!
//! IronCalc reads cells/styles/merges/sizes/frozen panes/defined names but
//! drops charts, images, shapes, comments, data validation and autofilter, and
//! writes a fresh package on save. This module:
//!
//! 1. `inspect`: on open, scans the original package and reports
//!    `FidelityWarning`s, keeps the parts it can re-insert, and extracts chart
//!    anchors + chart XML (parsed by `crate::charts`), autofilter ranges and
//!    data-validation blocks so the engine can expose them.
//! 2. `post_process`: on save, takes IronCalc's fresh xlsx bytes and re-inserts
//!    the preserved parts (drawings, media, comments/VML, data validation,
//!    autofilter, unknown parts), plus charts created/edited in Sheetlight
//!    (XML from `crate::charts`), fixing relationships and content types.
//!    Sheets are matched by `SheetId`, so renames/reorders/deletes are safe.
//! 3. `import_xls`: legacy `.xls` → `ImportedWorkbook` (calamine).
//!
//! Phase 1: signatures only.

use crate::engine::backend::ImportedWorkbook;
use crate::engine::types::{CellRange, ChartSpec, EngineError, EngineResult, FidelityWarning, SheetId};

/// What `inspect` keeps from the original package.
#[derive(Debug, Default)]
pub struct OriginalPackage {
    pub warnings: Vec<FidelityWarning>,
    /// Charts found in the file, per original sheet index, with `from_file = true`.
    /// The engine assigns `SheetId`s and chart ids when building the document.
    pub charts: Vec<(usize, ChartSpec)>,
    /// Autofilter range per original sheet index.
    pub auto_filters: Vec<(usize, CellRange)>,
    // WS3: preserved parts, relationships, per-sheet XML fragments…
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

pub fn inspect(bytes: &[u8]) -> EngineResult<OriginalPackage> {
    let _ = bytes;
    Ok(OriginalPackage::default())
}

/// `fresh` is IronCalc's output. Returns the final package bytes.
pub fn post_process(
    fresh: Vec<u8>,
    original: Option<&OriginalPackage>,
    sheets: &[SheetSaveInfo],
    charts: &[ChartSpec],
) -> EngineResult<Vec<u8>> {
    let _ = (original, sheets, charts);
    Ok(fresh)
}

pub fn import_xls(bytes: &[u8]) -> EngineResult<ImportedWorkbook> {
    let _ = bytes;
    Err(EngineError::unsupported("abrir archivos .xls"))
}
