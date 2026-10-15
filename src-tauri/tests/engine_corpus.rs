//! Engine-level corpus checks: every committed workbook (.xlsx and legacy
//! .xls) is opened through the engine actor (`openDocument`, exactly the path
//! the app takes) and compared with `tests/corpus/files/*.expected.json`:
//! values, es display strings, formula inputs, sheet structure and the
//! fidelity warnings shown in the open banner.
//!
//! Accepted deviations live in `tests/corpus/known-gaps.json` (sections
//! `workbook` and `fidelity`). Each check has an `#[ignore]`d strict twin that
//! fails while any of its known gaps is still open:
//! `cargo test --test engine_corpus -- --ignored`.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::actor::Actor;
use common::*;
use sheetlight_lib::engine::types::{FidelityFeature, OnSave, SourceFormat};

fn workbooks() -> Vec<(std::path::PathBuf, Expected)> {
    corpus_files().into_iter().filter(|(_, e)| e.kind == "xlsx" || e.kind == "xls").collect()
}

fn values_display_input(gaps: &BTreeMap<String, String>) -> Report {
    let actor = Actor::start();
    let mut report = Report::default();
    for (path, exp) in workbooks() {
        let info = match actor.open(&path) {
            Ok(info) => info,
            Err(e) => {
                report.fail(format!("{}: open failed: {e}", exp.file));
                continue;
            }
        };
        report.checked += 1;
        let want_format = if exp.kind == "xls" { SourceFormat::Xls } else { SourceFormat::Xlsx };
        if info.source_format != want_format {
            report.fail(format!("{}: sourceFormat {:?}", exp.file, info.source_format));
        }
        let doc = info.doc;
        let get = |sheet, at| actor.try_cell(doc, sheet, at);
        check_cells(&info.sheets, info.active_sheet, &get, &exp, gaps, &mut report);
        actor.close(doc);
    }
    report
}

#[test]
fn workbook_backend_matches_corpus_expectations() {
    values_display_input(&known_gaps("workbook")).assert_ok("workbook backend corpus values/display/input");
}

#[test]
#[ignore = "strict twin: fails while tests/corpus/known-gaps.json `workbook` has open bugs"]
fn workbook_backend_matches_corpus_expectations_strict() {
    values_display_input(&known_gaps("workbook")).assert_no_known_gaps("workbook backend corpus (strict)");
}

fn sheet_structure(gaps: &BTreeMap<String, String>) -> Report {
    let actor = Actor::start();
    let mut report = Report::default();
    for (path, exp) in workbooks() {
        let info = match actor.open(&path) {
            Ok(info) => info,
            Err(e) => {
                report.fail(format!("{}: open failed: {e}", exp.file));
                continue;
            }
        };
        let active = info.sheets.iter().find(|s| s.id == info.active_sheet).map(|s| s.name.clone());
        report.checked += 1;
        if active != exp.active_sheet {
            report.fail(format!("{}: active sheet {active:?} != {:?}", exp.file, exp.active_sheet));
        }
        for meta in &info.sheets {
            let feats = exp.features.get(&meta.name).cloned().unwrap_or_default();
            let si = actor.sheet_info(info.doc, meta.id);
            let file = exp.file.as_str();
            let name = meta.name.as_str();
            let mut check = |what: &str, ok: bool, msg: String| {
                report.checked += 1;
                let problems = if ok { Vec::new() } else { vec![msg] };
                report.record(gaps, file, &format!("{name}!@{what}"), problems, "");
            };
            let [fr, fc] = feats.frozen.unwrap_or([0, 0]);
            // The .xls importer does not read panes (see xlsx_package/xls.rs).
            if exp.kind == "xlsx" {
                check(
                    "frozen",
                    (si.frozen_rows, si.frozen_cols) == (fr, fc),
                    format!("frozen {}x{} != {fr}x{fc}", si.frozen_rows, si.frozen_cols),
                );
            }
            let want: BTreeSet<_> = feats.merges.iter().map(|m| parse_range(m)).map(|r| (r.r0, r.c0, r.r1, r.c1)).collect();
            let got: BTreeSet<_> = si.merges.iter().map(|r| (r.r0, r.c0, r.r1, r.c1)).collect();
            check("merges", want == got, format!("merges {got:?} != {want:?}"));
            let af = si.auto_filter.as_ref().map(|a| a.range);
            check(
                "autoFilter",
                af == feats.auto_filter.as_deref().map(parse_range),
                format!("autofilter {af:?} != {:?}", feats.auto_filter),
            );
            let filtered: Vec<u32> = si.auto_filter.as_ref().map(|a| a.filtered_cols.clone()).unwrap_or_default();
            check("filteredCols", filtered == feats.filtered_cols, format!("filtered cols {filtered:?} != {:?}", feats.filtered_cols));
            let hidden_rows: BTreeSet<u32> = si.row_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
            check(
                "hiddenRows",
                hidden_rows == feats.hidden_rows.iter().copied().collect(),
                format!("{} hidden rows != {}", hidden_rows.len(), feats.hidden_rows.len()),
            );
            let hidden_cols: BTreeSet<u32> = si.col_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
            check(
                "hiddenCols",
                hidden_cols == feats.hidden_cols.iter().copied().collect(),
                format!("hidden cols {hidden_cols:?} != {:?}", feats.hidden_cols),
            );
            let widths = si.col_overrides.iter().filter(|o| o.size.is_some()).count() as u32;
            check("colWidths", widths >= feats.col_widths, format!("{widths} column widths < {}", feats.col_widths));
        }
        actor.close(info.doc);
    }
    report
}

