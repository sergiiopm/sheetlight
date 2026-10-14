//! Engine-level benchmarks against the PLAN targets (docs/PLAN.md).
//!
//!     python tests/corpus/gen_corpus.py big          # once: writes tests/corpus/generated/
//!     cd src-tauri && cargo bench --bench engine      # all
//!     cd src-tauri && cargo bench --bench engine -- open_xlsx recalc_chain
//!
//! `cargo bench` builds with the release profile (LTO), which is what ships.
//! Results are printed as a markdown table and written to
//! `tests/bench/results/engine-<unix time>.json` (git-ignored); copy the
//! table into tests/bench/RESULTS.md.
//!
//! Each benchmark reports the median of a few runs. Peak RSS is the process
//! high-water mark, so run one benchmark per process when the RAM number
//! matters (pass its name as the only argument).
//!
//! Phase 3: once the actor and workbook backend exist (WS2), switch
//! `open_xlsx` / `recalc_chain` from the raw IronCalc calls to the same path
//! the app uses (actor `openDocument` + `apply`), keeping the raw numbers as
//! a baseline row.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ironcalc::import::load_from_xlsx;
use sheetlight_lib::engine::backend::EventSink;
use sheetlight_lib::engine::types::{CsvOptions, EngineErrorCode, EngineEvent};

struct Row {
    name: &'static str,
    target: &'static str,
    target_ms: Option<f64>,
    median_ms: Option<f64>,
    detail: String,
    peak_mb: f64,
}

fn generated(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/corpus/generated").join(name)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

#[cfg(windows)]
mod mem {
    #[repr(C)]
    #[allow(non_snake_case)]
    struct ProcessMemoryCounters {
        cb: u32,
        PageFaultCount: u32,
        PeakWorkingSetSize: usize,
        WorkingSetSize: usize,
        QuotaPeakPagedPoolUsage: usize,
        QuotaPagedPoolUsage: usize,
        QuotaPeakNonPagedPoolUsage: usize,
        QuotaNonPagedPoolUsage: usize,
        PagefileUsage: usize,
        PeakPagefileUsage: usize,
    }

    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn K32GetProcessMemoryInfo(process: isize, counters: *mut ProcessMemoryCounters, cb: u32) -> i32;
    }

    /// Peak working set of this process in MB.
    pub fn peak_mb() -> f64 {
        let mut c = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            PageFaultCount: 0,
            PeakWorkingSetSize: 0,
            WorkingSetSize: 0,
            QuotaPeakPagedPoolUsage: 0,
            QuotaPagedPoolUsage: 0,
            QuotaPeakNonPagedPoolUsage: 0,
            QuotaNonPagedPoolUsage: 0,
            PagefileUsage: 0,
            PeakPagefileUsage: 0,
        };
        // SAFETY: plain Win32 call with a correctly sized, initialized struct.
        let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
        if ok == 0 {
            return 0.0;
        }
        c.PeakWorkingSetSize as f64 / (1024.0 * 1024.0)
    }
}

#[cfg(not(windows))]
mod mem {
    pub fn peak_mb() -> f64 {
        0.0
    }
}

fn missing(name: &'static str, target: &'static str, file: &str) -> Row {
    Row {
        name,
        target,
        target_ms: None,
        median_ms: None,
        detail: format!("skipped: {file} missing (python tests/corpus/gen_corpus.py big)"),
        peak_mb: mem::peak_mb(),
    }
}

/// PLAN: open a 10 MB .xlsx (~100k rows x 20 cols) in < 2 s.
/// big_100k.xlsx is 15 MB with 100k formulas, so it is harder than the target.
fn open_xlsx() -> Row {
    let path = generated("big_100k.xlsx");
    if !path.exists() {
        return missing("open_xlsx", "< 2000 ms", "big_100k.xlsx");
    }
    let mut runs = Vec::new();
    let mut eval = Vec::new();
    for _ in 0..3 {
        let t = Instant::now();
        let mut model = load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").expect("load big_100k");
        let load = ms(t);
        let t2 = Instant::now();
        model.evaluate();
        eval.push(ms(t2));
        runs.push(load + eval.last().unwrap());
    }
    Row {
        name: "open_xlsx",
        target: "< 2000 ms",
        target_ms: Some(2000.0),
        median_ms: Some(median(runs)),
        detail: format!("big_100k.xlsx raw IronCalc load + evaluate (evaluate {:.0} ms)", median(eval)),
        peak_mb: mem::peak_mb(),
    }
}

/// PLAN: recalc 100k chained formulas in < 200 ms.
fn recalc_chain() -> Row {
    let path = generated("chain_100k.xlsx");
    if !path.exists() {
        return missing("recalc_chain", "< 200 ms", "chain_100k.xlsx");
    }
    let mut model = load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").expect("load chain_100k");
    model.evaluate();
    let mut runs = Vec::new();
    for i in 0..7 {
        model.set_user_input(0, 1, 1, format!("{}", i + 2)).unwrap();
        let t = Instant::now();
        model.evaluate();
        runs.push(ms(t));
    }
    let last = model.get_formatted_cell_value(0, 100_000, 1).unwrap_or_default();
    Row {
        name: "recalc_chain",
        target: "< 200 ms",
        target_ms: Some(200.0),
        median_ms: Some(median(runs)),
        detail: format!("edit A1 + full evaluate; A100000 = {last}"),
        peak_mb: mem::peak_mb(),
    }
}

