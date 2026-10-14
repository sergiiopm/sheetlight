//! Shared helpers for the corpus integration tests (WS5).
//!
//! The corpus lives in `tests/corpus/` at the repo root (see its README):
//! `files/` holds small committed files, each with a `<file>.expected.json`
//! produced by `tests/corpus/gen_corpus.py`; `generated/` holds the large,
//! git-ignored benchmark files.
#![allow(dead_code)]

pub mod actor;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sheetlight_lib::engine::backend::DocumentBackend;
use sheetlight_lib::engine::types::{CellAddress, CellDetails, CellRange, CellValue, CsvOptions, EngineResult, SheetId, SheetMeta};

pub fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("tests").join("corpus")
}

pub fn files_dir() -> PathBuf {
    corpus_dir().join("files")
}

pub fn generated_dir() -> PathBuf {
    corpus_dir().join("generated")
}

// ---------------------------------------------------------------------------
// Expected JSON (schema documented in tests/corpus/README.md)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub file: String,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    pub sheets: Vec<String>,
    #[serde(default)]
    pub active_sheet: Option<String>,
    #[serde(default)]
    pub defined_names: BTreeMap<String, String>,
    #[serde(default)]
    pub features: BTreeMap<String, SheetFeatures>,
    /// `FidelityFeature` (camelCase) -> count found in the file.
    #[serde(default)]
    pub fidelity: BTreeMap<String, u32>,
    #[serde(default)]
    pub csv: Option<CsvOptions>,
    #[serde(default)]
    pub bom: Option<bool>,
    #[serde(default)]
    pub line_ending: Option<String>,
    #[serde(default)]
    pub rows: Option<u32>,
    #[serde(default)]
    pub cols: Option<u32>,
    pub cells: BTreeMap<String, ExpectedCell>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SheetFeatures {
    pub frozen: Option<[u32; 2]>,
    pub merges: Vec<String>,
    pub auto_filter: Option<String>,
    pub filtered_cols: Vec<u32>,
    pub hidden_rows: Vec<u32>,
    pub hidden_cols: Vec<u32>,
    pub col_widths: u32,
    pub conditional_formats: u32,
    pub data_validations: u32,
    pub comments: u32,
    pub hyperlinks: u32,
    pub images: u32,
    pub charts: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedCell {
    #[serde(default)]
    pub value: Option<CellValue>,
    /// Several acceptable values (CSV cells where Excel's choice is debatable).
    #[serde(default)]
    pub any_of: Option<Vec<CellValue>>,
    /// es-ES display string.
    #[serde(default)]
    pub display: Option<String>,
    /// Canonical input (en-US formula) for formula cells.
    #[serde(default)]
    pub input: Option<String>,
}

impl ExpectedCell {
    pub fn accepts(&self, got: &CellValue) -> bool {
        if let Some(v) = &self.value {
            return values_match(got, v);
        }
        self.any_of.as_ref().is_some_and(|all| all.iter().any(|v| values_match(got, v)))
    }

    pub fn describe(&self) -> String {
        match (&self.value, &self.any_of) {
            (Some(v), _) => format!("{v:?}"),
            (None, Some(all)) => format!("any of {all:?}"),
            _ => "<nothing>".into(),
        }
    }
}

pub fn load_expected(path: &Path) -> Expected {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()))
}

/// Every committed corpus file with its expected JSON, sorted by name.
pub fn corpus_files() -> Vec<(PathBuf, Expected)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(files_dir()).expect("tests/corpus/files exists") {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.ends_with(".expected.json") || name.starts_with('.') {
            continue;
        }
        let exp_path = path.with_file_name(format!("{name}.expected.json"));
        assert!(exp_path.exists(), "{name} has no {name}.expected.json");
        out.push((path, load_expected(&exp_path)));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(!out.is_empty(), "corpus is empty");
    out
}

pub fn corpus_files_of_kind(kind: &str) -> Vec<(PathBuf, Expected)> {
    corpus_files().into_iter().filter(|(_, e)| e.kind == kind).collect()
}

// ---------------------------------------------------------------------------
// Known gaps (tests/corpus/known-gaps.json)
// ---------------------------------------------------------------------------

