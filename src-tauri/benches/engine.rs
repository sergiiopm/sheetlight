//! Engine benchmarks against the PLAN performance targets (docs/PLAN.md),
//! measured through the engine actor (the same path as the Tauri commands).
//!
//!     cd src-tauri && cargo bench --bench engine                  # all, release profile (what ships)
//!     cd src-tauri && cargo bench --bench engine -- open_csv recalc
//!     cd src-tauri && cargo test --bench engine                   # smoke run, debug build
//!
//! Environment:
//! - `SHEETLIGHT_BENCH_SCALE=0.1` shrinks every generated file (quick runs; not comparable to targets).
//! - `SHEETLIGHT_BENCH_RUNS=n` repetitions per timed step (default 3; median reported).
//!
//! Big files are generated deterministically at bench time into the cargo
//! target dir (`benches/support/data.rs`) and cached there; nothing is
//! committed. Results are printed as a markdown table (also appended to
//! `$GITHUB_STEP_SUMMARY` on CI) and written to
//! `tests/bench/results/engine-<unix time>.json` (git-ignored). Copy the table
//! into docs/qa/benchmarks.md with the machine line.
//!
//! Peak RSS is the process high-water mark, so it only grows: run one
//! benchmark per process when the RAM number matters.

#[allow(dead_code)]
#[path = "../tests/common/actor.rs"]
mod actor;
#[path = "support/data.rs"]
mod data;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use actor::Actor;
use sheetlight_lib::engine::types::*;

struct Row {
    name: &'static str,
    target: &'static str,
    target_ms: Option<f64>,
    median_ms: f64,
    detail: String,
    peak_mb: f64,
}

