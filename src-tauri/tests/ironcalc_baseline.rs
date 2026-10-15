//! Baseline: the pinned IronCalc engine (the crate Sheetlight embeds) against
//! the corpus expectations, *without* any Sheetlight code in between.
//!
//! - Values: every expected cell after a full `evaluate()` (formulas are
//!   recalculated, not read from the cached values in the file).
//! - Display: number cells formatted with IronCalc's es formatter and the
//!   cell's number format — what WS2's es display path builds on. Booleans
//!   and errors are skipped here (their es display, VERDADERO / #¡DIV/0!, is a
//!   Sheetlight decision, checked at the backend level in `engine_corpus.rs`).
//! - Structure: sheet names, frozen panes, merges.
//!
//! Mismatches listed in `tests/corpus/known-gaps.json` (section `ironcalc`)
//! are reported but do not fail; anything else fails. When an IronCalc
//! upgrade fixes a gap, the test prints it as "now passing" so it can be
//! removed from the list.

mod common;

use common::*;
use ironcalc::import::load_from_xlsx;
use ironcalc_base::cell::CellValue as IcValue;
use ironcalc_base::formatter::format::format_number;
use ironcalc_base::locale::get_locale;
use ironcalc_base::types::CellType;
use ironcalc_base::Model;
use sheetlight_lib::engine::types::CellValue;

fn sheet_index(model: &Model, name: &str) -> Option<u32> {
    model.workbook.get_worksheet_names().iter().position(|n| n == name).map(|i| i as u32)
}

fn value_of(model: &Model, sheet: u32, row: i32, col: i32) -> CellValue {
    let ws = model.workbook.worksheet(sheet).expect("sheet");
    if ws.cell(row, col).is_none() {
        return CellValue::Empty;
    }
    let ty = model.get_cell_type(sheet, row, col).expect("cell type");
    match model.get_cell_value_by_index(sheet, row, col).expect("cell value") {
        IcValue::None => CellValue::Empty,
        IcValue::Number(value) => CellValue::Number { value },
        IcValue::Boolean(value) => CellValue::Bool { value },
        IcValue::String(value) if ty == CellType::ErrorValue => CellValue::Error { value },
        IcValue::String(value) => CellValue::Text { value },
    }
}

#[test]
fn ironcalc_matches_corpus_expectations() {
    let gaps = known_gaps("ironcalc");
    let es = get_locale("es").expect("es locale");
    let mut report = Report::default();
    let mut now_passing = Vec::new();
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let mut model = match load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en") {
            Ok(m) => m,
            Err(e) => {
                report.fail(format!("{}: load_from_xlsx failed: {e:?}", exp.file));
                continue;
            }
        };
        model.evaluate();

        report.checked += 1;
        let names = model.workbook.get_worksheet_names();
        if names != exp.sheets {
            report.fail(format!("{}: sheets {names:?} != {:?}", exp.file, exp.sheets));
        }
        for (sheet_name, feats) in &exp.features {
            let Some(s) = sheet_index(&model, sheet_name) else { continue };
            if let Some([rows, cols]) = feats.frozen {
                report.checked += 1;
                let got = (model.get_frozen_rows_count(s).unwrap(), model.get_frozen_columns_count(s).unwrap());
                if got != (rows as i32, cols as i32) {
                    report.fail(format!("{}: {sheet_name}: frozen {got:?} != ({rows}, {cols})", exp.file));
                }
            }
            report.checked += 1;
            let merges = model.workbook.worksheet(s).unwrap().merged_cells.len();
            if merges != feats.merges.len() {
                report.fail(format!("{}: {sheet_name}: {merges} merges != {}", exp.file, feats.merges.len()));
            }
        }

        for (reference, cell) in &exp.cells {
            report.checked += 1;
            let (sheet_name, a1) = split_ref(reference);
            let Some(sheet) = sheet_index(&model, sheet_name.unwrap_or(&exp.sheets[0])) else {
                report.fail(format!("{}: {reference}: sheet not found", exp.file));
                continue;
            };
            let addr = parse_a1(a1);
            let (row, col) = (addr.row as i32 + 1, addr.col as i32 + 1);
            let got = value_of(&model, sheet, row, col);
            let mut problems = Vec::new();
            if !cell.accepts(&got) {
                problems.push(format!("value {got:?} != {}", cell.describe()));
            }
            if let (Some(want), CellValue::Number { value }) = (&cell.display, &got) {
                let fmt = model.get_style_for_cell(sheet, row, col).expect("style").num_fmt;
                let shown = format_number(*value, &fmt, es).text;
                if &shown != want {
                    problems.push(format!("display {shown:?} != {want:?} (format {fmt:?})"));
                }
            }
            if let Some(want) = &cell.input {
                let content = model.get_cell_formula(sheet, row, col).ok().flatten().unwrap_or_default();
                if &content != want {
                    problems.push(format!("input {content:?} != {want:?}"));
                }
            }
            let known = is_known_gap(&gaps, &exp.file, reference);
            match (problems.is_empty(), known) {
                (true, true) if gaps.contains_key(&format!("{}|{reference}", exp.file)) => {
                    now_passing.push(format!("{}|{reference}", exp.file))
                }
                (true, _) => {}
                (false, true) => report.known.push(format!("{}: {reference}: {}", exp.file, problems.join("; "))),
                (false, false) => report.fail(format!("{}: {reference}: {}", exp.file, problems.join("; "))),
            }
        }
    }
    for k in &now_passing {
        eprintln!("  now passing (remove from known-gaps.json): {k}");
    }
    report.assert_ok("IronCalc baseline on the corpus");
}

#[test]
#[ignore = "needs `python tests/corpus/gen_corpus.py big`; slow in debug builds"]
fn ironcalc_recalculates_chain_100k() {
    let path = generated_dir().join("chain_100k.xlsx");
    assert!(path.exists(), "run `python tests/corpus/gen_corpus.py big` first");
    let mut model = load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").expect("load");
    model.evaluate();
    assert_eq!(value_of(&model, 0, 100_000, 1), CellValue::Number { value: 100_000.0 });
    model.set_user_input(0, 1, 1, "2".to_string()).unwrap();
    let t = std::time::Instant::now();
    model.evaluate();
    eprintln!("chain_100k recalc: {:.1} ms (debug build)", t.elapsed().as_secs_f64() * 1000.0);
    assert_eq!(value_of(&model, 0, 100_000, 1), CellValue::Number { value: 100_001.0 });
}
