//! Behavior tests of the workbook backend, one section per area.

use super::*;
use crate::engine::backend::{DocumentBackend, ImportedWorkbook};

fn wb() -> (WorkbookBackend, SheetId) {
    let backend = new_workbook().expect("new workbook");
    let sheet = backend.active_sheet();
    (backend, sheet)
}

fn r(r0: u32, c0: u32, r1: u32, c1: u32) -> CellRange {
    CellRange { r0, c0, r1, c1 }
}

fn cells(sheet: SheetId, list: &[(u32, u32, &str)]) -> EngineOp {
    EngineOp::SetCells {
        sheet,
        cells: list.iter().map(|(row, col, input)| CellInput { row: *row, col: *col, input: input.to_string(), num_fmt: None }).collect(),
    }
}

fn apply(b: &mut WorkbookBackend, ops: Vec<EngineOp>) -> ApplyOutcome {
    b.apply(&ops).expect("apply")
}

fn details(b: &WorkbookBackend, sheet: SheetId, row: u32, col: u32) -> CellDetails {
    b.cell_details(sheet, CellAddress { row, col }).expect("cell")
}

fn input(b: &WorkbookBackend, sheet: SheetId, row: u32, col: u32) -> String {
    details(b, sheet, row, col).input
}

fn shown(b: &WorkbookBackend, sheet: SheetId, row: u32, col: u32) -> String {
    details(b, sheet, row, col).display
}

fn column(b: &WorkbookBackend, sheet: SheetId, col: u32, rows: u32) -> Vec<String> {
    (0..rows).map(|row| input(b, sheet, row, col)).collect()
}

// ----- cells, formulas, undo ------------------------------------------------

#[test]
fn new_workbook_has_spanish_first_sheet() {
    let (b, _) = wb();
    let sheets = b.sheets();
    assert_eq!(sheets.len(), 1);
    assert_eq!(sheets[0].name, "Hoja1");
}

#[test]
fn set_cells_and_recalculate_formulas() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (1, 0, "2.5"), (2, 0, "=SUM(A1:A2)")])]);
    let cell = details(&b, s, 2, 0);
    assert_eq!(cell.input, "=SUM(A1:A2)");
    assert_eq!(cell.value, CellValue::Number { value: 3.5 });
    assert_eq!(cell.display, "3,5");
    // Editing a precedent recalculates.
    apply(&mut b, vec![cells(s, &[(0, 0, "10")])]);
    assert_eq!(details(&b, s, 2, 0).value, CellValue::Number { value: 12.5 });
}

#[test]
fn canonical_inputs_keep_their_type() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "'123"), (0, 1, "TRUE"), (0, 2, "hola"), (0, 3, "#N/A"), (0, 4, "1/2")])]);
    assert_eq!(details(&b, s, 0, 0).value, CellValue::Text { value: "123".into() });
    assert_eq!(input(&b, s, 0, 0), "'123");
    assert_eq!(details(&b, s, 0, 1).value, CellValue::Bool { value: true });
    assert_eq!(shown(&b, s, 0, 1), "VERDADERO");
    assert_eq!(details(&b, s, 0, 2).value, CellValue::Text { value: "hola".into() });
    assert!(matches!(details(&b, s, 0, 3).value, CellValue::Error { .. }));
    // Not a canonical number: stays text (no date guessing in the engine).
    assert_eq!(details(&b, s, 0, 4).value, CellValue::Text { value: "1/2".into() });
}

#[test]
fn number_formats_display_in_spanish() {
    let (mut b, s) = wb();
    let op = EngineOp::SetCells {
        sheet: s,
        cells: vec![
            CellInput { row: 0, col: 0, input: "1234.5".into(), num_fmt: Some("#,##0.00".into()) },
            CellInput { row: 1, col: 0, input: "45702".into(), num_fmt: Some("dd/mm/yyyy".into()) },
            CellInput { row: 2, col: 0, input: "0.25".into(), num_fmt: Some("0%".into()) },
        ],
    };
    apply(&mut b, vec![op]);
    assert_eq!(shown(&b, s, 0, 0), "1.234,50");
    assert_eq!(shown(&b, s, 1, 0), "14/02/2025");
    assert_eq!(shown(&b, s, 2, 0), "25%");
    assert_eq!(details(&b, s, 1, 0).format.num_fmt, "dd/mm/yyyy");
}