/// Informational: one edit on big_100k (IronCalc recalculates everything).
fn edit_big() -> Row {
    let path = generated("big_100k.xlsx");
    if !path.exists() {
        return missing("edit_big", "info (~150 ms)", "big_100k.xlsx");
    }
    let mut model = load_from_xlsx(path.to_str().unwrap(), "en", "UTC", "en").expect("load big_100k");
    model.evaluate();
    let mut runs = Vec::new();
    for i in 0..5 {
        model.set_user_input(0, 2, 7, format!("{}", 10 + i)).unwrap();
        let t = Instant::now();
        model.evaluate();
        runs.push(ms(t));
    }
    Row {
        name: "edit_big",
        target: "info",
        target_ms: None,
        median_ms: Some(median(runs)),
        detail: "set G2 + full evaluate on 2M cells / 100k formulas".into(),
        peak_mb: mem::peak_mb(),
    }
}

/// PLAN: open a 1M-row CSV in < 5 s, browsable while loading.
fn open_csv() -> Row {
    let path = generated("big_1M.csv");
    if !path.exists() {
        return missing("open_csv", "< 5000 ms", "big_1M.csv");
    }
    let (tx, rx) = mpsc::channel::<(Instant, EngineEvent)>();
    let tx = Mutex::new(tx);
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.lock().unwrap().send((Instant::now(), e));
    });
    let t = Instant::now();
    let opened = sheetlight_lib::csv_store::open(path.to_str().unwrap(), &CsvOptions::default(), 1, sink);
    let detect_ms = ms(t);
    let backend = match opened {
        Ok((backend, _)) => backend,
        Err(e) if e.code == EngineErrorCode::Unsupported => {
            return Row {
                name: "open_csv",
                target: "< 5000 ms",
                target_ms: None,
                median_ms: None,
                detail: format!("skipped: {} (WS3 csv_store not on this branch)", e.message),
                peak_mb: mem::peak_mb(),
            }
        }
        Err(e) => panic!("csv_store::open: {e}"),
    };
    let mut first_rows: Option<f64> = None;
    let total = loop {
        match rx.recv_timeout(Duration::from_secs(120)) {
            Ok((at, EngineEvent::LoadProgress { rows_loaded, done, error, .. })) => {
                assert!(error.is_none(), "load error {error:?}");
                if rows_loaded > 0 && first_rows.is_none() {
                    first_rows = Some(at.duration_since(t).as_secs_f64() * 1000.0);
                }
                if done {
                    break at.duration_since(t).as_secs_f64() * 1000.0;
                }
            }
            Ok(_) => {}
            Err(_) => panic!("CSV load did not finish in 120 s"),
        }
    };
    drop(backend);
    Row {
        name: "open_csv",
        target: "< 5000 ms",
        target_ms: Some(5000.0),
        median_ms: Some(total),
        detail: format!(
            "big_1M.csv csv_store; detect {detect_ms:.0} ms, first rows {:.0} ms",
            first_rows.unwrap_or(f64::NAN)
        ),
        peak_mb: mem::peak_mb(),
    }
}

fn main() {
    // `cargo bench` passes `--bench`; everything else is a benchmark name filter.
    let filters: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("--")).collect();
    type Bench = (&'static str, fn() -> Row);
    let all: [Bench; 4] = [("open_xlsx", open_xlsx), ("recalc_chain", recalc_chain), ("edit_big", edit_big), ("open_csv", open_csv)];
    let mut rows = Vec::new();
    for (name, f) in all {
        if !filters.is_empty() && !filters.iter().any(|x| name.contains(x.as_str())) {
            continue;
        }
        eprintln!("running {name}…");
        rows.push(f());
    }

    println!("\n| Benchmark | Target | Median | Verdict | Peak RSS | Detail |");
    println!("|---|---|---|---|---|---|");
    let mut json = Vec::new();
    for r in &rows {
        let verdict = match (r.median_ms, r.target_ms) {
            (Some(v), Some(t)) if v <= t => "PASS",
            (Some(_), Some(_)) => "FAIL",
            (Some(_), None) => "info",
            _ => "skipped",
        };
        let median = r.median_ms.map(|v| format!("{v:.0} ms")).unwrap_or_else(|| "-".into());
        println!("| {} | {} | {median} | {verdict} | {:.0} MB | {} |", r.name, r.target, r.peak_mb, r.detail);
        json.push(serde_json::json!({
            "name": r.name, "target": r.target, "medianMs": r.median_ms, "verdict": verdict,
            "peakMb": r.peak_mb, "detail": r.detail,
        }));
    }
    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/bench/results");
    let _ = std::fs::create_dir_all(&out_dir);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = out_dir.join(format!("engine-{stamp}.json"));
    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let doc = serde_json::json!({ "profile": profile, "results": json });
    if std::fs::write(&file, serde_json::to_string_pretty(&doc).unwrap()).is_ok() {
        eprintln!("wrote {}", file.display());
    }
    if cfg!(debug_assertions) {
        eprintln!("NOTE: debug build; numbers are not comparable with the targets (use `cargo bench`).");
    }
}
