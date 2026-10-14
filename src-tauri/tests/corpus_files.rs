//! Corpus harness for the file layer (WS3): `xlsx_package::inspect` and
//! `csv_store::open`, driven by `tests/corpus/files/*.expected.json`.
//!
//! Tests marked `#[ignore = "WS3: …"]` exercise behavior that is still a
//! Phase 1 stub on `main`. Phase 3 enables them by deleting the attribute
//! (or runs them now with `cargo test -- --ignored`).

mod common;

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use sheetlight_lib::engine::backend::{DocumentBackend, EventSink};
use sheetlight_lib::engine::types::{BackendKind, CsvOptions, EngineEvent, FidelityFeature};

// ---------------------------------------------------------------------------
// Corpus sanity (runs now)
// ---------------------------------------------------------------------------

#[test]
fn corpus_manifest_is_consistent() {
    let files = corpus_files();
    assert!(files.len() >= 12, "expected at least 12 corpus files, found {}", files.len());
    for (path, exp) in &files {
        let name = path.file_name().unwrap().to_string_lossy();
        assert_eq!(exp.file, name, "expected.json `file` field");
        let size = std::fs::metadata(path).unwrap().len();
        assert!(size < 1_000_000, "{name} is {size} bytes; committed corpus files must stay < 1 MB");
        assert!(!exp.cells.is_empty(), "{name}: no expected cells");
        assert!(!exp.sheets.is_empty(), "{name}: no sheets");
        for (reference, cell) in &exp.cells {
            let (sheet, a1) = split_ref(reference);
            if let Some(sheet) = sheet {
                assert!(exp.sheets.iter().any(|s| s == sheet), "{name}: {reference} names an unknown sheet");
            }
            parse_a1(a1);
            assert!(cell.value.is_some() || cell.any_of.is_some(), "{name}: {reference} has no value");
        }
        match exp.kind.as_str() {
            "xlsx" => {
                let bytes = std::fs::read(path).unwrap();
                assert_eq!(&bytes[..4], b"PK\x03\x04", "{name} is not a zip package");
            }
            "csv" => {
                let csv = exp.csv.as_ref().unwrap_or_else(|| panic!("{name}: csv options missing"));
                let bytes = std::fs::read(path).unwrap();
                let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]) || bytes.starts_with(&[0xFF, 0xFE]);
                assert_eq!(Some(has_bom), exp.bom, "{name}: BOM flag");
                assert!(csv.delimiter.is_some() && csv.encoding.is_some() && csv.decimal.is_some());
            }
            other => panic!("{name}: unknown kind {other}"),
        }
        for feats in exp.features.values() {
            for m in &feats.merges {
                parse_range(m);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// xlsx_package::inspect (WS3)
// ---------------------------------------------------------------------------

#[test]
fn xlsx_inspect_accepts_every_corpus_workbook() {
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let bytes = std::fs::read(&path).unwrap();
        if let Err(e) = sheetlight_lib::xlsx_package::inspect(&bytes) {
            panic!("{}: inspect failed: {e}", exp.file);
        }
    }
}

fn feature_key(f: FidelityFeature) -> String {
    serde_json::to_value(f).unwrap().as_str().unwrap().to_string()
}

#[test]
#[ignore = "WS3: xlsx_package::inspect is a Phase 1 stub"]
fn xlsx_inspect_reports_every_fidelity_feature() {
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("xlsx") {
        let bytes = std::fs::read(&path).unwrap();
        let pkg = sheetlight_lib::xlsx_package::inspect(&bytes).expect("inspect");
        let found: BTreeMap<String, u32> = pkg.warnings.iter().map(|w| (feature_key(w.feature), w.count)).collect();
        for (feature, count) in &exp.fidelity {
            report.checked += 1;
            match found.get(feature) {
                None => report.fail(format!("{}: no warning for `{feature}` ({count} in file)", exp.file)),
                // Counts are only pinned where they are unambiguous.
                Some(n) if ["charts", "images", "comments"].contains(&feature.as_str()) && n != count => {
                    report.fail(format!("{}: `{feature}` count {n} != {count}", exp.file))
                }
                _ => {}
            }
        }
        // Charts are extracted (anchors + parsed XML) for the chart layer.
        let charts: u32 = exp.features.values().map(|f| f.charts).sum();
        report.checked += 1;
        if pkg.charts.len() as u32 != charts {
            report.fail(format!("{}: {} charts extracted, file has {charts}", exp.file, pkg.charts.len()));
        }
        // Autofilter ranges are extracted per original sheet index.
        for (i, sheet) in exp.sheets.iter().enumerate() {
            let want = exp.features.get(sheet).and_then(|f| f.auto_filter.as_deref()).map(parse_range);
            let got = pkg.auto_filters.iter().find(|(idx, _)| *idx == i).map(|(_, r)| *r);
            report.checked += 1;
            if want != got {
                report.fail(format!("{}: sheet {sheet}: autofilter {got:?} != {want:?}", exp.file));
            }
        }
    }
    report.assert_ok("xlsx_package::inspect fidelity warnings");
}

// ---------------------------------------------------------------------------
// csv_store::open (WS3)
// ---------------------------------------------------------------------------

/// Opens a CSV with auto-detection and waits until the background loader
/// reports `done`.
fn open_csv_and_wait(path: &std::path::Path) -> (Box<dyn DocumentBackend>, CsvOptions) {
    let (tx, rx) = mpsc::channel::<EngineEvent>();
    let tx = Mutex::new(tx);
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.lock().unwrap().send(e);
    });
    let (backend, detected) = sheetlight_lib::csv_store::open(path.to_str().unwrap(), &CsvOptions::default(), 1, sink)
        .unwrap_or_else(|e| panic!("{}: csv_store::open failed: {e}", path.display()));
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(EngineEvent::LoadProgress { done: true, error, .. }) => {
                assert!(error.is_none(), "{}: load error {error:?}", path.display());
                break;
            }
            Ok(_) => {}
            Err(_) => panic!("{}: CSV load did not finish in 30 s", path.display()),
        }
    }
    (backend, detected)
}

