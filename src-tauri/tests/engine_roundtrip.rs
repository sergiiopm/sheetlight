//! Open → edit → save → reopen round trips through the engine actor, for
//! every corpus file and every save path the app offers (xlsx → xlsx,
//! xls → xlsx, csv → csv, csv → xlsx), plus edit/recalc/undo on real files
//! and the fidelity report of a save (`SaveResult.lost`).
//!
//! Reopened files are compared with the corpus expectations (gaps from the
//! `workbook` and `roundtrip` sections of known-gaps.json) and with what the
//! original open reported (structure and warnings), so a save regression
//! shows up even where the expectation itself is a known gap.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use common::actor::{scratch_dir, Actor};
use common::*;
use sheetlight_lib::engine::types::*;

fn gaps(sections: &[&str]) -> BTreeMap<String, String> {
    sections.iter().flat_map(|s| known_gaps(s)).collect()
}

fn values_only() -> CheckWhat {
    CheckWhat { display: false, input: false }
}

/// Structure that a save must keep, as reported by `getSheetInfo`.
#[derive(Debug, PartialEq)]
struct Shape {
    name: String,
    frozen: (u32, u32),
    merges: BTreeSet<(u32, u32, u32, u32)>,
    auto_filter: Option<(u32, u32, u32, u32)>,
    hidden_rows: BTreeSet<u32>,
    hidden_cols: BTreeSet<u32>,
    col_widths: usize,
}

fn shapes(actor: &Actor, info: &DocumentInfo) -> Vec<Shape> {
    info.sheets
        .iter()
        .map(|m| {
            let si = actor.sheet_info(info.doc, m.id);
            Shape {
                name: m.name.clone(),
                frozen: (si.frozen_rows, si.frozen_cols),
                merges: si.merges.iter().map(|r| (r.r0, r.c0, r.r1, r.c1)).collect(),
                auto_filter: si.auto_filter.as_ref().map(|a| (a.range.r0, a.range.c0, a.range.r1, a.range.c1)),
                hidden_rows: si.row_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect(),
                hidden_cols: si.col_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect(),
                col_widths: si.col_overrides.iter().filter(|o| o.size.is_some()).count(),
            }
        })
        .collect()
}

fn compare_shapes(report: &mut Report, gaps: &BTreeMap<String, String>, file: &str, before: &[Shape], after: &[Shape]) {
    report.checked += 1;
    let names = |s: &[Shape]| s.iter().map(|x| x.name.clone()).collect::<Vec<_>>();
    if names(before) != names(after) {
        report.fail(format!("{file}: sheets {:?} became {:?}", names(before), names(after)));
        return;
    }
    for (b, a) in before.iter().zip(after) {
        let mut each = |what: &str, ok: bool, msg: String| {
            report.checked += 1;
            report.record(gaps, file, &format!("{}!@roundtrip:{what}", b.name), if ok { vec![] } else { vec![msg] }, "");
        };
        each("frozen", a.frozen == b.frozen, format!("frozen {:?} -> {:?}", b.frozen, a.frozen));
        each("merges", a.merges == b.merges, format!("merges {:?} -> {:?}", b.merges, a.merges));
        each("autoFilter", a.auto_filter == b.auto_filter, format!("autofilter {:?} -> {:?}", b.auto_filter, a.auto_filter));
        each("hiddenRows", a.hidden_rows == b.hidden_rows, format!("{} hidden rows -> {}", b.hidden_rows.len(), a.hidden_rows.len()));
        each("hiddenCols", a.hidden_cols == b.hidden_cols, format!("hidden cols {:?} -> {:?}", b.hidden_cols, a.hidden_cols));
        each("colWidths", a.col_widths >= b.col_widths, format!("{} column widths -> {}", b.col_widths, a.col_widths));
    }
}

/// Puts a marker in an empty cell right of the used range of the active
/// sheet (one undo step) and returns (sheet name, row, col).
fn mark(actor: &Actor, info: &DocumentInfo) -> (String, u32, u32) {
    let sheet = info.active_sheet;
    let used = actor.sheet_info(info.doc, sheet).used_range;
    let col = used.map(|u| u.c1 + 2).unwrap_or(0);
    let result = actor.set(info.doc, sheet, 0, col, MARKER);
    assert!(result.dirty && result.can_undo, "an edit makes the document dirty and undoable");
    let name = info.sheets.iter().find(|s| s.id == sheet).map(|s| s.name.clone()).unwrap_or_default();
    (name, 0, col)
}

