use std::sync::{Arc, Mutex};

use super::*;
use crate::engine::blocks::BlockCells;

fn store(text: &str) -> CsvStore {
    CsvStore::from_text(text, "datos", &CsvOptions::default()).unwrap()
}

fn display(s: &CsvStore, row: u32, col: u32) -> String {
    s.cell_details(SHEET_ID, CellAddress { row, col }).unwrap().display
}

fn input(s: &CsvStore, row: u32, col: u32) -> String {
    s.cell_details(SHEET_ID, CellAddress { row, col }).unwrap().input
}

fn set(s: &mut CsvStore, cells: &[(u32, u32, &str)]) -> ApplyOutcome {
    let cells = cells.iter().map(|(row, col, input)| CellInput { row: *row, col: *col, input: input.to_string(), num_fmt: None }).collect();
    s.apply(&[EngineOp::SetCells { sheet: SHEET_ID, cells }]).unwrap()
}

fn column(s: &CsvStore, col: u32, rows: u32) -> Vec<String> {
    (0..rows).map(|r| display(s, r, col)).collect()
}

fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("sheetlight-csv-test-{}-{name}", std::process::id()));
    std::fs::write(&path, bytes).unwrap();
    path
}

const SAMPLE: &str = "id,fecha,ciudad,importe,ok\n1,2025-02-14,Madrid,1234.5,TRUE\n2,2025-03-14,\"Sevilla, Triana\",-2,false\n3,,Málaga,n/a,\n";

#[test]
fn loads_typed_values_with_spanish_display() {
    let s = store(SAMPLE);
    assert_eq!(s.resolved().delim, b',');
    assert_eq!(display(&s, 0, 0), "id");
    assert_eq!(display(&s, 1, 0), "1");
    assert_eq!(display(&s, 1, 1), "14/02/2025");
    assert_eq!(display(&s, 2, 1), "14/03/2025");
    assert_eq!(display(&s, 2, 2), "Sevilla, Triana");
    assert_eq!(display(&s, 1, 3), "1234,5");
    assert_eq!(display(&s, 3, 3), "n/a");
    assert_eq!(display(&s, 1, 4), "VERDADERO");
    assert_eq!(display(&s, 2, 4), "FALSO");
    let details = s.cell_details(SHEET_ID, CellAddress { row: 1, col: 1 }).unwrap();
    assert_eq!(details.input, "45702");
    assert_eq!(details.format.num_fmt, "dd/mm/yyyy");
    assert_eq!(details.value, CellValue::Number { value: 45702.0 });
    assert_eq!(input(&s, 1, 3), "1234.5");
    let info = s.sheet_info(SHEET_ID).unwrap();
    assert_eq!(info.used_range, Some(CellRange { r0: 0, c0: 0, r1: 3, c1: 4 }));
    assert!(!s.loading());
}

#[test]
fn blocks_have_kinds_and_text() {
    let s = store(SAMPLE);
    let mut cells = BlockCells::new();
    s.write_block(SHEET_ID, BlockKey { br: 0, bc: 0 }, &mut cells).unwrap();
    assert!(!cells.is_empty());
    let mut empty = BlockCells::new();
    s.write_block(SHEET_ID, BlockKey { br: 5, bc: 0 }, &mut empty).unwrap();
    assert!(empty.is_empty());
}

#[test]
fn spanish_semicolon_files_detect_decimal_comma() {
    let s = store("concepto;importe;fecha\nAlquiler;1.234,56;01/02/2026\nLuz;-45,3;15/02/2026\n");
    assert_eq!(s.resolved().delim, b';');
    assert_eq!(s.resolved().decimal, b',');
    assert_eq!(input(&s, 1, 1), "1234.56");
    assert_eq!(display(&s, 2, 1), "-45,3");
    assert_eq!(display(&s, 1, 2), "01/02/2026");
}

#[test]
fn text_that_looks_like_a_number_is_quoted_in_input() {
    let s = store("codigo\n007\n'x\n");
    assert_eq!(display(&s, 1, 0), "007");
    assert_eq!(input(&s, 1, 0), "'007");
    assert_eq!(input(&s, 2, 0), "''x");
}