#[test]
#[ignore = "WS3: csv_store::open is a Phase 1 stub"]
fn csv_store_detects_options_and_reads_expected_cells() {
    let gaps = known_gaps("csv_store");
    let mut report = Report::default();
    for (path, exp) in corpus_files_of_kind("csv") {
        let (backend, detected) = open_csv_and_wait(&path);
        let want = exp.csv.as_ref().unwrap();
        report.checked += 1;
        if &detected != want {
            report.fail(format!("{}: detected {detected:?} != {want:?}", exp.file));
        }
        report.checked += 1;
        if backend.kind() != BackendKind::Csv {
            report.fail(format!("{}: backend kind {:?}", exp.file, backend.kind()));
        }
        let info = backend.sheet_info(backend.active_sheet()).expect("sheet_info");
        let used = info.used_range;
        let (rows, cols) = (exp.rows.unwrap(), exp.cols.unwrap());
        report.checked += 1;
        if used.map(|u| (u.r1 + 1, u.c1 + 1)) != Some((rows, cols)) {
            report.fail(format!("{}: used range {used:?}, expected {rows} rows x {cols} cols", exp.file));
        }
        check_backend(backend.as_ref(), &exp, &gaps, &mut report);
    }
    report.assert_ok("csv_store corpus");
}

#[test]
#[ignore = "WS3: csv_store::open is a Phase 1 stub; needs `python tests/corpus/gen_corpus.py big`"]
fn csv_store_opens_big_1m_csv() {
    for name in ["big_1M.csv", "big_1M_es.csv"] {
        let path = generated_dir().join(name);
        if !path.exists() {
            eprintln!("skipping {name}: run `python tests/corpus/gen_corpus.py big` first");
            continue;
        }
        let exp = load_expected(&generated_dir().join(format!("{name}.expected.json")));
        let t = Instant::now();
        let (backend, detected) = open_csv_and_wait(&path);
        eprintln!("{name}: loaded in {:.2} s", t.elapsed().as_secs_f64());
        assert_eq!(Some(&detected), exp.csv.as_ref(), "{name}: detected options");
        let info = backend.sheet_info(backend.active_sheet()).unwrap();
        assert_eq!(info.used_range.map(|u| u.r1 + 1), exp.rows, "{name}: rows");
    }
}
