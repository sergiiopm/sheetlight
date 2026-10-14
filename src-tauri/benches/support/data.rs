//! Deterministic big files for the benchmarks, generated at bench time (never
//! committed). Same shapes as the Phase 0 spike corpus
//! (`tests/corpus/corpus_lib/big.py`), written natively so CI needs no Python:
//!
//! - `big_1M.csv`      1M rows x 10 cols, UTF-8, `,`, ISO dates (~80 MB)
//! - `big_1M_es.csv`   the same rows as a Spanish export: BOM, `;`, decimal comma, dd/mm/yyyy
//! - `big_100k.xlsx`   100k rows x 20 cols, 19 value columns + a ROUND formula (2M cells, 100k formulas)
//! - `chain_100k.xlsx` A1=1, A2=A1+1 … A100000 (recalc target)
//!
//! Files are cached in the cargo target dir by name and row count.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

const CATS: [&str; 8] = ["Alquiler", "Nóminas", "Suministros", "Marketing", "Software", "Viajes", "Material", "Impuestos"];
const CITIES: [&str; 8] = ["Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao", "Zaragoza", "Málaga", "Murcia"];
const WORDS: [&str; 20] = [
    "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor",
    "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua", "enim",
];

/// xorshift64*: tiny, deterministic, good enough for synthetic data.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    pub fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    pub fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.below(items.len() as u64) as usize]
    }
}

/// (year, month, day) of `days` after 2015-01-01 (civil-from-days, no deps).
fn ymd(days_since_2015: i64) -> (i64, u32, u32) {
    let z = days_since_2015 + 16_436 + 719_468; // 2015-01-01 is day 16436 since 1970-01-01
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

pub fn data_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("bench-data");
    std::fs::create_dir_all(&dir).expect("bench data dir");
    dir
}

fn cached(name: &str, rows: usize, write: impl FnOnce(&Path)) -> PathBuf {
    let path = data_dir().join(format!("{rows}-{name}"));
    if !path.exists() {
        let tmp = path.with_extension("partial");
        let started = std::time::Instant::now();
        write(&tmp);
        std::fs::rename(&tmp, &path).expect("rename generated file");
        eprintln!("  generated {} in {:.1} s", path.display(), started.elapsed().as_secs_f64());
    }
    path
}

/// Both CSV dialects from the same rows: (`big_1M.csv`, `big_1M_es.csv`).
pub fn big_csv(rows: usize) -> (PathBuf, PathBuf) {
    let en = data_dir().join(format!("{rows}-big_1M.csv"));
    let es = data_dir().join(format!("{rows}-big_1M_es.csv"));
    if en.exists() && es.exists() {
        return (en, es);
    }
    let started = std::time::Instant::now();
    let mut fen = BufWriter::with_capacity(1 << 20, File::create(&en).unwrap());
    let mut fes = BufWriter::with_capacity(1 << 20, File::create(&es).unwrap());
    let header = "id,fecha,categoria,ciudad,cliente,cantidad,precio,coste,ratio,nota";
    writeln!(fen, "{header}").unwrap();
    fes.write_all(b"\xEF\xBB\xBF").unwrap();
    write!(fes, "{}\r\n", header.replace(',', ";")).unwrap();
    let mut rng = Rng::new(2);
    let mut line = String::with_capacity(160);
    for r in 1..=rows {
        let (y, m, d) = ymd(rng.below(3000) as i64);
        let cat = rng.pick(&CATS);
        let city = rng.pick(&CITIES);
        let client = rng.below(5000);
        let qty = 1 + rng.below(499);
        let price = 1.0 + rng.unit() * 998.0;
        let cost = 1.0 + rng.unit() * 4999.0;
        let ratio = rng.unit();
        let note = rng.pick(&WORDS);
        line.clear();
        write!(line, "{r},{y:04}-{m:02}-{d:02},{cat},{city},Cliente {client:04},{qty},{price:.2},{cost:.2},{ratio:.6},{note}").unwrap();
        writeln!(fen, "{line}").unwrap();
        line.clear();
        write!(line, "{r};{d:02}/{m:02}/{y:04};{cat};{city};Cliente {client:04};{qty};{price:.2};{cost:.2};{ratio:.6};{note}").unwrap();
        // Decimal comma only in the three decimal fields (after the 6th `;`).
        let cut = line.match_indices(';').nth(5).map(|(i, _)| i).unwrap();
        let (head, tail) = line.split_at(cut);
        write!(fes, "{head}{}\r\n", tail.replace('.', ",")).unwrap();
    }
    fen.flush().unwrap();
    fes.flush().unwrap();
    eprintln!("  generated {rows}-row CSVs in {:.1} s", started.elapsed().as_secs_f64());
    (en, es)
}