#[test]
fn edits_and_undo_redo() {
    let mut s = store(SAMPLE);
    let out = set(&mut s, &[(1, 2, "Bilbao"), (1, 3, "99.5"), (10, 0, "nuevo")]);
    assert_eq!(out.affected, 3);
    assert!(matches!(out.events[0], EngineEvent::Cells { doc: 0, .. }));
    assert_eq!(display(&s, 1, 2), "Bilbao");
    assert_eq!(display(&s, 1, 3), "99,5");
    assert_eq!(display(&s, 10, 0), "nuevo");
    assert_eq!(s.sheet_info(SHEET_ID).unwrap().used_range.unwrap().r1, 10);
    s.undo().unwrap();
    assert_eq!(display(&s, 1, 2), "Madrid");
    assert_eq!(display(&s, 1, 3), "1234,5");
    assert_eq!(display(&s, 10, 0), "");
    assert_eq!(s.sheet_info(SHEET_ID).unwrap().used_range.unwrap().r1, 3);
    assert!(s.can_redo());
    s.redo().unwrap();
    assert_eq!(display(&s, 1, 2), "Bilbao");
    // Dates typed in an ISO column keep the ISO style on save.
    s.apply(&[EngineOp::SetCells { sheet: SHEET_ID, cells: vec![CellInput { row: 3, col: 1, input: "45703".into(), num_fmt: Some("dd/mm/yyyy".into()) }] }]).unwrap();
    assert_eq!(display(&s, 3, 1), "15/02/2025");
    let mut out = Vec::new();
    s.write_csv(SHEET_ID, &mut out, &CsvOptions::default()).unwrap();
    assert!(String::from_utf8(out).unwrap().contains("3,2025-02-15,"));
}

#[test]
fn supports_only_plain_ops() {
    let s = store(SAMPLE);
    let plain = EngineOp::SetCells { sheet: 1, cells: vec![CellInput { row: 0, col: 0, input: "x".into(), num_fmt: None }] };
    let formula = EngineOp::SetCells { sheet: 1, cells: vec![CellInput { row: 0, col: 0, input: "=A2".into(), num_fmt: None }] };
    let currency = EngineOp::SetCells { sheet: 1, cells: vec![CellInput { row: 0, col: 0, input: "1".into(), num_fmt: Some("#,##0.00 €".into()) }] };
    let style = EngineOp::SetStyle { sheet: 1, ranges: vec![], patch: StylePatch::default() };
    assert!(s.supports(&plain));
    assert!(!s.supports(&formula));
    assert!(!s.supports(&currency));
    assert!(!s.supports(&style));
    assert!(s.supports(&EngineOp::SetFrozen { sheet: 1, rows: 1, cols: 0 }));
    assert!(!s.supports(&EngineOp::AddSheet { name: None, index: None }));
}

#[test]
fn sort_multi_key_with_header_and_undo() {
    let mut s = store("nombre,grupo,valor\nana,b,3\nÁlvaro,a,10\nzoe,a,2\nnico,b,\nñu,a,2\n");
    let range = CellRange { r0: 0, c0: 0, r1: 5, c1: 2 };
    let out = s
        .apply(&[EngineOp::Sort { sheet: 1, range, keys: vec![SortKey { col: 1, ascending: true }, SortKey { col: 2, ascending: false }], has_header: true }])
        .unwrap();
    assert!(out.selection.is_some());
    assert_eq!(column(&s, 0, 6), vec!["nombre", "Álvaro", "zoe", "ñu", "ana", "nico"]);
    s.apply(&[EngineOp::Sort { sheet: 1, range, keys: vec![SortKey { col: 0, ascending: true }], has_header: true }]).unwrap();
    assert_eq!(column(&s, 0, 6), vec!["nombre", "Álvaro", "ana", "nico", "ñu", "zoe"]);
    // Blanks last even when descending.
    s.apply(&[EngineOp::Sort { sheet: 1, range, keys: vec![SortKey { col: 2, ascending: false }], has_header: true }]).unwrap();
    assert_eq!(column(&s, 2, 6), vec!["valor", "10", "3", "2", "2", ""]);
    s.undo().unwrap();
    s.undo().unwrap();
    s.undo().unwrap();
    assert_eq!(column(&s, 0, 6), vec!["nombre", "ana", "Álvaro", "zoe", "nico", "ñu"]);
}