const MARKER: &str = "Revisado por QA — ñandú €";

fn check_marker(actor: &Actor, info: &DocumentInfo, at: (String, u32, u32), report: &mut Report, gaps: &BTreeMap<String, String>, file: &str) {
    report.checked += 1;
    // Sheet ids are per document: find the marked sheet again by name.
    let sheet = info.sheets.iter().find(|s| s.name == at.0).map(|s| s.id).unwrap_or(info.active_sheet);
    let got = actor.cell(info.doc, sheet, at.1, at.2).value;
    let problems = if got == (CellValue::Text { value: MARKER.into() }) { vec![] } else { vec![format!("edited cell not saved: {got:?}")] };
    report.record(gaps, file, "@roundtrip:edit", problems, "");
}

fn saved_path(dir: &Path, file: &str, ext: &str) -> PathBuf {
    dir.join(format!("{}.{ext}", Path::new(file).file_stem().unwrap().to_string_lossy()))
}

// ---------------------------------------------------------------------------
// Workbooks
// ---------------------------------------------------------------------------

fn workbook_roundtrip(kind: &str, gaps: &BTreeMap<String, String>) -> Report {
    let actor = Actor::start();
    let dir = scratch_dir(&format!("roundtrip-{kind}"));
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind(kind) {
        let file = exp.file.as_str();
        let info = actor.open(&path).unwrap_or_else(|e| panic!("{file}: open: {e}"));
        let before = shapes(&actor, &info);
        let marker = mark(&actor, &info);
        let out = saved_path(&dir, file, "xlsx");
        let saved = actor.save_as(info.doc, &out, SaveFormat::Xlsx);

        report.checked += 1;
        let want_lost: std::collections::HashSet<FidelityFeature> =
            info.warnings.iter().filter(|w| w.on_save == OnSave::Lost).map(|w| w.feature).collect();
        let lost: std::collections::HashSet<FidelityFeature> = saved.lost.iter().copied().collect();
        if lost != want_lost {
            report.fail(format!("{file}: SaveResult.lost {lost:?} != warnings marked lost {want_lost:?}"));
        }
        report.checked += 1;
        let after_save = actor.info(info.doc);
        if after_save.dirty || after_save.path.as_deref() != Some(out.to_str().unwrap()) {
            report.fail(format!("{file}: after save dirty={} path={:?}", after_save.dirty, after_save.path));
        }

        let reopened = match actor.open(&out) {
            Ok(r) => r,
            Err(e) => {
                report.fail(format!("{file}: reopen of the saved .xlsx failed: {e}"));
                continue;
            }
        };
        report.checked += 1;
        if reopened.source_format != SourceFormat::Xlsx {
            report.fail(format!("{file}: saved file reopens as {:?}", reopened.source_format));
        }
        let doc = reopened.doc;
        let get = |sheet, at| actor.try_cell(doc, sheet, at);
        check_cells_with(&reopened.sheets, reopened.active_sheet, &get, &exp, gaps, &mut report, CHECK_ALL, " (reopened)");
        compare_shapes(&mut report, gaps, file, &before, &shapes(&actor, &reopened));
        check_marker(&actor, &reopened, marker, &mut report, gaps, file);

        // Everything the open banner promised to keep is still in the file.
        for w in info.warnings.iter().filter(|w| w.on_save != OnSave::Lost) {
            report.checked += 1;
            let kept = reopened.warnings.iter().any(|r| r.feature == w.feature);
            let key = format!("@roundtrip:{}", serde_json::to_value(w.feature).unwrap().as_str().unwrap());
            let problems = if kept { vec![] } else { vec![format!("{:?} was {:?} on save but is gone", w.feature, w.on_save)] };
            report.record(gaps, file, &key, problems, "");
        }
        actor.close(info.doc);
        actor.close(doc);
    }
    report
}

#[test]
fn xlsx_open_edit_save_reopen() {
    workbook_roundtrip("xlsx", &gaps(&["workbook", "roundtrip"])).assert_ok("xlsx round trip");
}

#[test]
#[ignore = "strict twin: fails while known-gaps.json `workbook`/`roundtrip` has open bugs"]
fn xlsx_open_edit_save_reopen_strict() {
    workbook_roundtrip("xlsx", &gaps(&["workbook", "roundtrip"])).assert_no_known_gaps("xlsx round trip (strict)");
}

#[test]
fn xls_open_edit_save_as_xlsx_reopen() {
    workbook_roundtrip("xls", &gaps(&["workbook", "roundtrip"])).assert_ok(".xls -> .xlsx round trip");
}