#[test]
fn one_apply_is_one_undo_step() {
    let (mut b, s) = wb();
    assert!(!b.can_undo());
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (1, 0, "2")]), cells(s, &[(2, 0, "=A1+A2")])]);
    assert!(b.can_undo());
    assert_eq!(details(&b, s, 2, 0).value, CellValue::Number { value: 3.0 });
    let undone = b.undo().expect("undo");
    assert!(undone.selection.is_some(), "undo restores the selection");
    assert_eq!(column(&b, s, 0, 3), vec!["", "", ""]);
    assert!(!b.can_undo());
    assert!(b.can_redo());
    b.redo().expect("redo");
    assert_eq!(column(&b, s, 0, 3), vec!["1", "2", "=A1+A2"]);
    assert_eq!(details(&b, s, 2, 0).value, CellValue::Number { value: 3.0 });
}

#[test]
fn failed_batch_rolls_back_everything() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "keep")])]);
    let error = b.apply(&[cells(s, &[(0, 0, "changed"), (1, 0, "=1+")])]).expect_err("broken formula");
    assert_eq!(error.code, EngineErrorCode::InvalidFormula);
    assert_eq!(input(&b, s, 0, 0), "keep");
    assert_eq!(input(&b, s, 1, 0), "");
    // The previous step is still undoable.
    b.undo().expect("undo");
    assert_eq!(input(&b, s, 0, 0), "");
}

#[test]
fn new_apply_clears_redo() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1")])]);
    b.undo().unwrap();
    assert!(b.can_redo());
    apply(&mut b, vec![cells(s, &[(0, 1, "2")])]);
    assert!(!b.can_redo());
}

#[test]
fn clear_contents_keeps_formats() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "5")])]);
    let patch = StylePatch { bold: Some(true), ..StylePatch::default() };
    apply(&mut b, vec![EngineOp::SetStyle { sheet: s, ranges: vec![r(0, 0, 0, 0)], patch }]);
    apply(&mut b, vec![EngineOp::Clear { sheet: s, ranges: vec![r(0, 0, 0, 0)], what: ClearWhat::Contents }]);
    let cell = details(&b, s, 0, 0);
    assert_eq!(cell.input, "");
    assert_eq!(cell.format.style.bold, Some(true));
    apply(&mut b, vec![EngineOp::Clear { sheet: s, ranges: vec![r(0, 0, 0, 0)], what: ClearWhat::All }]);
    assert_eq!(details(&b, s, 0, 0).format.style.bold, None);
}

#[test]
fn spill_cells_are_flagged() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "=SEQUENCE(3)")])]);
    assert_eq!(details(&b, s, 2, 0).value, CellValue::Number { value: 3.0 });
    assert_eq!(details(&b, s, 2, 0).spill_anchor, Some(CellAddress { row: 0, col: 0 }));
}

// ----- blocks ------------------------------------------------------------------

#[test]
fn blocks_carry_display_kind_style_and_flags() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "Año"), (0, 1, "1234.5"), (1, 0, "=1/0"), (70, 17, "lejos")])]);
    let mut block = BlockCells::new();
    b.write_block(s, BlockKey { br: 0, bc: 0 }, &mut block).unwrap();
    assert_eq!(block.text(0), "Año");
    assert_eq!(block.kind(0), CellKind::Text as u8);
    assert_eq!(block.text(1), "1234,5");
    assert_eq!(block.kind(1), CellKind::Number as u8);
    let i = BLOCK_COLS as usize;
    assert_eq!(block.text(i), "#DIV/0!", "error codes stay en-US like formulas");
    assert_eq!(block.kind(i), CellKind::Error as u8);
    assert_eq!(block.flags(i) & cell_flag::FORMULA, cell_flag::FORMULA);
    // Cell (70, 17) lives in block (1, 1) at (6, 1).
    let mut other = BlockCells::new();
    b.write_block(s, BlockKey { br: 1, bc: 1 }, &mut other).unwrap();
    assert_eq!(other.text(6 * BLOCK_COLS as usize + 1), "lejos");
    let mut empty = BlockCells::new();
    b.write_block(s, BlockKey { br: 5, bc: 5 }, &mut empty).unwrap();
    assert!(empty.is_empty());
}