#[test]
fn autofilter_hides_rows_and_lists_values() {
    let mut s = store("ciudad,n\nMadrid,1\nSevilla,2\nMadrid,3\n,4\n");
    let range = CellRange { r0: 0, c0: 0, r1: 4, c1: 1 };
    s.apply(&[EngineOp::SetAutoFilter { sheet: 1, range: Some(range) }]).unwrap();
    let values = s.filter_values(1, 0, 100).unwrap();
    let names: Vec<_> = values.iter().map(|v| (v.value.as_str(), v.count, v.selected)).collect();
    assert_eq!(names, vec![("Madrid", 2, true), ("Sevilla", 1, true), ("", 1, true)]);
    s.apply(&[EngineOp::FilterColumn { sheet: 1, col: 0, criteria: Some(FilterCriteria { values: vec!["Madrid".into()] }) }]).unwrap();
    let info = s.sheet_info(1).unwrap();
    let hidden: Vec<u32> = info.row_overrides.iter().filter(|o| o.hidden == Some(true)).map(|o| o.index).collect();
    assert_eq!(hidden, vec![2, 4]);
    assert_eq!(info.auto_filter.as_ref().unwrap().filtered_cols, vec![0]);
    let values = s.filter_values(1, 0, 100).unwrap();
    assert!(values.iter().find(|v| v.value == "Sevilla").is_some_and(|v| !v.selected));
    // Status bar skips filtered rows.
    let stats = s.selection_stats(1, &[CellRange { r0: 1, c0: 1, r1: 4, c1: 1 }]).unwrap();
    assert_eq!((stats.count, stats.sum), (2, 4.0));
    s.undo().unwrap();
    assert!(s.sheet_info(1).unwrap().row_overrides.is_empty());
}

#[test]
fn insert_delete_rows_and_cols() {
    let mut s = store("a,b\n1,2\n3,4\n");
    s.apply(&[EngineOp::InsertRows { sheet: 1, index: 1, count: 2 }]).unwrap();
    assert_eq!(column(&s, 0, 5), vec!["a", "", "", "1", "3"]);
    s.apply(&[EngineOp::DeleteRows { sheet: 1, index: 0, count: 2 }]).unwrap();
    assert_eq!(column(&s, 0, 3), vec!["", "1", "3"]);
    s.apply(&[EngineOp::InsertCols { sheet: 1, index: 0, count: 1 }]).unwrap();
    assert_eq!(display(&s, 1, 1), "1");
    s.apply(&[EngineOp::DeleteCols { sheet: 1, index: 1, count: 1 }]).unwrap();
    assert_eq!(display(&s, 1, 1), "2");
    for _ in 0..4 {
        s.undo().unwrap();
    }
    assert_eq!(column(&s, 0, 3), vec!["a", "1", "3"]);
    assert_eq!(column(&s, 1, 3), vec!["b", "2", "4"]);
}

#[test]
fn clear_and_view_ops() {
    let mut s = store(SAMPLE);
    s.apply(&[
        EngineOp::Clear { sheet: 1, ranges: vec![CellRange { r0: 1, c0: 0, r1: MAX_ROWS - 1, c1: 0 }], what: ClearWhat::Contents },
        EngineOp::Clear { sheet: 1, ranges: vec![CellRange { r0: 0, c0: 1, r1: 3, c1: 1 }], what: ClearWhat::Formats },
        EngineOp::SetColWidths { sheet: 1, cols: vec![2], size: Some(120.0) },
        EngineOp::SetFrozen { sheet: 1, rows: 1, cols: 0 },
        EngineOp::SetShowGridLines { sheet: 1, show: false },
        EngineOp::SetHidden { sheet: 1, axis: Axis::Col, indices: vec![4], hidden: true },
    ])
    .unwrap();
    assert_eq!(column(&s, 0, 4), vec!["id", "", "", ""]);
    assert_eq!(display(&s, 1, 1), "45702");
    let info = s.sheet_info(1).unwrap();
    assert_eq!(info.frozen_rows, 1);
    assert!(!info.show_grid_lines);
    assert_eq!(info.col_overrides, vec![AxisOverride { index: 2, size: Some(120.0), hidden: None }, AxisOverride { index: 4, size: None, hidden: Some(true) }]);
    s.undo().unwrap();
    assert_eq!(display(&s, 1, 0), "1");
    assert_eq!(display(&s, 1, 1), "14/02/2025");
    assert_eq!(s.sheet_info(1).unwrap().frozen_rows, 0);
}