#[test]
#[ignore = "strict twin: fails while known-gaps.json `workbook`/`roundtrip` has open bugs"]
fn xls_open_edit_save_as_xlsx_reopen_strict() {
    workbook_roundtrip("xls", &gaps(&["workbook", "roundtrip"])).assert_no_known_gaps(".xls round trip (strict)");
}

#[test]
fn saving_twice_is_stable() {
    // Save → reopen → save again: the second package must reopen identically
    // (no drift in parts re-inserted by the fidelity layer).
    let actor = Actor::start();
    let dir = scratch_dir("save-twice");
    let path = files_dir().join("informe_ventas.xlsx");
    let first = actor.open(&path).unwrap();
    let a = dir.join("a.xlsx");
    actor.save_as(first.doc, &a, SaveFormat::Xlsx);
    let second = actor.open(&a).unwrap();
    let b = dir.join("b.xlsx");
    actor.save_as(second.doc, &b, SaveFormat::Xlsx);
    let third = actor.open(&b).unwrap();
    let features = |i: &DocumentInfo| i.warnings.iter().map(|w| (w.feature, w.count, w.on_save)).collect::<Vec<_>>();
    assert_eq!(features(&second), features(&third), "warnings drift between saves");
    assert_eq!(shapes(&actor, &second), shapes(&actor, &third));
    let exp = load_expected(&files_dir().join("informe_ventas.xlsx.expected.json"));
    let mut report = Report::default();
    let get = |sheet, at| actor.try_cell(third.doc, sheet, at);
    check_cells_with(&third.sheets, third.active_sheet, &get, &exp, &gaps(&["workbook", "roundtrip"]), &mut report, CHECK_ALL, " (saved twice)");
    report.assert_ok("informe_ventas saved twice");
}