// ----- formats -----------------------------------------------------------------

#[test]
fn style_patch_reaches_the_render_style_table() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "x")])]);
    let patch = StylePatch {
        bold: Some(true),
        fill: Some(Some("#ffff00".into())),
        h_align: Some(Some(HAlign::Center)),
        ..StylePatch::default()
    };
    apply(&mut b, vec![EngineOp::SetStyle { sheet: s, ranges: vec![r(0, 0, 1, 1)], patch }]);
    let mut block = BlockCells::new();
    b.write_block(s, BlockKey { br: 0, bc: 0 }, &mut block).unwrap();
    let id = block.style_id(0);
    assert_ne!(id, 0);
    assert_eq!(block.style_id(BLOCK_COLS as usize + 1), id, "equal styles share one id");
    let styles = b.styles(&[id]);
    assert_eq!(styles.len(), 1);
    assert_eq!(styles[0].1.bold, Some(true));
    assert_eq!(styles[0].1.fill.as_deref(), Some("#ffff00"));
    assert_eq!(styles[0].1.h_align, Some(HAlign::Center));
    // Reset with null.
    let reset = StylePatch { fill: Some(None), ..StylePatch::default() };
    apply(&mut b, vec![EngineOp::SetStyle { sheet: s, ranges: vec![r(0, 0, 0, 0)], patch: reset }]);
    assert_eq!(details(&b, s, 0, 0).format.style.fill, None);
    assert_eq!(details(&b, s, 0, 0).format.style.bold, Some(true));
}

#[test]
fn number_format_patch_and_negative_red() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "-3")])]);
    let patch = StylePatch { num_fmt: Some("#,##0.00;[Red]-#,##0.00".into()), ..StylePatch::default() };
    apply(&mut b, vec![EngineOp::SetStyle { sheet: s, ranges: vec![r(0, 0, 0, 0)], patch }]);
    assert_eq!(shown(&b, s, 0, 0), "-3,00");
    let mut block = BlockCells::new();
    b.write_block(s, BlockKey { br: 0, bc: 0 }, &mut block).unwrap();
    let style = &b.styles(&[block.style_id(0)])[0].1;
    assert!(style.color.is_some(), "number-format color is resolved by the engine");
}

#[test]
fn borders_merge_and_copy_format() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "Título")])]);
    apply(
        &mut b,
        vec![
            EngineOp::SetBorders {
                sheet: s,
                ranges: vec![r(0, 0, 1, 1)],
                preset: BorderPreset::Outer,
                style: BorderStyle::Thin,
                color: "#000000".into(),
            },
            EngineOp::Merge { sheet: s, range: r(0, 0, 0, 2), mode: MergeMode::MergeCenter },
        ],
    );
    let info = b.sheet_info(s).unwrap();
    assert_eq!(info.merges, vec![r(0, 0, 0, 2)]);
    assert_eq!(details(&b, s, 0, 0).format.style.border_top.as_ref().map(|x| x.style), Some(BorderStyle::Thin));
    assert_eq!(details(&b, s, 0, 1).merge, Some(r(0, 0, 0, 2)));
    apply(&mut b, vec![EngineOp::CopyFormat { sheet: s, source: r(0, 0, 0, 0), targets: vec![r(5, 5, 5, 5)] }]);
    assert_eq!(details(&b, s, 5, 5).format.style.h_align, Some(HAlign::Center));
    apply(&mut b, vec![EngineOp::Unmerge { sheet: s, ranges: vec![r(0, 0, 0, 2)] }]);
    assert!(b.sheet_info(s).unwrap().merges.is_empty());
}

// ----- structure & geometry ----------------------------------------------------