#[test]
fn workbook_backend_reports_sheet_structure() {
    sheet_structure(&known_gaps("workbook")).assert_ok("workbook backend sheet structure");
}

#[test]
#[ignore = "strict twin: fails while tests/corpus/known-gaps.json `workbook` has open bugs"]
fn workbook_backend_reports_sheet_structure_strict() {
    sheet_structure(&known_gaps("workbook")).assert_no_known_gaps("workbook backend sheet structure (strict)");
}

fn feature_key(f: FidelityFeature) -> String {
    serde_json::to_value(f).unwrap().as_str().unwrap().to_string()
}

/// `DocumentInfo.warnings` (the open banner) lists every feature the file has
/// that Sheetlight cannot fully round-trip, and nothing the file does not have.
fn fidelity_warnings(gaps: &BTreeMap<String, String>) -> Report {
    let actor = Actor::start();
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let info = actor.open(&path).unwrap_or_else(|e| panic!("{}: {e}", exp.file));
        let found: BTreeMap<String, (u32, OnSave)> =
            info.warnings.iter().map(|w| (feature_key(w.feature), (w.count, w.on_save))).collect();
        for (feature, count) in &exp.fidelity {
            report.checked += 1;
            let problems = match found.get(feature) {
                None => vec![format!("no warning for `{feature}` ({count} in file)")],
                // Counts are only pinned where they are unambiguous.
                Some((n, _)) if ["charts", "images", "comments"].contains(&feature.as_str()) && n != count => {
                    vec![format!("`{feature}` count {n} != {count}")]
                }
                _ => Vec::new(),
            };
            report.record(gaps, &exp.file, &format!("@{feature}"), problems, "");
        }
        for feature in found.keys() {
            report.checked += 1;
            let problems = if exp.fidelity.contains_key(feature) {
                Vec::new()
            } else {
                vec![format!("warning for `{feature}`, which the file does not have")]
            };
            report.record(gaps, &exp.file, &format!("@{feature}"), problems, "");
        }
        // Charts from the file reach the chart layer (`getCharts`).
        let charts: u32 = exp.features.values().map(|f| f.charts).sum();
        let mut got = 0;
        for meta in &info.sheets {
            let (doc, sheet) = (info.doc, meta.id);
            got += actor.call(move |s| s.charts(doc, sheet)).expect("getCharts").len() as u32;
        }
        report.checked += 1;
        let problems = if got == charts { Vec::new() } else { vec![format!("getCharts returned {got}, file has {charts}")] };
        report.record(gaps, &exp.file, "@getCharts", problems, "");
        actor.close(info.doc);
    }
    report
}

#[test]
fn open_reports_fidelity_warnings() {
    fidelity_warnings(&known_gaps("fidelity")).assert_ok("fidelity warnings on open");
}

#[test]
#[ignore = "strict twin: fails while tests/corpus/known-gaps.json `fidelity` has open bugs"]
fn open_reports_fidelity_warnings_strict() {
    fidelity_warnings(&known_gaps("fidelity")).assert_no_known_gaps("fidelity warnings on open (strict)");
}

#[test]
fn opening_a_missing_or_foreign_file_fails_in_spanish() {
    let actor = Actor::start();
    let missing = files_dir().join("no_existe.xlsx");
    let err = actor.open(&missing).expect_err("missing file must fail");
    assert_eq!(err.code, sheetlight_lib::engine::types::EngineErrorCode::NotFound);
    assert!(err.message.contains("archivo"), "Spanish message: {}", err.message);

    // A CSV renamed to .xlsx is not a zip package.
    let dir = common::actor::scratch_dir("foreign");
    let fake = dir.join("falso.xlsx");
    std::fs::copy(files_dir().join("sensores_iso.csv"), &fake).unwrap();
    let err = actor.open(&fake).expect_err("not a zip package");
    assert!(!err.message.is_empty() && !err.message.contains("Error:"), "user-facing message: {}", err.message);

    // An .xlsx renamed to .xls gets the dedicated hint.
    let renamed = dir.join("renombrado.xls");
    std::fs::copy(files_dir().join("facturas.xlsx"), &renamed).unwrap();
    let err = actor.open(&renamed).expect_err(".xlsx bytes behind .xls");
    assert!(err.message.contains(".xlsx"), "hint to rename: {}", err.message);
}
