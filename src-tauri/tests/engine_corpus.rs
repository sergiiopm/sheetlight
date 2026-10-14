//! Engine-level corpus checks through the `DocumentBackend` seam (Phase 3).
//!
//! These tests compile against `main` today but are `#[ignore]`d until the
//! IronCalc workbook backend (WS2) lands. To enable them in Phase 3:
//!
//! 1. Replace the body of `open_workbook` with the real constructor (whatever
//!    WS2 exposes to the actor, e.g. `engine::workbook::open_xlsx(path, …)`).
//! 2. Delete the `#[ignore]` attributes and add any accepted deviations to
//!    `tests/corpus/known-gaps.json` under the `workbook` section.
//!
//! Still to add once the APIs exist (tracked in tests/corpus/README.md):
//! - save round-trip: open → save via the actor (`saveDocument`) → reopen →
//!   same values, and `xlsx_package::inspect` of the saved file reports the
//!   same preserved parts (charts, images, comments, validation, autofilter);
//! - edit → recalc checks (e.g. change `Préstamo!B3` and compare `B7`).

mod common;

use std::collections::BTreeSet;
use std::path::Path;

use common::*;
use sheetlight_lib::engine::backend::DocumentBackend;
use sheetlight_lib::engine::types::{EngineError, EngineResult};

/// TODO(phase3, WS2): build the IronCalc workbook backend for `path`.
fn open_workbook(path: &Path) -> EngineResult<Box<dyn DocumentBackend>> {
    let _ = path;
    Err(EngineError::unsupported("backend de libro (WS2)"))
}

#[test]
#[ignore = "WS2: workbook backend not on main yet (see open_workbook)"]
fn workbook_backend_matches_corpus_expectations() {
    let gaps = known_gaps("workbook");
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("xlsx") {
        match open_workbook(&path) {
            Ok(backend) => check_backend(backend.as_ref(), &exp, &gaps, &mut report),
            Err(e) => report.fail(format!("{}: open failed: {e}", exp.file)),
        }
    }
    report.assert_ok("workbook backend corpus values/display/input");
}

#[test]
#[ignore = "WS2: workbook backend not on main yet (see open_workbook)"]
fn workbook_backend_reports_sheet_structure() {
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let backend = match open_workbook(&path) {
            Ok(b) => b,
            Err(e) => {
                report.fail(format!("{}: open failed: {e}", exp.file));
                continue;
            }
        };
        let sheets = backend.sheets();
        let active = sheets.iter().find(|s| s.id == backend.active_sheet()).map(|s| s.name.clone());
        report.checked += 1;
        if active != exp.active_sheet {
            report.fail(format!("{}: active sheet {active:?} != {:?}", exp.file, exp.active_sheet));
        }
        for meta in &sheets {
            let feats = exp.features.get(&meta.name).cloned().unwrap_or_default();
            let info = backend.sheet_info(meta.id).expect("sheet_info");
            let file = &exp.file;
            let name = &meta.name;
            let mut check = |ok: bool, msg: String| {
                report.checked += 1;
                if !ok {
                    report.fail(format!("{file}: {name}: {msg}"));
                }
            };
            let [fr, fc] = feats.frozen.unwrap_or([0, 0]);
            check(
                (info.frozen_rows, info.frozen_cols) == (fr, fc),
                format!("frozen {}x{} != {fr}x{fc}", info.frozen_rows, info.frozen_cols),
            );
            let want: BTreeSet<_> = feats.merges.iter().map(|m| parse_range(m)).map(|r| (r.r0, r.c0, r.r1, r.c1)).collect();
            let got: BTreeSet<_> = info.merges.iter().map(|r| (r.r0, r.c0, r.r1, r.c1)).collect();
            check(want == got, format!("merges {got:?} != {want:?}"));
            let af = info.auto_filter.as_ref().map(|a| a.range);
            check(af == feats.auto_filter.as_deref().map(parse_range), format!("autofilter {af:?} != {:?}", feats.auto_filter));
            let filtered: Vec<u32> = info.auto_filter.as_ref().map(|a| a.filtered_cols.clone()).unwrap_or_default();
            check(filtered == feats.filtered_cols, format!("filtered cols {filtered:?} != {:?}", feats.filtered_cols));
            let hidden_rows: BTreeSet<u32> =
                info.row_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
            check(
                hidden_rows == feats.hidden_rows.iter().copied().collect(),
                format!("{} hidden rows != {}", hidden_rows.len(), feats.hidden_rows.len()),
            );
            let hidden_cols: BTreeSet<u32> =
                info.col_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
            check(
                hidden_cols == feats.hidden_cols.iter().copied().collect(),
                format!("hidden cols {hidden_cols:?} != {:?}", feats.hidden_cols),
            );
            let widths = info.col_overrides.iter().filter(|o| o.size.is_some()).count() as u32;
            check(widths >= feats.col_widths, format!("{widths} column widths < {}", feats.col_widths));
        }
    }
    report.assert_ok("workbook backend sheet structure");
}