#[test]
fn insert_and_delete_rows_adjust_formulas() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (1, 0, "=A1*2")])]);
    let out = apply(&mut b, vec![EngineOp::InsertRows { sheet: s, index: 0, count: 2 }]);
    assert!(out.events.iter().any(|e| matches!(e, EngineEvent::Structure { op: StructureOp::Insert, count: 2, .. })));
    assert_eq!(input(&b, s, 3, 0), "=A3*2");
    assert_eq!(details(&b, s, 3, 0).value, CellValue::Number { value: 2.0 });
    apply(&mut b, vec![EngineOp::DeleteRows { sheet: s, index: 0, count: 1 }]);
    assert_eq!(input(&b, s, 2, 0), "=A2*2");
    b.undo().unwrap();
    b.undo().unwrap();
    assert_eq!(input(&b, s, 1, 0), "=A1*2");
}

#[test]
fn insert_and_delete_cols() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (0, 1, "=A1+1")])]);
    apply(&mut b, vec![EngineOp::InsertCols { sheet: s, index: 1, count: 1 }]);
    assert_eq!(input(&b, s, 0, 2), "=A1+1");
    apply(&mut b, vec![EngineOp::DeleteCols { sheet: s, index: 0, count: 1 }]);
    assert!(matches!(details(&b, s, 0, 1).value, CellValue::Error { .. }), "reference to a deleted column is #REF!");
}

#[test]
fn shift_cells_down_and_up() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "a"), (1, 0, "b"), (0, 1, "x")])]);
    apply(&mut b, vec![EngineOp::InsertCells { sheet: s, range: r(0, 0, 0, 0), shift: ShiftDir::Down }]);
    assert_eq!(column(&b, s, 0, 3), vec!["", "a", "b"]);
    assert_eq!(input(&b, s, 0, 1), "x", "other columns do not move");
    apply(&mut b, vec![EngineOp::DeleteCells { sheet: s, range: r(0, 0, 0, 0), shift: ShiftDir::Up }]);
    assert_eq!(column(&b, s, 0, 3), vec!["a", "b", ""]);
}

#[test]
fn sizes_hidden_frozen_and_grid_lines() {
    let (mut b, s) = wb();
    apply(
        &mut b,
        vec![
            EngineOp::SetRowHeights { sheet: s, rows: vec![2], size: Some(40.0) },
            EngineOp::SetColWidths { sheet: s, cols: vec![1, 2], size: Some(120.0) },
            EngineOp::SetHidden { sheet: s, axis: Axis::Row, indices: vec![5], hidden: true },
            EngineOp::SetFrozen { sheet: s, rows: 1, cols: 2 },
            EngineOp::SetShowGridLines { sheet: s, show: false },
        ],
    );
    let info = b.sheet_info(s).unwrap();
    assert_eq!(info.default_row_height, 20.0);
    assert_eq!(info.default_col_width, 64.0);
    assert!(info.row_overrides.iter().any(|o| o.index == 2 && o.size == Some(40.0)));
    assert!(info.row_overrides.iter().any(|o| o.index == 5 && o.hidden == Some(true)));
    assert!(info.col_overrides.iter().any(|o| o.index == 2 && o.size == Some(120.0)));
    assert_eq!((info.frozen_rows, info.frozen_cols), (1, 2));
    assert!(!info.show_grid_lines);
    let version = info.version;
    b.undo().unwrap();
    let info = b.sheet_info(s).unwrap();
    assert_eq!((info.frozen_rows, info.frozen_cols), (0, 0));
    assert!(info.show_grid_lines);
    assert!(info.version > version, "version is monotonic across undo");
}

// ----- sort, find, fill, filter ---------------------------------------------------

#[test]
fn sort_with_header_and_undo() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "Nombre"), (1, 0, "Carmen"), (2, 0, "álvaro"), (3, 0, "Beatriz"), (1, 1, "3"), (2, 1, "1"), (3, 1, "2")])]);
    let keys = vec![SortKey { col: 0, ascending: true }];
    apply(&mut b, vec![EngineOp::Sort { sheet: s, range: r(0, 0, 3, 1), keys, has_header: true }]);
    assert_eq!(column(&b, s, 0, 4), vec!["Nombre", "álvaro", "Beatriz", "Carmen"]);
    assert_eq!(column(&b, s, 1, 4), vec!["", "1", "2", "3"], "rows move together");
    let keys = vec![SortKey { col: 1, ascending: false }];
    apply(&mut b, vec![EngineOp::Sort { sheet: s, range: r(1, 0, 3, 1), keys, has_header: false }]);
    assert_eq!(column(&b, s, 1, 4), vec!["", "3", "2", "1"]);
    b.undo().unwrap();
    b.undo().unwrap();
    assert_eq!(column(&b, s, 0, 4), vec!["Nombre", "Carmen", "álvaro", "Beatriz"]);
}

