//! Engine side of the Excel behavior spec (docs/qa/excel-behavior.md): fill
//! handle series, Ctrl+arrow data edges, clipboard, structure edits, sort,
//! undo and the status-bar stats, each driven through the engine actor the
//! way the grid and the shell call it. Test names are referenced by the spec
//! (`EB-xx` ids in the comments); keep both in sync.
//!
//! A behavior the engine does not match yet is a test marked
//! `#[ignore = "BUG …"]` with the reason, listed in the spec as open.

mod common;

use common::actor::Actor;
use sheetlight_lib::engine::types::*;

fn r(r0: u32, c0: u32, r1: u32, c1: u32) -> CellRange {
    CellRange { r0, c0, r1, c1 }
}

struct Sheet {
    actor: Actor,
    doc: DocumentId,
    sheet: SheetId,
}

impl Sheet {
    fn new(cells: &[(u32, u32, &str)]) -> Self {
        let actor = Actor::start();
        let info = actor.new_document();
        let s = Self { actor, doc: info.doc, sheet: info.active_sheet };
        if !cells.is_empty() {
            s.set_all(cells);
        }
        s
    }

    fn set_all(&self, cells: &[(u32, u32, &str)]) -> ApplyResult {
        let cells = cells.iter().map(|(row, col, v)| CellInput { row: *row, col: *col, input: v.to_string(), num_fmt: None }).collect();
        self.op(EngineOp::SetCells { sheet: self.sheet, cells })
    }

    fn set_fmt(&self, row: u32, col: u32, input: &str, fmt: &str) {
        let cells = vec![CellInput { row, col, input: input.into(), num_fmt: Some(fmt.into()) }];
        self.op(EngineOp::SetCells { sheet: self.sheet, cells });
    }

    fn op(&self, op: EngineOp) -> ApplyResult {
        self.actor.apply(self.doc, vec![op]).unwrap_or_else(|e| panic!("apply: {e}"))
    }

    fn cell(&self, row: u32, col: u32) -> CellDetails {
        self.actor.cell(self.doc, self.sheet, row, col)
    }

    fn display(&self, row: u32, col: u32) -> String {
        self.cell(row, col).display
    }

    fn input(&self, row: u32, col: u32) -> String {
        self.cell(row, col).input
    }

    fn column(&self, col: u32, rows: std::ops::RangeInclusive<u32>) -> Vec<String> {
        rows.map(|row| self.display(row, col)).collect()
    }

    fn fill(&self, source: CellRange, target: CellRange) -> ApplyResult {
        self.op(EngineOp::Fill { sheet: self.sheet, source, target })
    }

    fn edge(&self, row: u32, col: u32, dir: Direction) -> (u32, u32) {
        let (doc, sheet) = (self.doc, self.sheet);
        let at = self.actor.call(move |s| s.find_data_edge(doc, sheet, CellAddress { row, col }, dir)).unwrap();
        (at.row, at.col)
    }

    fn copy(&self, range: CellRange) -> ClipboardData {
        let (doc, sheet) = (self.doc, self.sheet);
        self.actor.call(move |s| s.copy(doc, sheet, range)).unwrap()
    }

    fn paste(&self, target: CellRange, source: PasteSource, mode: PasteMode) -> ApplyResult {
        self.op(EngineOp::Paste { sheet: self.sheet, target, source, mode })
    }
}

// ---------------------------------------------------------------------------
// EB-F: fill handle
// ---------------------------------------------------------------------------

/// EB-F1: a single number is copied (Excel without Ctrl).
#[test]
fn fill_single_number_copies() {
    let s = Sheet::new(&[(0, 0, "7")]);
    s.fill(r(0, 0, 0, 0), r(0, 0, 3, 0));
    assert_eq!(s.column(0, 0..=3), ["7", "7", "7", "7"]);
}

/// EB-F2: two numbers continue the linear series, also when dragging up.
#[test]
fn fill_two_numbers_continue_the_step_down_and_up() {
    let s = Sheet::new(&[(4, 0, "10"), (5, 0, "20")]);
    s.fill(r(4, 0, 5, 0), r(4, 0, 8, 0));
    assert_eq!(s.column(0, 4..=8), ["10", "20", "30", "40", "50"]);
    s.fill(r(4, 0, 5, 0), r(2, 0, 5, 0));
    assert_eq!(s.column(0, 2..=3), ["-10", "0"]);
}