#[test]
fn ctrl_arrow_edges() {
    let s = store("a,b,,d\n1,,,\n2,,,\n,,,\n5,,,\n");
    let edge = |row, col, dir| s.find_data_edge(1, CellAddress { row, col }, dir).unwrap();
    assert_eq!(edge(0, 0, Direction::Down), CellAddress { row: 2, col: 0 });
    assert_eq!(edge(2, 0, Direction::Down), CellAddress { row: 4, col: 0 });
    assert_eq!(edge(4, 0, Direction::Down), CellAddress { row: MAX_ROWS - 1, col: 0 });
    assert_eq!(edge(4, 0, Direction::Up), CellAddress { row: 2, col: 0 });
    assert_eq!(edge(0, 0, Direction::Right), CellAddress { row: 0, col: 1 });
    assert_eq!(edge(0, 1, Direction::Right), CellAddress { row: 0, col: 3 });
    assert_eq!(edge(0, 3, Direction::Right), CellAddress { row: 0, col: MAX_COLS - 1 });
    assert_eq!(edge(0, 3, Direction::Left), CellAddress { row: 0, col: 1 });
    assert_eq!(edge(3, 2, Direction::Up), CellAddress { row: 0, col: 2 });
}

#[test]
fn find_text_and_numbers() {
    let s = store(SAMPLE);
    let q = |text: &str, whole: bool, look_in: LookIn| FindQuery { text: text.into(), match_case: false, whole_cell: whole, look_in, sheet: None, within: None, by_columns: None, limit: 10 };
    let hits = s.find(&q("málaga", false, LookIn::Values)).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!((hits[0].row, hits[0].col), (3, 2));
    let hits = s.find(&q("1234,5", true, LookIn::Values)).unwrap();
    assert_eq!(hits.len(), 1);
    let hits = s.find(&q("1234.5", true, LookIn::Formulas)).unwrap();
    assert_eq!(hits.len(), 1);
    let hits = s.find(&q("a", false, LookIn::Values)).unwrap();
    assert!(hits.len() >= 3);
}

#[test]
fn stats_samples_and_ranges() {
    let s = store(SAMPLE);
    let stats = s.selection_stats(1, &[CellRange { r0: 0, c0: 3, r1: MAX_ROWS - 1, c1: 3 }]).unwrap();
    assert_eq!(stats.count, 4);
    assert_eq!(stats.numeric_count, 2);
    assert_eq!(stats.sum, 1232.5);
    assert_eq!(stats.min, Some(-2.0));
    let samples = s.column_text_samples(1, 2, 2).unwrap();
    assert_eq!(samples[0].text, "Sevilla, Triana");
    let values = s.range_values(1, CellRange { r0: 1, c0: 0, r1: 2, c1: 1 }).unwrap();
    assert_eq!(values.display[1], vec!["2", "14/03/2025"]);
}

#[test]
fn export_for_promotion() {
    let s = store(SAMPLE);
    let mut cells = Vec::new();
    s.export_cells(1, &mut |r, c, v| cells.push((r, c, v.to_string()))).unwrap();
    assert!(cells.contains(&(1, 1, "45702".into())));
    assert!(cells.contains(&(1, 4, "TRUE".into())));
    assert!(cells.contains(&(2, 2, "Sevilla, Triana".into())));
    let mut formats = Vec::new();
    s.export_number_formats(1, &mut |r, f| formats.push((r, f.to_string()))).unwrap();
    assert_eq!(formats, vec![(CellRange { r0: 1, c0: 1, r1: 2, c1: 1 }, "dd/mm/yyyy".to_string())]);
}

#[test]
fn csv_round_trip_with_options() {
    let s = store("nombre;importe;fecha\n\"Pérez; Juan\";1.234,56;2025-02-14\nAna \"la\";2;14/02/2025\n");
    let mut out = Vec::new();
    s.write_csv(1, &mut out, &CsvOptions::default()).unwrap();
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "nombre;importe;fecha\r\n\"Pérez; Juan\";1234,56;2025-02-14\r\n\"Ana \"\"la\"\"\";2;14/02/2025\r\n"
    );
    let mut out = Vec::new();
    let opts = CsvOptions { delimiter: Some(",".into()), encoding: Some("utf-8-bom".into()), decimal: Some(".".into()) };
    s.write_csv(1, &mut out, &opts).unwrap();
    assert!(out.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert!(String::from_utf8_lossy(&out).contains("Pérez; Juan,1234.56,2025-02-14"));
    let mut out = Vec::new();
    let opts = CsvOptions { delimiter: None, encoding: Some("windows-1252".into()), decimal: None };
    s.write_csv(1, &mut out, &opts).unwrap();
    assert!(out.windows(2).any(|w| w == [b'P', 0xE9]), "é encoded as 0xE9");
    let bad = CsvOptions { delimiter: Some(",".into()), encoding: None, decimal: Some(",".into()) };
    assert!(s.write_csv(1, &mut Vec::new(), &bad).is_err());
}