fn query(text: &str) -> FindQuery {
    FindQuery {
        text: text.into(),
        match_case: false,
        whole_cell: false,
        look_in: LookIn::Values,
        sheet: None,
        within: None,
        by_columns: None,
        limit: 100,
    }
}

#[test]
fn find_and_replace() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "Madrid"), (1, 0, "madrileño"), (2, 0, "Sevilla"), (0, 1, "=LEN(A1)")])]);
    let found = b.find(&query("madri")).unwrap();
    assert_eq!(found.iter().map(|m| (m.row, m.col)).collect::<Vec<_>>(), vec![(0, 0), (1, 0)]);
    let whole = FindQuery { whole_cell: true, ..query("madrid") };
    assert_eq!(b.find(&whole).unwrap().len(), 1);
    let formulas = FindQuery { look_in: LookIn::Formulas, ..query("len(") };
    assert_eq!(b.find(&formulas).unwrap().len(), 1);
    let cased = FindQuery { match_case: true, ..query("madri") };
    assert_eq!(b.find(&cased).unwrap().len(), 1);

    let out = apply(&mut b, vec![EngineOp::Replace { query: query("madri"), replacement: "Barcelo".into(), all: true, at: None }]);
    assert_eq!(out.affected, 2);
    assert_eq!(column(&b, s, 0, 2), vec!["Barcelod", "Barceloleño"]);
    assert_eq!(details(&b, s, 0, 1).value, CellValue::Number { value: 8.0 });
    b.undo().unwrap();
    let one = EngineOp::Replace {
        query: query("sevilla"),
        replacement: "Cádiz".into(),
        all: false,
        at: Some(CellPosition { sheet: s, row: 2, col: 0 }),
    };
    let out = apply(&mut b, vec![one]);
    assert_eq!(out.affected, 1);
    assert_eq!(input(&b, s, 2, 0), "Cádiz");
}

#[test]
fn fill_series_numbers_and_formulas() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (1, 0, "3"), (0, 1, "=A1*10")])]);
    apply(&mut b, vec![EngineOp::Fill { sheet: s, source: r(0, 0, 1, 0), target: r(0, 0, 4, 0) }]);
    assert_eq!(column(&b, s, 0, 5), vec!["1", "3", "5", "7", "9"]);
    apply(&mut b, vec![EngineOp::Fill { sheet: s, source: r(0, 1, 0, 1), target: r(0, 1, 2, 1) }]);
    assert_eq!(column(&b, s, 1, 3), vec!["=A1*10", "=A2*10", "=A3*10"]);
    assert_eq!(details(&b, s, 2, 1).value, CellValue::Number { value: 50.0 });
}

#[test]
fn fill_month_names() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "enero")])]);
    apply(&mut b, vec![EngineOp::Fill { sheet: s, source: r(0, 0, 0, 0), target: r(0, 0, 2, 0) }]);
    assert_eq!(column(&b, s, 0, 3), vec!["enero", "febrero", "marzo"]);
}

#[test]
fn autofilter_hides_rows_and_reports_values() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "Ciudad"), (1, 0, "Madrid"), (2, 0, "Sevilla"), (3, 0, "Madrid"), (4, 0, "")])]);
    apply(&mut b, vec![EngineOp::SetAutoFilter { sheet: s, range: Some(r(0, 0, 0, 0)) }]);
    let info = b.sheet_info(s).unwrap();
    assert_eq!(info.auto_filter.as_ref().map(|f| f.range), Some(r(0, 0, 3, 0)));
    let values = b.filter_values(s, 0, 100).unwrap();
    let madrid = values.iter().find(|v| v.value == "Madrid").expect("madrid");
    assert_eq!(madrid.count, 2);
    let criteria = FilterCriteria { values: vec!["Sevilla".into()] };
    apply(&mut b, vec![EngineOp::FilterColumn { sheet: s, col: 0, criteria: Some(criteria) }]);
    let info = b.sheet_info(s).unwrap();
    let hidden: Vec<u32> = info.row_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
    assert_eq!(hidden, vec![1, 3]);
    assert_eq!(info.auto_filter.unwrap().filtered_cols, vec![0]);
    apply(&mut b, vec![EngineOp::SetAutoFilter { sheet: s, range: None }]);
    let info = b.sheet_info(s).unwrap();
    assert!(info.auto_filter.is_none());
    assert!(info.row_overrides.iter().all(|o| o.hidden != Some(true)));
}