/// `{"<section>": {"<file>|<Sheet>!<A1>": "reason", "<file>|*": "reason"}}`.
pub fn known_gaps(section: &str) -> BTreeMap<String, String> {
    let path = corpus_dir().join("known-gaps.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    let all: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));
    match all.get(section) {
        Some(v) => serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("known-gaps.json `{section}`: {e}")),
        None => BTreeMap::new(),
    }
}

pub fn is_known_gap(gaps: &BTreeMap<String, String>, file: &str, cell: &str) -> bool {
    gaps.contains_key(&format!("{file}|{cell}")) || gaps.contains_key(&format!("{file}|*"))
}

// ---------------------------------------------------------------------------
// Addresses and comparisons
// ---------------------------------------------------------------------------

/// `"Hoja 1!B12"` -> (Some("Hoja 1"), "B12"); `"B12"` -> (None, "B12").
pub fn split_ref(reference: &str) -> (Option<&str>, &str) {
    match reference.rfind('!') {
        Some(i) => (Some(reference[..i].trim_matches('\'')), &reference[i + 1..]),
        None => (None, reference),
    }
}

/// `"B12"` -> 0-based `CellAddress { row: 11, col: 1 }`.
pub fn parse_a1(a1: &str) -> CellAddress {
    let a1 = a1.replace('$', "");
    let split = a1.find(|c: char| c.is_ascii_digit()).unwrap_or_else(|| panic!("bad A1 ref {a1}"));
    let (letters, digits) = a1.split_at(split);
    let mut col = 0u32;
    for ch in letters.chars() {
        assert!(ch.is_ascii_uppercase(), "bad A1 ref {a1}");
        col = col * 26 + (ch as u32 - 'A' as u32 + 1);
    }
    let row: u32 = digits.parse().unwrap_or_else(|_| panic!("bad A1 ref {a1}"));
    CellAddress { row: row - 1, col: col - 1 }
}

pub fn parse_range(range: &str) -> CellRange {
    let (a, b) = range.split_once(':').unwrap_or((range, range));
    let (a, b) = (parse_a1(a), parse_a1(b));
    CellRange { r0: a.row.min(b.row), c0: a.col.min(b.col), r1: a.row.max(b.row), c1: a.col.max(b.col) }
}

pub fn numbers_match(got: f64, want: f64) -> bool {
    (got - want).abs() <= 1e-6 * want.abs().max(1.0)
}

pub fn values_match(got: &CellValue, want: &CellValue) -> bool {
    match (got, want) {
        (CellValue::Number { value: g }, CellValue::Number { value: w }) => numbers_match(*g, *w),
        (CellValue::Text { value: g }, CellValue::Text { value: w }) => g == w,
        (CellValue::Bool { value: g }, CellValue::Bool { value: w }) => g == w,
        (CellValue::Error { value: g }, CellValue::Error { value: w }) => g == w,
        (CellValue::Empty, CellValue::Empty) => true,
        (CellValue::Empty, CellValue::Text { value }) | (CellValue::Text { value }, CellValue::Empty) => {
            value.is_empty()
        }
        _ => false,
    }
}

/// Collects mismatches instead of panicking at the first one, so a run shows
/// every problem of a file at once.
#[derive(Default)]
pub struct Report {
    pub checked: usize,
    pub failures: Vec<String>,
    pub known: Vec<String>,
    /// Known-gap keys that passed (remove them from known-gaps.json).
    pub stale: Vec<String>,
}

impl Report {
    pub fn fail(&mut self, msg: String) {
        self.failures.push(msg);
    }

    /// Records the outcome of one check of `<file>|<key>`: failures listed in
    /// `gaps` are reported as known; a listed key that passes is reported as
    /// stale so the list can shrink.
    pub fn record(&mut self, gaps: &BTreeMap<String, String>, file: &str, key: &str, problems: Vec<String>, stage: &str) {
        let known = is_known_gap(gaps, file, key);
        if problems.is_empty() {
            if gaps.contains_key(&format!("{file}|{key}")) {
                self.stale.push(format!("{file}|{key}"));
            }
            return;
        }
        let msg = format!("{file}{stage}: {key}: {}", problems.join("; "));
        if known {
            self.known.push(msg);
        } else {
            self.fail(msg);
        }
    }