/// EB-F3: dates: one date steps by a day; two dates a month apart step by months.
#[test]
fn fill_dates_by_day_and_by_month() {
    let s = Sheet::new(&[]);
    s.set_fmt(0, 0, "45731", "dd/mm/yyyy"); // 15/03/2025
    s.fill(r(0, 0, 0, 0), r(0, 0, 2, 0));
    assert_eq!(s.column(0, 0..=2), ["15/03/2025", "16/03/2025", "17/03/2025"]);
    s.set_fmt(0, 1, "45672", "dd/mm/yyyy"); // 15/01/2025
    s.set_fmt(1, 1, "45703", "dd/mm/yyyy"); // 15/02/2025
    s.fill(r(0, 1, 1, 1), r(0, 1, 3, 1));
    assert_eq!(s.column(1, 0..=3), ["15/01/2025", "15/02/2025", "15/03/2025", "15/04/2025"]);
}

/// EB-F4: Spanish month and weekday names (full and abbreviated) continue the list.
#[test]
fn fill_spanish_month_and_weekday_names() {
    let s = Sheet::new(&[(0, 0, "ene"), (0, 1, "lunes"), (0, 2, "Diciembre")]);
    s.fill(r(0, 0, 0, 2), r(0, 0, 2, 2));
    assert_eq!(s.column(0, 0..=2), ["ene", "feb", "mar"]);
    assert_eq!(s.column(1, 0..=2), ["lunes", "martes", "miércoles"]);
    assert_eq!(s.column(2, 0..=2), ["Diciembre", "Enero", "Febrero"], "wraps and keeps the capitalization");
}

/// EB-F5: text ending in a number increments; plain text is copied.
#[test]
fn fill_text_with_numbers_increments() {
    let s = Sheet::new(&[(0, 0, "Trimestre 1"), (0, 1, "Total")]);
    s.fill(r(0, 0, 0, 1), r(0, 0, 2, 1));
    assert_eq!(s.column(0, 0..=2), ["Trimestre 1", "Trimestre 2", "Trimestre 3"]);
    assert_eq!(s.column(1, 0..=2), ["Total", "Total", "Total"]);
}

/// EB-F6: formulas shift relative references, keep absolute ones, both directions.
#[test]
fn fill_formulas_shift_relative_references_only() {
    let s = Sheet::new(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "3"), (0, 1, "=$A$1+A1"), (0, 3, "=A1*2")]);
    s.fill(r(0, 1, 0, 1), r(0, 1, 2, 1));
    assert_eq!(s.input(2, 1), "=$A$1+A3");
    assert_eq!(s.display(2, 1), "4");
    s.fill(r(0, 3, 0, 3), r(0, 3, 0, 5));
    assert_eq!(s.input(0, 5), "=C1*2", "fill right shifts columns");
}

/// EB-F7: the fill result selects the filled range and copies source formats.
#[test]
fn fill_selects_target_and_copies_formats() {
    let s = Sheet::new(&[]);
    s.set_fmt(0, 0, "0.25", "0%");
    let result = s.fill(r(0, 0, 0, 0), r(0, 0, 2, 0));
    assert_eq!(s.column(0, 0..=2), ["25%", "25%", "25%"]);
    let sel = result.selection.expect("fill returns a selection hint");
    assert_eq!(sel.ranges, vec![r(0, 0, 2, 0)]);
}

// ---------------------------------------------------------------------------
// EB-K: Ctrl+arrow data edges (`findDataEdge`)
// ---------------------------------------------------------------------------

/// EB-K1: Ctrl+Down stops at the end of a block, then jumps to the next
/// block, then to the last row; Ctrl+Up mirrors it.
#[test]
fn ctrl_arrows_jump_between_data_blocks() {
    let s = Sheet::new(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "3"), (6, 0, "7"), (7, 0, "8")]);
    assert_eq!(s.edge(0, 0, Direction::Down), (2, 0));
    assert_eq!(s.edge(2, 0, Direction::Down), (6, 0));
    assert_eq!(s.edge(7, 0, Direction::Down), (MAX_ROWS - 1, 0));
    assert_eq!(s.edge(7, 0, Direction::Up), (6, 0));
    assert_eq!(s.edge(6, 0, Direction::Up), (2, 0));
    assert_eq!(s.edge(4, 0, Direction::Up), (2, 0), "from an empty cell: next non-empty");
}

/// EB-K2: Ctrl+Right in an empty row goes to the last column; Ctrl+Left to A.
#[test]
fn ctrl_arrows_in_empty_rows_reach_the_sheet_edges() {
    let s = Sheet::new(&[(0, 0, "x")]);
    assert_eq!(s.edge(5, 3, Direction::Right), (5, MAX_COLS - 1));
    assert_eq!(s.edge(5, 3, Direction::Left), (5, 0));
}

// ---------------------------------------------------------------------------
// EB-C: clipboard
// ---------------------------------------------------------------------------

/// EB-C1: copy puts the displayed (es) values on the clipboard as TSV.
#[test]
fn copy_puts_displayed_values_as_tsv() {
    let s = Sheet::new(&[(0, 1, "texto")]);
    s.set_fmt(0, 0, "1234.5", "#,##0.00");
    let clip = s.copy(r(0, 0, 0, 1));
    assert_eq!(clip.text, "1.234,50\ttexto\r\n");
}