// ----- clipboard ---------------------------------------------------------------

#[test]
fn copy_paste_internal_shifts_formulas() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "2"), (0, 1, "=A1*2")])]);
    let clip = b.copy(s, r(0, 0, 0, 1)).unwrap();
    assert_eq!(clip.text, "2\t4\r\n");
    assert!(clip.html.contains("<table"));
    let source = PasteSource::Internal { clip_id: clip.clip_id, cut: false };
    apply(&mut b, vec![EngineOp::Paste { sheet: s, target: r(4, 0, 4, 0), source, mode: PasteMode::All }]);
    assert_eq!(input(&b, s, 4, 1), "=A5*2");
    assert_eq!(details(&b, s, 4, 1).value, CellValue::Number { value: 4.0 });
    let source = PasteSource::Internal { clip_id: clip.clip_id, cut: false };
    apply(&mut b, vec![EngineOp::Paste { sheet: s, target: r(6, 0, 6, 0), source, mode: PasteMode::Values }]);
    assert_eq!(input(&b, s, 6, 1), "4");
}

#[test]
fn paste_text_from_other_apps() {
    let (mut b, s) = wb();
    let source = PasteSource::Text { text: "Nombre\tImporte\r\nAna\t1.234,5\r\n".into() };
    let out = apply(&mut b, vec![EngineOp::Paste { sheet: s, target: r(0, 0, 0, 0), source, mode: PasteMode::All }]);
    assert_eq!(out.affected, 4);
    assert_eq!(details(&b, s, 1, 1).value, CellValue::Number { value: 1234.5 });
    assert_eq!(input(&b, s, 1, 0), "Ana");
}

// ----- sheets --------------------------------------------------------------------

#[test]
fn sheet_operations() {
    let (mut b, s) = wb();
    let out = apply(&mut b, vec![EngineOp::AddSheet { name: None, index: None }]);
    let second = out.created[0];
    assert_eq!(b.sheets()[1].name, "Hoja2");
    apply(&mut b, vec![EngineOp::RenameSheet { sheet: second, name: "Ventas".into() }]);
    let error = b.apply(&[EngineOp::RenameSheet { sheet: s, name: "ventas".into() }]).expect_err("duplicate name");
    assert_eq!(error.code, EngineErrorCode::SheetName);
    apply(&mut b, vec![cells(second, &[(0, 0, "7")]), cells(s, &[(0, 0, "=Ventas!A1*2")])]);
    assert_eq!(details(&b, s, 0, 0).value, CellValue::Number { value: 14.0 });
    let out = apply(&mut b, vec![EngineOp::DuplicateSheet { sheet: second }]);
    let copy = out.created[0];
    assert_eq!(b.sheets().iter().find(|m| m.id == copy).map(|m| m.name.clone()).as_deref(), Some("Ventas (2)"));
    apply(&mut b, vec![EngineOp::MoveSheet { sheet: s, index: 2 }]);
    assert_eq!(b.sheets()[2].id, s);
    apply(&mut b, vec![EngineOp::SetSheetColor { sheet: s, color: Some("#ff0000".into()) }]);
    assert_eq!(b.sheets()[2].color.as_deref(), Some("#ff0000"));
    apply(&mut b, vec![EngineOp::SetActiveSheet { sheet: copy }]);
    assert_eq!(b.active_sheet(), copy);
    apply(&mut b, vec![EngineOp::DeleteSheet { sheet: copy }]);
    assert_eq!(b.sheets().len(), 2);
    b.undo().unwrap();
    assert_eq!(b.sheets().len(), 3);
}