// ---------------------------------------------------------------------------
// Minimal SpreadsheetML writer (shared strings, three cell styles)
// ---------------------------------------------------------------------------

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>"#;
const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;
const WORKBOOK_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>"#;
const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>"#;

fn col_name(mut col: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push(b'A' + (col % 26) as u8);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

struct Strings {
    index: HashMap<String, usize>,
    list: Vec<String>,
}

impl Strings {
    fn id(&mut self, s: &str) -> usize {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        self.list.push(s.to_string());
        self.index.insert(s.to_string(), self.list.len() - 1);
        self.list.len() - 1
    }
}

fn write_xlsx(path: &Path, sheet_name: &str, sheet_data: &str, strings: &Strings, max_ref: &str) {
    let file = BufWriter::new(File::create(path).unwrap());
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut put = |name: &str, body: &str| {
        zip.start_file(name, options).unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    };
    put("[Content_Types].xml", CONTENT_TYPES);
    put("_rels/.rels", ROOT_RELS);
    put("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
    put(
        "xl/workbook.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="{sheet_name}" sheetId="1" r:id="rId1"/></sheets></workbook>"#
        ),
    );
    put("xl/styles.xml", STYLES);
    let mut sst = String::with_capacity(strings.list.len() * 24);
    write!(
        sst,
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{0}" uniqueCount="{0}">"#,
        strings.list.len()
    )
    .unwrap();
    for s in &strings.list {
        write!(sst, "<si><t>{}</t></si>", xml_escape(s)).unwrap();
    }
    sst.push_str("</sst>");
    put("xl/sharedStrings.xml", &sst);
    put(
        "xl/worksheets/sheet1.xml",
        &format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:{max_ref}"/><sheetData>{sheet_data}</sheetData></worksheet>"#
        ),
    );
    zip.finish().unwrap();
}