    pub fn assert_ok(&self, what: &str) {
        for k in &self.known {
            eprintln!("  known gap: {k}");
        }
        for k in &self.stale {
            eprintln!("  now passing (remove from known-gaps.json): {k}");
        }
        if !self.failures.is_empty() {
            panic!("{what}: {} failure(s) out of {} checks:\n  {}", self.failures.len(), self.checked, self.failures.join("\n  "));
        }
        eprintln!("{what}: {} checks OK ({} known gaps)", self.checked, self.known.len());
    }

    /// For the `#[ignore]`d strict twin of a test: fails while any known gap
    /// remains, so `cargo test -- --ignored` lists the open bugs.
    pub fn assert_no_known_gaps(&self, what: &str) {
        self.assert_ok(what);
        if !self.known.is_empty() {
            panic!("{what}: {} known gap(s) still open:\n  {}", self.known.len(), self.known.join("\n  "));
        }
    }
}

// ---------------------------------------------------------------------------
// Backend-level check (shared by the CSV store and the workbook backend)
// ---------------------------------------------------------------------------

/// Compares every expected cell with what `backend` reports through the
/// `DocumentBackend` seam (`cell_details`): value, es display and formula input.
pub fn check_backend(backend: &dyn DocumentBackend, exp: &Expected, gaps: &BTreeMap<String, String>, report: &mut Report) {
    let sheets = backend.sheets();
    check_cells(&sheets, backend.active_sheet(), &|s, a| backend.cell_details(s, a), exp, gaps, report);
}

/// What a check compares for each expected cell.
#[derive(Clone, Copy)]
pub struct CheckWhat {
    pub display: bool,
    pub input: bool,
}

pub const CHECK_ALL: CheckWhat = CheckWhat { display: true, input: true };

/// Compares every expected cell with what `get` (a backend, or the engine
/// actor's `getCell`) reports: value, es display and formula input.
pub fn check_cells(
    sheets: &[SheetMeta],
    active: SheetId,
    get: &dyn Fn(SheetId, CellAddress) -> EngineResult<CellDetails>,
    exp: &Expected,
    gaps: &BTreeMap<String, String>,
    report: &mut Report,
) {
    check_cells_with(sheets, active, get, exp, gaps, report, CHECK_ALL, "");
}

#[allow(clippy::too_many_arguments)]
pub fn check_cells_with(
    sheets: &[SheetMeta],
    active: SheetId,
    get: &dyn Fn(SheetId, CellAddress) -> EngineResult<CellDetails>,
    exp: &Expected,
    gaps: &BTreeMap<String, String>,
    report: &mut Report,
    what: CheckWhat,
    stage: &str,
) {
    let names: Vec<&str> = sheets.iter().map(|s| s.name.as_str()).collect();
    if exp.kind != "csv" && names != exp.sheets.iter().map(String::as_str).collect::<Vec<_>>() {
        report.fail(format!("{}{stage}: sheets {names:?} != expected {:?}", exp.file, exp.sheets));
    }
    for (reference, cell) in &exp.cells {
        report.checked += 1;
        let (sheet_name, a1) = split_ref(reference);
        let sheet = match sheet_name {
            Some(n) => sheets.iter().find(|s| s.name == n).map(|s| s.id),
            None => Some(active),
        };
        let Some(sheet) = sheet else {
            report.fail(format!("{}{stage}: {reference}: sheet not found", exp.file));
            continue;
        };
        let addr = parse_a1(a1);
        let mut problems = Vec::new();
        match get(sheet, addr) {
            Err(e) => problems.push(format!("getCell error {e}")),
            Ok(d) => {
                if !cell.accepts(&d.value) {
                    problems.push(format!("value {:?} != {}", d.value, cell.describe()));
                }
                if let (true, Some(want)) = (what.display, &cell.display) {
                    if &d.display != want {
                        problems.push(format!("display {:?} != {want:?}", d.display));
                    }
                }
                if let (true, Some(want)) = (what.input, &cell.input) {
                    if &d.input != want {
                        problems.push(format!("input {:?} != {want:?}", d.input));
                    }
                }
            }
        }
        report.record(gaps, &exp.file, reference, problems, stage);
    }
}