#[test]
fn cannot_hide_or_delete_the_last_visible_sheet() {
    let (mut b, s) = wb();
    assert!(b.apply(&[EngineOp::DeleteSheet { sheet: s }]).is_err());
    assert!(b.apply(&[EngineOp::SetSheetHidden { sheet: s, hidden: true }]).is_err());
}

// ----- comments, hyperlinks, charts ----------------------------------------------

#[test]
fn comments_and_hyperlinks() {
    let (mut b, s) = wb();
    apply(
        &mut b,
        vec![
            EngineOp::SetComment { sheet: s, row: 1, col: 1, text: Some("Revisar".into()) },
            EngineOp::SetHyperlink { sheet: s, row: 0, col: 0, url: Some("https://example.com".into()) },
        ],
    );
    assert_eq!(details(&b, s, 1, 1).comment.as_deref(), Some("Revisar"));
    assert_eq!(details(&b, s, 0, 0).hyperlink.as_deref(), Some("https://example.com"));
    let mut block = BlockCells::new();
    b.write_block(s, BlockKey { br: 0, bc: 0 }, &mut block).unwrap();
    assert_ne!(block.flags(BLOCK_COLS as usize + 1) & cell_flag::COMMENT, 0);
    assert_ne!(block.flags(0) & cell_flag::HYPERLINK, 0);
    b.undo().unwrap();
    assert_eq!(details(&b, s, 1, 1).comment, None);
}

fn chart_draft(sheet: SheetId) -> ChartDraft {
    let point = |row, col| AnchorPoint { row, col, dx: 0.0, dy: 0.0 };
    ChartDraft {
        sheet,
        chart_type: ChartType::Column,
        title: Some("Ventas".into()),
        series: vec![ChartSeries {
            name_ref: None,
            name: Some("2026".into()),
            categories_ref: Some("Hoja1!$A$2:$A$4".into()),
            values_ref: "Hoja1!$B$2:$B$4".into(),
            color: None,
        }],
        anchor: ChartAnchor { from: point(1, 3), to: point(15, 9) },
        legend: LegendPosition::Bottom,
        grouping: ChartGrouping::Clustered,
        x_axis_title: None,
        y_axis_title: None,
    }
}

#[test]
fn charts_are_stored_as_specs() {
    let (mut b, s) = wb();
    let out = apply(&mut b, vec![EngineOp::AddChart { chart: chart_draft(s) }]);
    let id = out.created[0];
    assert!(out.events.iter().any(|e| matches!(e, EngineEvent::Charts { .. })));
    assert_eq!(b.charts(s).len(), 1);
    let mut draft = chart_draft(s);
    draft.title = Some("Otra".into());
    apply(&mut b, vec![EngineOp::UpdateChart { chart: ChartUpdate { id, draft } }]);
    assert_eq!(b.charts(s)[0].draft.title.as_deref(), Some("Otra"));
    // Charts follow inserted rows.
    apply(&mut b, vec![EngineOp::InsertRows { sheet: s, index: 0, count: 2 }]);
    assert_eq!(b.charts(s)[0].draft.anchor.from.row, 3);
    apply(&mut b, vec![EngineOp::DeleteChart { sheet: s, id }]);
    assert!(b.charts(s).is_empty());
    b.undo().unwrap();
    assert_eq!(b.charts(s).len(), 1);
}

// ----- queries ---------------------------------------------------------------------

#[test]
fn selection_stats_range_values_and_edges() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1"), (1, 0, "2"), (2, 0, "texto"), (3, 0, "=A1+A2")])]);
    let stats = b.selection_stats(s, &[r(0, 0, 9, 0)]).unwrap();
    assert_eq!((stats.count, stats.numeric_count, stats.sum), (4, 3, 6.0));
    assert_eq!(stats.average, Some(2.0));
    assert_eq!((stats.min, stats.max), (Some(1.0), Some(3.0)));
    let values = b.range_values(s, r(0, 0, 1, 0)).unwrap();
    assert_eq!(values.values[1][0], CellValue::Number { value: 2.0 });
    assert_eq!(values.display[0][0], "1");
    let edge = b.find_data_edge(s, CellAddress { row: 0, col: 0 }, Direction::Down).unwrap();
    assert_eq!(edge, CellAddress { row: 3, col: 0 });
    let samples = b.column_text_samples(s, 0, 2).unwrap();
    assert_eq!(samples[0].text, "texto");
}

