//! Large-CSV fast path (WS3): a native typed-column store that implements
//! `DocumentBackend` without IronCalc, so a 1M-row CSV opens in seconds with
//! ~100–150 MB instead of ~940 MB.
//!
//! - Detects encoding (UTF-8 ± BOM, UTF-16LE, Windows-1252), delimiter and
//!   decimal separator (`CsvOptions` fields left `None`).
//! - Parses on a background thread and publishes rows in chunks; emits
//!   `EngineEvent::LoadProgress` and `Cells` events through the `EventSink`
//!   so the grid can scroll while loading (unloaded rows are `CellKind::Pending`).
//! - Columns are typed (f64 / date serial / dictionary-encoded strings).
//! - Supports value edits, clear, sort, filter, sizes and frozen panes with
//!   its own undo; other ops make `supports()` return false and the engine
//!   promotes the document to a workbook.
//!
//! Phase 1: signature only.

use crate::engine::backend::{DocumentBackend, EventSink};
use crate::engine::types::{CsvOptions, DocumentId, EngineError, EngineResult};

/// Opens `path` as a CSV store. Returns immediately after detection; rows keep
/// streaming in the background. The returned options are the detected ones.
pub fn open(
    path: &str,
    options: &CsvOptions,
    doc: DocumentId,
    events: EventSink,
) -> EngineResult<(Box<dyn DocumentBackend>, CsvOptions)> {
    let _ = (path, options, doc, events);
    Err(EngineError::unsupported("abrir CSV"))
}