/// EB-C2: cut + paste moves the cells and formulas pointing at them follow.
#[test]
fn cut_paste_moves_and_dependents_follow() {
    let s = Sheet::new(&[(0, 0, "5"), (0, 1, "=A1*2")]);
    let clip = s.copy(r(0, 0, 0, 0));
    s.paste(r(0, 3, 0, 3), PasteSource::Internal { clip_id: clip.clip_id, cut: true }, PasteMode::All);
    assert_eq!(s.cell(0, 0).value, CellValue::Empty, "the source is emptied");
    assert_eq!(s.display(0, 3), "5");
    assert_eq!(s.input(0, 1), "=D1*2");
    assert_eq!(s.display(0, 1), "10");
}

/// EB-C3: pasting one copied cell into a larger selection fills all of it.
#[test]
fn paste_single_cell_into_a_range_fills_it() {
    let s = Sheet::new(&[(0, 0, "=ROW()")]);
    let clip = s.copy(r(0, 0, 0, 0));
    s.paste(r(2, 2, 4, 2), PasteSource::Internal { clip_id: clip.clip_id, cut: false }, PasteMode::All);
    assert_eq!(s.column(2, 2..=4), ["3", "4", "5"]);
}

/// EB-C4: paste special values and transpose.
#[test]
fn paste_values_and_transpose() {
    let s = Sheet::new(&[(0, 0, "1"), (0, 1, "2"), (0, 2, "=A1+B1")]);
    let clip = s.copy(r(0, 0, 0, 2));
    s.paste(r(2, 0, 2, 0), PasteSource::Internal { clip_id: clip.clip_id, cut: false }, PasteMode::Values);
    assert_eq!(s.input(2, 2), "3", "values: formula result, not the formula");
    s.paste(r(4, 0, 4, 0), PasteSource::Internal { clip_id: clip.clip_id, cut: false }, PasteMode::Transpose);
    assert_eq!(s.column(0, 4..=5), ["1", "2"]);
}

/// EB-C4b: transposing a formula transposes its references inside the copied
/// range (Excel: C1 `=A1+B1` pasted transposed at A5 becomes A7 `=A5+A6`).
#[test]
#[ignore = "BUG (WS2, paste transpose): formula references are shifted by the paste offset instead of transposed, so A7 becomes #REF! instead of =A5+A6"]
fn transpose_paste_transposes_formula_references() {
    let s = Sheet::new(&[(0, 0, "1"), (0, 1, "2"), (0, 2, "=A1+B1")]);
    let clip = s.copy(r(0, 0, 0, 2));
    s.paste(r(4, 0, 4, 0), PasteSource::Internal { clip_id: clip.clip_id, cut: false }, PasteMode::Transpose);
    assert_eq!(s.input(6, 0), "=A5+A6");
    assert_eq!(s.display(6, 0), "3");
}

/// EB-C5: text pasted from other apps is typed with the es locale.
#[test]
fn paste_text_from_excel_es_types_values() {
    let s = Sheet::new(&[]);
    let text = "Fecha\tImporte\tActivo\r\n14/02/2025\t1.234,5\tVERDADERO\r\n".to_string();
    s.paste(r(0, 0, 0, 0), PasteSource::Text { text }, PasteMode::All);
    assert!(matches!(s.cell(1, 0).value, CellValue::Number { value } if value == 45702.0), "date -> serial: {:?}", s.cell(1, 0).value);
    assert_eq!(s.display(1, 0), "14/02/2025");
    assert_eq!(s.cell(1, 1).value, CellValue::Number { value: 1234.5 });
    assert_eq!(s.cell(1, 2).value, CellValue::Bool { value: true });
}

// ---------------------------------------------------------------------------
// EB-E: editing, structure, undo
// ---------------------------------------------------------------------------

/// EB-E1: a leading apostrophe forces text, and the apostrophe is not shown.
#[test]
fn apostrophe_forces_text() {
    let s = Sheet::new(&[(0, 0, "'=1+1"), (1, 0, "'00123")]);
    assert_eq!(s.cell(0, 0).value, CellValue::Text { value: "=1+1".into() });
    assert_eq!(s.display(1, 0), "00123");
}

/// EB-E2: booleans display in Spanish; errors keep Excel's codes.
#[test]
fn booleans_display_in_spanish() {
    let s = Sheet::new(&[(0, 0, "TRUE"), (1, 0, "=1>2"), (2, 0, "=1/0")]);
    assert_eq!(s.display(0, 0), "VERDADERO");
    assert_eq!(s.display(1, 0), "FALSO");
    assert_eq!(s.cell(2, 0).value, CellValue::Error { value: "#DIV/0!".into() });
}