impl Row {
    fn verdict(&self) -> &'static str {
        if cfg!(debug_assertions) {
            return "n/a (debug)";
        }
        match self.target_ms {
            Some(t) if self.median_ms <= t => "PASS",
            Some(_) => "FAIL",
            None => "info",
        }
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn runs() -> usize {
    std::env::var("SHEETLIGHT_BENCH_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(3).max(1)
}

fn scaled(rows: usize) -> usize {
    let scale: f64 = std::env::var("SHEETLIGHT_BENCH_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
    ((rows as f64 * scale) as usize).max(1000)
}

fn out_path(name: &str) -> PathBuf {
    let dir = data::data_dir().join("out");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

// ---------------------------------------------------------------------------
// Memory (process high-water mark)
// ---------------------------------------------------------------------------

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
    /// Peak resident set (`VmHWM`) in MB; 0 where /proc is not available.
    pub fn peak_mb() -> f64 {
        std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()))
            .map(|kb| kb / 1024.0)
            .unwrap_or(0.0)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn open_timed(actor: &Actor, path: &std::path::Path) -> (DocumentInfo, Duration, Duration) {
    let p = path.to_string_lossy().into_owned();
    let t = Instant::now();
    let info = actor.call(move |s| s.open_document(&p, None)).unwrap_or_else(|e| panic!("open {}: {e}", path.display()));
    let first = t.elapsed();
    let info = if info.loading { actor.wait_loaded(info.doc, Duration::from_secs(600)) } else { info };
    (info, first, t.elapsed())
}

/// Fetches the blocks of a 50-row x 20-col viewport at `row` (2 x 2 blocks
/// when it straddles block edges), as the grid does on a scroll jump.
fn fetch_viewport(actor: &Actor, doc: DocumentId, sheet: SheetId, row: u32) -> (Duration, usize) {
    let (br0, br1) = (row / BLOCK_ROWS, (row + 49) / BLOCK_ROWS);
    let keys: Vec<BlockKey> = (br0..=br1).flat_map(|br| (0..=1).map(move |bc| BlockKey { br, bc })).collect();
    let req = BlockRequest { sheet, keys, known_versions: None, priority: 0 };
    let t = Instant::now();
    let bytes = actor.call(move |s| s.fetch_blocks(doc, &req)).expect("fetchBlocks");
    (t.elapsed(), bytes.len())
}

fn fetch_bench(name: &'static str, actor: &Actor, info: &DocumentInfo, rows: u32, what: &str) -> Row {
    let mut rng = data::Rng::new(7);
    let mut times = Vec::new();
    let mut bytes = 0;
    for i in 0..60 {
        // Alternate far jumps (cold blocks) with the top of the sheet.
        let row = if i % 2 == 0 { rng.below(rows.saturating_sub(60) as u64) as u32 } else { 0 };
        let (t, b) = fetch_viewport(actor, info.doc, info.active_sheet, row);
        times.push(ms(t));
        bytes = bytes.max(b);
    }
    let p95 = {
        let mut v = times.clone();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() * 95 / 100]
    };
    Row {
        name,
        target: "< 16 ms (1 frame @ 60 fps)",
        target_ms: Some(16.0),
        median_ms: median(times),
        detail: format!("{what}: 50x20 viewport (4 blocks) at random rows, p95 {p95:.1} ms, <= {} KB per call", bytes / 1024),
        peak_mb: mem::peak_mb(),
    }
}

fn value(actor: &Actor, doc: DocumentId, sheet: SheetId, row: u32, col: u32) -> f64 {
    match actor.cell(doc, sheet, row, col).value {
        CellValue::Number { value } => value,
        other => panic!("expected a number at ({row},{col}), got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

/// PLAN: open a 1M-row CSV in < 5 s, browsable while loading. Also the
/// Spanish dialect, block fetches on the loaded file and CSV save.
fn csv_benches(filters: &[String]) -> Vec<Row> {
    let rows = scaled(1_000_000);
    let (en, es) = data::big_csv(rows);
    let mut out = Vec::new();
    let actor = Actor::start();
    for (name, path) in [("open_csv", &en), ("open_csv_es", &es)] {
        if !selected(name, filters) {
            continue;
        }
        let mut first = Vec::new();
        let mut done = Vec::new();
        let mut opened = None;
        for _ in 0..runs() {
            let (info, f, d) = open_timed(&actor, path);
            first.push(ms(f));
            done.push(ms(d));
            if let Some(prev) = opened.replace(info) {
                actor.close(prev.doc);
            }
        }
        let info = opened.unwrap();
        let used = actor.sheet_info(info.doc, info.active_sheet).used_range.unwrap();
        assert_eq!(used.r1 as usize, rows, "{name}: every row loaded");
        let csv = info.csv.clone().unwrap_or_default();
        out.push(Row {
            name,
            target: "< 5000 ms",
            target_ms: Some(5000.0),
            median_ms: median(done),
            detail: format!(
                "{} rows x 10, {} MB; browsable after {:.0} ms; detected {:?}/{:?}/{:?}",
                rows + 1,
                std::fs::metadata(path).unwrap().len() / 1_000_000,
                median(first),
                csv.delimiter.unwrap_or_default(),
                csv.encoding.unwrap_or_default(),
                csv.decimal.unwrap_or_default()
            ),
            peak_mb: mem::peak_mb(),
        });
        if name == "open_csv" {
            if selected("fetch_blocks_csv", filters) {
                out.push(fetch_bench("fetch_blocks_csv", &actor, &info, rows as u32, "big CSV store"));
            }
            if selected("save_csv", filters) {
                let target = out_path("big_1M_saved.csv");
                let mut times = Vec::new();
                for _ in 0..runs() {
                    let t = Instant::now();
                    actor.save_as(info.doc, &target, SaveFormat::Csv);
                    times.push(ms(t.elapsed()));
                }
                out.push(Row {
                    name: "save_csv",
                    target: "< 5000 ms (= open budget)",
                    target_ms: Some(5000.0),
                    median_ms: median(times),
                    detail: format!("{rows}-row CSV store -> CSV, {} MB written", std::fs::metadata(&target).unwrap().len() / 1_000_000),
                    peak_mb: mem::peak_mb(),
                });
            }
        }
        actor.close(info.doc);
    }
    out
}

/// PLAN: open a 10 MB .xlsx (~100k rows x 20 cols) in < 2 s; also block
/// fetches, one edit (full recalc on 2M cells) and save.
fn xlsx_benches(filters: &[String]) -> Vec<Row> {
    let rows = scaled(100_000);
    let (path, t2) = data::big_xlsx(rows);
    let size_mb = std::fs::metadata(&path).unwrap().len() as f64 / 1e6;
    let actor = Actor::start();
    let mut out = Vec::new();
    let mut times = Vec::new();
    let mut info = None;
    for _ in 0..runs() {
        let (i, _, d) = open_timed(&actor, &path);
        times.push(ms(d));
        if let Some(prev) = info.replace(i) {
            actor.close(prev.doc);
        }
    }
    let info = info.unwrap();
    let (doc, sheet) = (info.doc, info.active_sheet);
    let got = value(&actor, doc, sheet, 1, 19);
    assert!((got - t2).abs() < 1e-6, "T2 = {got}, expected {t2}");
    if selected("open_xlsx", filters) {
        out.push(Row {
            name: "open_xlsx",
            target: "< 2000 ms",
            target_ms: Some(2000.0),
            median_ms: median(times),
            detail: format!("{} rows x 20 + {rows} formulas, {size_mb:.1} MB; inspect + IronCalc load + evaluate", rows + 1),
            peak_mb: mem::peak_mb(),
        });
    }
    if selected("fetch_blocks_xlsx", filters) {
        out.push(fetch_bench("fetch_blocks_xlsx", &actor, &info, rows as u32, "big_100k workbook"));
    }
    if selected("edit_big", filters) {
        let mut times = Vec::new();
        let mut engine_ms = Vec::new();
        for i in 0..runs() {
            let t = Instant::now();
            let r = actor.set(doc, sheet, 1, 6, &format!("{}", 10 + i));
            times.push(ms(t.elapsed()));
            engine_ms.push(r.elapsed_ms);
        }
        out.push(Row {
            name: "edit_big",
            target: "info (~150 ms)",
            target_ms: None,
            median_ms: median(times),
            detail: format!("setCells G2 + full recalc of {} cells / {rows} formulas (engine {:.0} ms)", rows * 20, median(engine_ms)),
            peak_mb: mem::peak_mb(),
        });
    }
    if selected("save_xlsx", filters) {
        let target = out_path("big_100k_saved.xlsx");
        let mut times = Vec::new();
        for _ in 0..runs() {
            let t = Instant::now();
            actor.save_as(doc, &target, SaveFormat::Xlsx);
            times.push(ms(t.elapsed()));
        }
        out.push(Row {
            name: "save_xlsx",
            target: "< 2000 ms (= open budget)",
            target_ms: Some(2000.0),
            median_ms: median(times),
            detail: format!("IronCalc export + post_process + atomic write, {:.1} MB", std::fs::metadata(&target).unwrap().len() as f64 / 1e6),
            peak_mb: mem::peak_mb(),
        });
    }
    out
}

/// PLAN: recalc 100k chained formulas in < 200 ms.
fn recalc_chain() -> Row {
    let rows = scaled(100_000);
    let path = data::chain_xlsx(rows);
    let actor = Actor::start();
    let (info, _, _) = open_timed(&actor, &path);
    let (doc, sheet) = (info.doc, info.active_sheet);
    assert_eq!(value(&actor, doc, sheet, rows as u32 - 1, 0), rows as f64);
    let mut times = Vec::new();
    let mut engine_ms = Vec::new();
    for i in 0..runs().max(5) {
        let t = Instant::now();
        let r = actor.set(doc, sheet, 0, 0, &format!("{}", i + 2));
        times.push(ms(t.elapsed()));
        engine_ms.push(r.elapsed_ms);
    }
    let last = value(&actor, doc, sheet, rows as u32 - 1, 0);
    assert_eq!(last, (rows + runs().max(5)) as f64, "chain end after the last edit");
    Row {
        name: "recalc_chain",
        target: "< 200 ms",
        target_ms: Some(200.0),
        median_ms: median(times),
        detail: format!("setCells A1 + full recalc of {rows} chained formulas (engine {:.0} ms)", median(engine_ms)),
        peak_mb: mem::peak_mb(),
    }
}

fn selected(name: &str, filters: &[String]) -> bool {
    filters.is_empty() || filters.iter().any(|f| name.contains(f.as_str()))
}

fn machine() -> String {
    let cpu = if cfg!(windows) {
        std::env::var("PROCESSOR_IDENTIFIER").unwrap_or_default()
    } else {
        std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|s| s.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()))
            .unwrap_or_default()
    };
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    format!("{} {} · {cpu} · {cores} logical cores", std::env::consts::OS, std::env::consts::ARCH)
}

fn main() {
    // `cargo bench` passes `--bench`; everything else is a benchmark name filter.
    let filters: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with("--")).collect();
    let mut rows = Vec::new();
    let csv_names = ["open_csv", "open_csv_es", "fetch_blocks_csv", "save_csv"];
    if csv_names.iter().any(|n| selected(n, &filters)) {
        eprintln!("running CSV benchmarks…");
        rows.extend(csv_benches(&filters));
    }
    let xlsx_names = ["open_xlsx", "fetch_blocks_xlsx", "edit_big", "save_xlsx"];
    if xlsx_names.iter().any(|n| selected(n, &filters)) {
        eprintln!("running xlsx benchmarks…");
        rows.extend(xlsx_benches(&filters));
    }
    if selected("recalc_chain", &filters) {
        eprintln!("running recalc_chain…");
        rows.push(recalc_chain());
    }

    let profile = if cfg!(debug_assertions) { "debug" } else { "release" };
    let scale = std::env::var("SHEETLIGHT_BENCH_SCALE").unwrap_or_else(|_| "1".into());
    let mut table = format!("Machine: {} · profile {profile} · scale {scale} · runs {}\n\n", machine(), runs());
    table.push_str("| Benchmark | Target | Median | Verdict | Peak RSS | Detail |\n|---|---|---|---|---|---|\n");
    let mut json = Vec::new();
    for r in &rows {
        table.push_str(&format!(
            "| {} | {} | {:.0} ms | {} | {:.0} MB | {} |\n",
            r.name,
            r.target,
            r.median_ms,
            r.verdict(),
            r.peak_mb,
            r.detail
        ));
        json.push(serde_json::json!({
            "name": r.name, "target": r.target, "targetMs": r.target_ms, "medianMs": r.median_ms,
            "verdict": r.verdict(), "peakMb": r.peak_mb, "detail": r.detail,
        }));
    }
    println!("\n{table}");
    if let Ok(summary) = std::env::var("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(summary) {
            let _ = writeln!(f, "## Engine benchmarks\n\n{table}");
        }
    }
    let out_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/bench/results");
    let _ = std::fs::create_dir_all(&out_dir);
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let file = out_dir.join(format!("engine-{stamp}.json"));
    let doc = serde_json::json!({ "machine": machine(), "profile": profile, "scale": scale, "runs": runs(), "results": json });
    if std::fs::write(&file, serde_json::to_string_pretty(&doc).unwrap()).is_ok() {
        eprintln!("wrote {}", file.display());
    }
    if cfg!(debug_assertions) {
        eprintln!("NOTE: debug build; numbers are not comparable with the targets (use `cargo bench`).");
    }
}