#[test]
fn saving_a_workbook_as_csv_reports_what_is_lost() {
    let actor = Actor::start();
    let dir = scratch_dir("lost");
    let info = actor.open(&files_dir().join("informe_ventas.xlsx")).unwrap();
    let out = dir.join("informe.csv");
    let saved = actor.save_as(info.doc, &out, SaveFormat::Csv);
    // Only one sheet's values survive: every warned feature plus the other sheets.
    for w in &info.warnings {
        assert!(saved.lost.contains(&w.feature), "{:?} must be reported lost by a CSV save", w.feature);
    }
    assert!(saved.lost.contains(&FidelityFeature::Other), "other sheets are lost");
    let text = std::fs::read(&out).unwrap();
    assert!(!text.is_empty(), "CSV written");
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

fn csv_roundtrip(to: SaveFormat, gaps: &BTreeMap<String, String>) -> Report {
    let actor = Actor::start();
    let ext = if to == SaveFormat::Csv { "csv" } else { "xlsx" };
    let dir = scratch_dir(&format!("csv-to-{ext}"));
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("csv") {
        let file = exp.file.as_str();
        let info = actor.open(&path).unwrap_or_else(|e| panic!("{file}: open: {e}"));
        let marker = mark(&actor, &info);
        let out = saved_path(&dir, file, ext);
        let saved = actor.save_as(info.doc, &out, to);
        report.checked += 1;
        if !saved.lost.is_empty() {
            report.fail(format!("{file}: a single-sheet CSV document lost {:?}", saved.lost));
        }
        let reopened = match actor.open(&out) {
            Ok(r) => r,
            Err(e) => {
                report.fail(format!("{file}: reopen failed: {e}"));
                continue;
            }
        };
        if to == SaveFormat::Csv {
            // Saving keeps the file's own dialect, so detection finds it again.
            report.checked += 1;
            let problems =
                if reopened.csv == info.csv { vec![] } else { vec![format!("options {:?} -> {:?}", info.csv, reopened.csv)] };
            report.record(gaps, file, "@roundtrip:csvOptions", problems, "");
        }
        let doc = reopened.doc;
        let get = |sheet, at| actor.try_cell(doc, sheet, at);
        // The CSV sheet is named after the file, so compare by position.
        let what = CheckWhat { display: true, input: false };
        check_cells_with(&reopened.sheets, reopened.active_sheet, &get, &exp, gaps, &mut report, what, &format!(" (as {ext})"));
        check_marker(&actor, &reopened, marker, &mut report, gaps, file);
        actor.close(info.doc);
        actor.close(doc);
    }
    report
}

#[test]
fn csv_open_edit_save_csv_reopen() {
    csv_roundtrip(SaveFormat::Csv, &gaps(&["csv_store", "roundtrip", "roundtrip_csv"])).assert_ok("csv -> csv round trip");
}

#[test]
#[ignore = "strict twin: fails while known-gaps.json `csv_store`/`roundtrip`/`roundtrip_csv` has open bugs"]
fn csv_open_edit_save_csv_reopen_strict() {
    csv_roundtrip(SaveFormat::Csv, &gaps(&["csv_store", "roundtrip", "roundtrip_csv"])).assert_no_known_gaps("csv -> csv (strict)");
}

#[test]
fn csv_open_edit_save_xlsx_reopen() {
    csv_roundtrip(SaveFormat::Xlsx, &gaps(&["csv_store", "roundtrip"])).assert_ok("csv -> xlsx round trip");
}

#[test]
#[ignore = "strict twin: fails while known-gaps.json `csv_store`/`roundtrip` has open bugs"]
fn csv_open_edit_save_xlsx_reopen_strict() {
    csv_roundtrip(SaveFormat::Xlsx, &gaps(&["csv_store", "roundtrip"])).assert_no_known_gaps("csv -> xlsx (strict)");
}

#[test]
fn csv_saved_with_explicit_options_reopens_with_them() {
    // Spanish bank export re-saved as a plain `,`/`.` UTF-8 file and back.
    let actor = Actor::start();
    let dir = scratch_dir("csv-options");
    let src = files_dir().join("movimientos_banco_es.csv");
    let exp = load_expected(&files_dir().join("movimientos_banco_es.csv.expected.json"));
    let info = actor.open(&src).unwrap();
    let out = dir.join("movimientos_en.csv");
    let options = SaveOptions {
        format: SaveFormat::Csv,
        sheet: None,
        csv: Some(CsvOptions { delimiter: Some(",".into()), encoding: Some("utf-8".into()), decimal: Some(".".into()) }),
    };
    actor.save(info.doc, &out, options).expect("save with options");
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(text.lines().next().unwrap().contains(','), "comma delimiter: {}", text.lines().next().unwrap());
    let reopened = actor.open(&out).unwrap();
    let csv = reopened.csv.clone().unwrap();
    assert_eq!((csv.delimiter.as_deref(), csv.decimal.as_deref()), (Some(","), Some(".")), "detected {csv:?}");
    let mut report = Report::default();
    let get = |sheet, at| actor.try_cell(reopened.doc, sheet, at);
    check_cells_with(&reopened.sheets, reopened.active_sheet, &get, &exp, &BTreeMap::new(), &mut report, values_only(), " (re-saved en)");
    report.assert_ok("movimientos_banco_es re-saved with , and .");
}

#[test]
fn csv_formula_edit_promotes_and_survives_xlsx_save() {
    let actor = Actor::start();
    let dir = scratch_dir("promote");
    let info = actor.open(&files_dir().join("movimientos_banco_es.csv")).unwrap();
    assert_eq!(info.backend, BackendKind::Csv, "big-CSV fast store first");
    let sheet = info.active_sheet;
    let rows = actor.sheet_info(info.doc, sheet).used_range.unwrap().r1;
    // Sum of the amounts (column D) computed from the values the store reports.
    let range = CellRange { r0: 1, c0: 3, r1: rows, c1: 3 };
    let doc = info.doc;
    let values = actor.call(move |s| s.range_values(doc, sheet, range)).unwrap();
    let want: f64 = values.values.iter().flatten().filter_map(|v| if let CellValue::Number { value } = v { Some(*value) } else { None }).sum();
    actor.take_events();
    let formula = format!("=SUM(D2:D{})", rows + 1);
    actor.set(doc, sheet, 0, 8, &formula);
    let events = actor.take_events();
    assert!(
        events.iter().any(|e| matches!(e, EngineEvent::BackendChanged { backend: BackendKind::Workbook, .. })),
        "a formula promotes the CSV store to a workbook"
    );
    let info = actor.info(doc);
    assert_eq!(info.backend, BackendKind::Workbook);
    let sheet = info.active_sheet;
    let got = actor.cell(doc, sheet, 0, 8);
    assert!(matches!(got.value, CellValue::Number { value } if numbers_match(value, want)), "{:?} != {want}", got.value);
    let out = dir.join("movimientos.xlsx");
    actor.save_as(doc, &out, SaveFormat::Xlsx);
    let reopened = actor.open(&out).unwrap();
    let cell = actor.cell(reopened.doc, reopened.active_sheet, 0, 8);
    assert_eq!(cell.input, formula);
    assert!(matches!(cell.value, CellValue::Number { value } if numbers_match(value, want)));
    // Dates typed as dd/mm/yyyy in the CSV stay dates after promotion and save.
    let a2 = actor.cell(reopened.doc, reopened.active_sheet, 1, 0);
    assert!(matches!(a2.value, CellValue::Number { .. }), "date is a serial: {:?}", a2.value);
    assert!(a2.display.len() == 10 && a2.display.as_bytes()[2] == b'/', "dd/mm/yyyy display: {}", a2.display);
}

// ---------------------------------------------------------------------------
// Edit → recalc → undo on real files
// ---------------------------------------------------------------------------

/// `=SUM(B5:B7)` on one column of the same sheet: (col, r0, r1), 0-based.
fn simple_sum(input: &str) -> Option<(u32, u32, u32)> {
    let inner = input.strip_prefix("=SUM(")?.strip_suffix(')')?;
    let (a, b) = inner.split_once(':')?;
    if a.contains('!') || b.contains('!') || !a.chars().all(|c| c.is_ascii_alphanumeric()) || !b.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let (a, b) = (parse_a1(a), parse_a1(b));
    (a.col == b.col && a.row < b.row).then_some((a.col, a.row, b.row))
}

#[test]
fn editing_a_precedent_recalculates_dependents_and_undo_restores() {
    let actor = Actor::start();
    let mut tried = 0;
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let info = actor.open(&path).unwrap();
        // First single-column SUM whose range holds a constant number.
        let found = exp.cells.iter().filter_map(|(k, c)| c.input.as_deref().and_then(simple_sum).map(|s| (k.clone(), s))).find_map(
            |(reference, (col, r0, r1))| {
                let (sheet_name, _) = split_ref(&reference);
                let sheet = info.sheets.iter().find(|s| Some(s.name.as_str()) == sheet_name).map(|s| s.id).unwrap_or(info.active_sheet);
                (r0..=r1)
                    .find(|&r| {
                        let d = actor.cell(info.doc, sheet, r, col);
                        !d.input.starts_with('=') && matches!(d.value, CellValue::Number { .. })
                    })
                    .map(|row| (reference.clone(), sheet, row, col))
            },
        );
        let Some((reference, sheet, row, col)) = found else {
            actor.close(info.doc);
            continue;
        };
        let total_at = parse_a1(split_ref(&reference).1);
        let total = |a: &Actor| match a.cell(info.doc, sheet, total_at.row, total_at.col).value {
            CellValue::Number { value } => value,
            other => panic!("{}: {reference} is {other:?}", exp.file),
        };
        tried += 1;
        let before = total(&actor);
        let CellValue::Number { value: old } = actor.cell(info.doc, sheet, row, col).value else { unreachable!() };
        actor.take_events();
        actor.set(info.doc, sheet, row, col, &format!("{}", old + 100.0));
        let after = total(&actor);
        assert!(numbers_match(after, before + 100.0), "{}: {reference} {before} -> {after} after +100", exp.file);
        let events = actor.take_events();
        assert!(
            events.iter().any(|e| matches!(e, EngineEvent::Cells { .. } | EngineEvent::SheetData { .. })),
            "{}: an edit emits cell events for the grid",
            exp.file
        );
        let undone = actor.undo(info.doc);
        assert!(undone.can_redo, "{}: undo enables redo", exp.file);
        assert!(numbers_match(total(&actor), before), "{}: undo restores {reference}", exp.file);
        actor.redo(info.doc);
        assert!(numbers_match(total(&actor), before + 100.0), "{}: redo re-applies", exp.file);
        actor.close(info.doc);
    }
    assert!(tried >= 2, "found a SUM to exercise in only {tried} corpus files");
}

#[test]
fn saving_to_a_missing_folder_fails_in_spanish_and_keeps_the_document() {
    let actor = Actor::start();
    let info = actor.open(&files_dir().join("facturas.xlsx")).unwrap();
    actor.set(info.doc, info.active_sheet, 0, 30, "x");
    let target = scratch_dir("missing").join("no").join("existe").join("f.xlsx");
    let err = actor.save(info.doc, &target, SaveOptions { format: SaveFormat::Xlsx, sheet: None, csv: None }).expect_err("missing folder");
    assert_eq!(err.code, EngineErrorCode::Io, "{err}");
    assert!(!err.message.is_ascii() || err.message.contains("No se"), "Spanish message: {}", err.message);
    assert!(actor.info(info.doc).dirty, "a failed save keeps the document dirty");
}