/// EB-E3: inserting a row inside a summed range extends the range.
#[test]
fn insert_row_inside_a_range_extends_formulas() {
    let s = Sheet::new(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "3"), (3, 0, "=SUM(A1:A3)")]);
    s.op(EngineOp::InsertRows { sheet: s.sheet, index: 1, count: 1 });
    assert_eq!(s.input(4, 0), "=SUM(A1:A4)");
    assert_eq!(s.display(4, 0), "6");
}

/// EB-E4: deleting a referenced row turns the reference into #REF!.
#[test]
fn delete_referenced_row_gives_ref_error() {
    let s = Sheet::new(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "=A1+A2")]);
    s.op(EngineOp::DeleteRows { sheet: s.sheet, index: 0, count: 1 });
    assert_eq!(s.cell(1, 0).value, CellValue::Error { value: "#REF!".into() });
    assert!(s.input(1, 0).contains("#REF!"), "formula shows #REF!: {}", s.input(1, 0));
}

/// EB-E5: undo restores the content and the selection of the undone edit.
#[test]
fn undo_restores_value_and_selection() {
    let s = Sheet::new(&[(2, 3, "antes")]);
    s.set_all(&[(2, 3, "después")]);
    let undone = s.actor.undo(s.doc);
    assert_eq!(s.display(2, 3), "antes");
    let sel = undone.selection.expect("undo returns the selection to restore");
    assert_eq!(sel.active, CellAddress { row: 2, col: 3 });
    assert!(undone.can_redo);
}

/// EB-E6: a multi-cell edit (Ctrl+Enter, paste) is one undo step.
#[test]
fn one_batch_is_one_undo_step() {
    let s = Sheet::new(&[]);
    s.set_all(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "3")]);
    s.actor.undo(s.doc);
    assert_eq!(s.column(0, 0..=2), ["", "", ""]);
}

// ---------------------------------------------------------------------------
// EB-S: sort, find, status bar
// ---------------------------------------------------------------------------

/// EB-S1: ascending sort puts numbers before text and blanks last; descending
/// reverses numbers and text but still keeps blanks last.
#[test]
fn sort_orders_numbers_text_then_blanks() {
    let s = Sheet::new(&[(0, 0, "Valor"), (1, 0, "b"), (2, 0, "2"), (3, 0, "a"), (4, 0, "10"), (6, 0, "Ñu")]);
    let range = r(0, 0, 6, 0);
    s.op(EngineOp::Sort { sheet: s.sheet, range, keys: vec![SortKey { col: 0, ascending: true }], has_header: true });
    assert_eq!(s.column(0, 0..=6), ["Valor", "2", "10", "a", "b", "Ñu", ""]);
    s.op(EngineOp::Sort { sheet: s.sheet, range, keys: vec![SortKey { col: 0, ascending: false }], has_header: true });
    assert_eq!(s.column(0, 0..=6), ["Valor", "Ñu", "b", "a", "10", "2", ""]);
}

/// EB-S2: find with "whole cell" and "match case".
#[test]
fn find_respects_whole_cell_and_case() {
    let s = Sheet::new(&[(0, 0, "Madrid"), (1, 0, "madrid centro"), (2, 0, "MADRID")]);
    let query = |text: &str, whole: bool, case: bool| {
        let q = FindQuery {
            text: text.into(),
            match_case: case,
            whole_cell: whole,
            look_in: LookIn::Values,
            sheet: None,
            within: None,
            by_columns: None,
            limit: 100,
        };
        let doc = s.doc;
        s.actor.call(move |st| st.find(doc, &q)).unwrap().into_iter().map(|m| m.row).collect::<Vec<_>>()
    };
    assert_eq!(query("madrid", false, false), [0, 1, 2]);
    assert_eq!(query("madrid", true, false), [0, 2]);
    assert_eq!(query("Madrid", true, true), [0]);
}

/// EB-S3: status bar: Recuento counts non-empty cells, Suma/Promedio only numbers.
#[test]
fn status_bar_stats_follow_excel() {
    let s = Sheet::new(&[(0, 0, "1"), (1, 0, "2"), (2, 0, "x"), (3, 0, "TRUE"), (0, 2, "4")]);
    let (doc, sheet) = (s.doc, s.sheet);
    let ranges = vec![r(0, 0, 9, 0), r(0, 2, 0, 2)];
    let stats = s.actor.call(move |st| st.selection_stats(doc, sheet, &ranges)).unwrap();
    assert_eq!(stats.count, 5);
    assert_eq!(stats.numeric_count, 3);
    assert_eq!(stats.sum, 7.0);
    assert_eq!(stats.average, Some(7.0 / 3.0));
}