/// 100k rows x 20 cols: 19 typed value columns plus `T = ROUND(G*H*(1-I),2)`.
/// Returns the path and the expected value of T2.
pub fn big_xlsx(rows: usize) -> (PathBuf, f64) {
    let mut t2 = 0.0;
    let path = cached("big_100k.xlsx", rows, |tmp| {
        let mut rng = Rng::new(1);
        let mut strings = Strings { index: HashMap::new(), list: Vec::new() };
        let header = [
            "Id", "Fecha", "Categoria", "Ciudad", "Cliente", "Descripcion", "Cantidad", "Precio", "Descuento", "Coste",
            "Unidades", "Peso", "Ratio", "Codigo", "Activo", "Score", "Lat", "Lon", "Nota", "Total",
        ];
        let mut xml = String::with_capacity(rows * 600);
        xml.push_str(r#"<row r="1">"#);
        for (c, h) in header.iter().enumerate() {
            write!(xml, r#"<c r="{}1" t="s"><v>{}</v></c>"#, col_name(c), strings.id(h)).unwrap();
        }
        xml.push_str("</row>");
        let mut desc = String::new();
        for r in 2..=rows + 1 {
            write!(xml, r#"<row r="{r}">"#).unwrap();
            let num = |xml: &mut String, c: usize, s: u8, v: f64| {
                write!(xml, r#"<c r="{}{r}" s="{s}"><v>{v}</v></c>"#, col_name(c)).unwrap();
            };
            num(&mut xml, 0, 0, (r - 1) as f64);
            num(&mut xml, 1, 1, (43_831 + rng.below(2000)) as f64);
            let text = |xml: &mut String, c: usize, s: &str, strings: &mut Strings| {
                write!(xml, r#"<c r="{}{r}" t="s"><v>{}</v></c>"#, col_name(c), strings.id(s)).unwrap();
            };
            text(&mut xml, 2, rng.pick(&CATS), &mut strings);
            text(&mut xml, 3, rng.pick(&CITIES), &mut strings);
            text(&mut xml, 4, &format!("Cliente {:04}", rng.below(5000)), &mut strings);
            desc.clear();
            for k in 0..4 {
                if k > 0 {
                    desc.push(' ');
                }
                desc.push_str(rng.pick(&WORDS));
            }
            text(&mut xml, 5, &desc, &mut strings);
            let qty = (1 + rng.below(499)) as f64;
            let price = ((1.0 + rng.unit() * 998.0) * 100.0).round() / 100.0;
            let disc = (rng.unit() * 0.3 * 1000.0).round() / 1000.0;
            let total = (qty * price * (1.0 - disc) * 100.0).round() / 100.0;
            if r == 2 {
                t2 = total;
            }
            num(&mut xml, 6, 0, qty);
            num(&mut xml, 7, 2, price);
            num(&mut xml, 8, 0, disc);
            num(&mut xml, 9, 2, ((1.0 + rng.unit() * 4999.0) * 100.0).round() / 100.0);
            num(&mut xml, 10, 0, rng.below(1000) as f64);
            num(&mut xml, 11, 0, (rng.unit() * 100_000.0).round() / 1000.0);
            num(&mut xml, 12, 0, rng.unit());
            text(&mut xml, 13, &format!("SKU-{:06}", rng.below(1_000_000)), &mut strings);
            write!(xml, r#"<c r="O{r}" t="b"><v>{}</v></c>"#, u8::from(rng.unit() > 0.5)).unwrap();
            num(&mut xml, 15, 0, rng.below(100) as f64);
            num(&mut xml, 16, 0, ((36.0 + rng.unit() * 7.0) * 1e5).round() / 1e5);
            num(&mut xml, 17, 0, ((-9.0 + rng.unit() * 12.0) * 1e5).round() / 1e5);
            text(&mut xml, 18, rng.pick(&WORDS), &mut strings);
            // Cached result, as Excel writes it (the engine recalculates on open anyway).
            write!(xml, r#"<c r="T{r}"><f>ROUND(G{r}*H{r}*(1-I{r}),2)</f><v>{total}</v></c></row>"#).unwrap();
        }
        write_xlsx(tmp, "Data", &xml, &strings, &format!("T{}", rows + 1));
    });
    if t2 == 0.0 {
        // Cached file: recompute T2 from the same seed (first data row only).
        let mut rng = Rng::new(1);
        rng.below(2000);
        rng.below(8);
        rng.below(8);
        rng.below(5000);
        for _ in 0..4 {
            rng.below(20);
        }
        let qty = (1 + rng.below(499)) as f64;
        let price = ((1.0 + rng.unit() * 998.0) * 100.0).round() / 100.0;
        let disc = (rng.unit() * 0.3 * 1000.0).round() / 1000.0;
        t2 = (qty * price * (1.0 - disc) * 100.0).round() / 100.0;
    }
    (path, t2)
}

/// A1 = 1, A(n) = A(n-1) + 1.
pub fn chain_xlsx(rows: usize) -> PathBuf {
    cached("chain_100k.xlsx", rows, |tmp| {
        let mut xml = String::with_capacity(rows * 48);
        xml.push_str(r#"<row r="1"><c r="A1"><v>1</v></c></row>"#);
        for r in 2..=rows {
            write!(xml, r#"<row r="{r}"><c r="A{r}"><f>A{}+1</f><v>{r}</v></c></row>"#, r - 1).unwrap();
        }
        let strings = Strings { index: HashMap::new(), list: Vec::new() };
        write_xlsx(tmp, "Chain", &xml, &strings, &format!("A{rows}"));
    })
}
