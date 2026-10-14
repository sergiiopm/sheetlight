//! DrawingML chart XML <-> `ChartDraft` (WS6). Pure functions, no package
//! plumbing: `crate::xlsx_package` finds chart parts and anchors on open and
//! assembles drawing/chart parts on save.
//!
//! Phase 1: signatures only.

use crate::engine::types::{ChartDraft, ChartSpec, EngineError, EngineResult};

/// Parses a `xl/charts/chartN.xml` part. The anchor and sheet in the returned
/// draft are placeholders; the caller fills them from the drawing part.
/// Returns `Ok(None)` for chart kinds Sheetlight does not model (they are
/// still preserved byte-for-byte when untouched).
pub fn parse_chart_xml(xml: &str) -> EngineResult<Option<ChartDraft>> {
    let _ = xml;
    Ok(None)
}

/// Writes a chart part for a chart created or edited in Sheetlight.
/// `sheet_name` is used to qualify unqualified references.
pub fn write_chart_xml(chart: &ChartSpec, sheet_name: &str) -> EngineResult<String> {
    let _ = (chart, sheet_name);
    Err(EngineError::unsupported("guardar gráficos"))
}