// ----- export / import -------------------------------------------------------------

#[test]
fn xlsx_round_trip_keeps_values_formulas_and_formats() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "1234.5"), (1, 0, "=A1*2"), (2, 0, "hola")])]);
    let patch = StylePatch { bold: Some(true), num_fmt: Some("#,##0.00".into()), ..StylePatch::default() };
    apply(&mut b, vec![EngineOp::SetStyle { sheet: s, ranges: vec![r(0, 0, 0, 0)], patch }]);
    let bytes = b.xlsx_bytes().unwrap();
    let back = WorkbookBackend::from_model(load_xlsx(&bytes, "prueba").unwrap(), Vec::new());
    let s2 = back.active_sheet();
    assert_eq!(back.sheets()[0].name, "Hoja1");
    assert_eq!(input(&back, s2, 1, 0), "=A1*2");
    assert_eq!(details(&back, s2, 1, 0).value, CellValue::Number { value: 2469.0 });
    assert_eq!(shown(&back, s2, 0, 0), "1.234,50");
    assert_eq!(details(&back, s2, 0, 0).format.style.bold, Some(true));
}

#[test]
fn export_cells_and_csv() {
    let (mut b, s) = wb();
    apply(&mut b, vec![cells(s, &[(0, 0, "a;b"), (0, 1, "1.5"), (1, 1, "=B1*2")])]);
    let mut seen = Vec::new();
    b.export_cells(s, &mut |row, col, input| seen.push((row, col, input.to_string()))).unwrap();
    assert_eq!(seen, vec![(0, 0, "a;b".to_string()), (0, 1, "1.5".to_string()), (1, 1, "=B1*2".to_string())]);
    let mut out = Vec::new();
    let options = CsvOptions { delimiter: Some(";".into()), encoding: None, decimal: Some(",".into()) };
    b.write_csv(s, &mut out, &options).unwrap();
    assert_eq!(String::from_utf8(out).unwrap(), "\"a;b\";1,5\r\n;3\r\n");
}

#[test]
fn small_csv_import_types_values() {
    let csv = "Fecha;Importe;Nombre\r\n14/02/2025;1.234,5;Ana\r\n15/02/2025;7;=1+1\r\n";
    let import = import_csv_small(csv.as_bytes(), &CsvOptions::default(), "datos").unwrap();
    assert_eq!(import.options.delimiter.as_deref(), Some(";"));
    assert_eq!(import.options.decimal.as_deref(), Some(","));
    let b = import.backend;
    let s = b.active_sheet();
    assert_eq!(shown(&b, s, 1, 0), "14/02/2025");
    assert_eq!(details(&b, s, 1, 1).value, CellValue::Number { value: 1234.5 });
    assert_eq!(details(&b, s, 2, 2).value, CellValue::Number { value: 2.0 });
}

#[test]
fn imported_workbook_builds_sheets() {
    let imported = ImportedWorkbook {
        sheets: vec![
            crate::engine::backend::ImportedSheet {
                name: "Datos".into(),
                cells: vec![(0, 0, "5".into()), (0, 1, "=A1+1".into())],
                col_widths: vec![(0, 120.0)],
                merges: vec![r(2, 0, 2, 1)],
            },
            crate::engine::backend::ImportedSheet { name: "Otra".into(), ..Default::default() },
        ],
    };
    let b = import_workbook(imported, "viejo").unwrap();
    let sheets = b.sheets();
    assert_eq!(sheets.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), vec!["Datos", "Otra"]);
    let s = sheets[0].id;
    assert_eq!(details(&b, s, 0, 1).value, CellValue::Number { value: 6.0 });
    let info = b.sheet_info(s).unwrap();
    assert!(info.col_overrides.iter().any(|o| o.index == 0 && o.size == Some(120.0)));
    assert_eq!(info.merges, vec![r(2, 0, 2, 1)]);
}