#[test]
fn opens_files_in_other_encodings_and_reports_progress() {
    let events: Arc<Mutex<Vec<EngineEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: EventSink = Arc::new(move |e| sink_events.lock().unwrap().push(e));

    // Windows-1252 with ';'.
    let path = temp_file("ansi.csv", b"a\xf1o;importe\n2025;1,5\n");
    let (backend, opts) = open(path.to_str().unwrap(), &CsvOptions::default(), 7, sink.clone()).unwrap();
    assert_eq!(opts.encoding.as_deref(), Some("windows-1252"));
    assert_eq!(opts.delimiter.as_deref(), Some(";"));
    while backend.loading() {
        std::thread::yield_now();
    }
    assert_eq!(backend.cell_details(1, CellAddress { row: 0, col: 0 }).unwrap().display, "año");
    assert_eq!(backend.sheets()[0].name, format!("sheetlight-csv-test-{}-ansi", std::process::id()));
    drop(backend);
    let _ = std::fs::remove_file(&path);

    // UTF-16LE with BOM and tabs.
    let mut bytes = vec![0xFF, 0xFE];
    for unit in "x\ty\n1\tñ\n".encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let path = temp_file("utf16.csv", &bytes);
    let (backend, opts) = open(path.to_str().unwrap(), &CsvOptions::default(), 8, sink).unwrap();
    assert_eq!(opts.encoding.as_deref(), Some("utf-16le"));
    assert_eq!(opts.delimiter.as_deref(), Some("\t"));
    while backend.loading() {
        std::thread::yield_now();
    }
    // The done event is sent right after `loading` flips; give it a moment.
    for _ in 0..200 {
        if events.lock().unwrap().iter().any(|e| matches!(e, EngineEvent::LoadProgress { doc: 8, done: true, .. })) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(backend.cell_details(1, CellAddress { row: 1, col: 1 }).unwrap().display, "ñ");
    let events = events.lock().unwrap();
    assert!(events.iter().any(|e| matches!(e, EngineEvent::LoadProgress { doc: 8, done: true, rows_loaded: 2, error: None, .. })));
    assert!(events.iter().any(|e| matches!(e, EngineEvent::Cells { doc: 8, .. })));
    drop(backend);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn explicit_options_win_and_bad_ones_fail() {
    let opts = CsvOptions { delimiter: Some(";".into()), encoding: Some("utf-8".into()), decimal: Some(",".into()) };
    let s = CsvStore::from_text("a,b;1,5\n", "x", &opts).unwrap();
    assert_eq!(display(&s, 0, 0), "a,b");
    assert_eq!(display(&s, 0, 1), "1,5");
    assert_eq!(input(&s, 0, 1), "1.5");
    let bad = CsvOptions { delimiter: Some("#".into()), ..CsvOptions::default() };
    assert!(CsvStore::from_text("a", "x", &bad).is_err());
}

#[test]
fn ragged_rows_and_empty_lines() {
    let s = store("a,b,c\n1\n\n1,2,3,4,5\n");
    assert_eq!(s.sheet_info(1).unwrap().used_range, Some(CellRange { r0: 0, c0: 0, r1: 3, c1: 4 }));
    assert_eq!(display(&s, 3, 4), "5");
    assert_eq!(display(&s, 2, 0), "");
}

#[test]
fn many_rows_load_in_chunks() {
    let mut text = String::from("n,txt\n");
    for i in 0..50_000 {
        text.push_str(&format!("{i},v{}\n", i % 7));
    }
    let s = store(&text);
    assert_eq!(display(&s, 50_000, 0), "49999");
    assert_eq!(display(&s, 50_000, 1), "v5");
    let stats = s.selection_stats(1, &[CellRange { r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: 0 }]).unwrap();
    assert_eq!(stats.numeric_count, 50_000);
    // Low-cardinality text is dictionary-encoded.
    assert!(s.read().strings.len() < 20);
}

#[test]
fn sheet_names_from_paths() {
    assert_eq!(sheet_name_from_path("C:\\Datos\\ventas 2026.csv"), "ventas 2026");
    assert_eq!(sheet_name_from_path("/tmp/a.b.csv"), "a.b");
    assert_eq!(sheet_name_from_path(".csv"), ".csv");
    assert_eq!(sheet_name_from_path("x/[raro]?.csv"), "_raro__");
}

/// Manual benchmark (1M x 10 rows, PLAN target: open < 5 s, browsable at once):
/// `cargo test --release big_csv_bench -- --ignored --nocapture` (debug
/// builds are ~10x slower).
#[test]
#[ignore]
fn big_csv_bench() {
    // `SHEETLIGHT_BENCH_CSV` points at a real file; otherwise a 1M-row x
    // 10-column Spanish CSV (`;`, decimal comma, ~70 MB) is generated in the
    // temp folder once.
    let generated = std::env::temp_dir().join("sheetlight-bench-1M.csv");
    let path_buf = std::env::var("SHEETLIGHT_BENCH_CSV").map(std::path::PathBuf::from).unwrap_or_else(|_| generated.clone());
    if !path_buf.exists() && path_buf == generated {
        use std::io::Write as _;
        let mut out = std::io::BufWriter::new(std::fs::File::create(&generated).unwrap());
        writeln!(out, "id;cliente;ciudad;fecha;activo;cantidad;precio;codigo;nota;total").unwrap();
        for i in 1..=1_000_000u32 {
            writeln!(out, "{i};Cliente {};Madrid;2026-01-{:02};true;{};{},5;C{i:07};texto libre;{}", i % 5000, i % 28 + 1, i % 100, i % 1000, i * 3).unwrap();
        }
    }
    let path = path_buf.to_str().unwrap();
    let first_cells = Arc::new(Mutex::new(None::<std::time::Duration>));
    let started = std::time::Instant::now();
    let fc = first_cells.clone();
    let sink: EventSink = Arc::new(move |e| {
        if matches!(e, EngineEvent::Cells { .. }) {
            fc.lock().unwrap().get_or_insert(started.elapsed());
        }
    });
    let mut file = std::fs::File::open(path).unwrap();
    let total = file.metadata().unwrap().len();
    let mut sample = vec![0u8; SNIFF_BYTES];
    let n = std::io::Read::read(&mut file, &mut sample).unwrap();
    let resolved = detect(&sample[..n], &CsvOptions::default(), false).unwrap();
    let file = std::fs::File::open(path).unwrap();
    let backend = CsvStore::start(Box::new(file), "big".into(), resolved, 1, total, sink);
    let opts = resolved.to_options();
    let opened = started.elapsed();
    // First block with real data.
    let mut cells = BlockCells::new();
    loop {
        cells.clear();
        backend.write_block(1, BlockKey { br: 0, bc: 0 }, &mut cells).unwrap();
        let d = backend.cell_details(1, CellAddress { row: 1, col: 0 }).unwrap();
        if d.display == "1" {
            break;
        }
        std::thread::yield_now();
    }
    let first_rows = started.elapsed();
    while backend.loading() {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let loaded = started.elapsed();
    let info = backend.sheet_info(1).unwrap();
    let t = std::time::Instant::now();
    let stats = backend.selection_stats(1, &[CellRange { r0: 0, c0: 6, r1: MAX_ROWS - 1, c1: 6 }]).unwrap();
    let stats_time = t.elapsed();
    let t = std::time::Instant::now();
    let mut blocks = 0;
    for br in (0..15_000).step_by(997) {
        cells.clear();
        backend.write_block(1, BlockKey { br, bc: 0 }, &mut cells).unwrap();
        blocks += 1;
    }
    let block_time = t.elapsed() / blocks;
    println!(
        "opts={opts:?}\nopen() returned in {opened:?}; first rows visible at {first_rows:?}; first cells event {:?}; fully loaded in {loaded:?}\nused={:?}\nstats(precio) {stats_time:?} sum={}\nwrite_block avg {block_time:?}",
        first_cells.lock().unwrap(),
        info.used_range,
        stats.sum
    );
    println!("{}", backend.cell_details(1, CellAddress { row: 1_000_000, col: 9 }).unwrap().display);
    println!("heap estimate: {} MB", backend.heap_bytes() / (1 << 20));
}
