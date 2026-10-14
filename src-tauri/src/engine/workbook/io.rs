//! Building workbook backends: new documents, xlsx load/export, neutral
//! imports (`ImportedWorkbook`, e.g. legacy `.xls`) and small CSVs read
//! straight into an IronCalc model (fallback when the CSV store is not used).

use std::collections::HashMap;
use std::io::Cursor;

use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::load_from_xlsx_bytes;
use ironcalc_base::Model;

use super::display::parse_plain_number;
use super::locale_in::{parse_local, LocalValue};
use super::units::px_to_chars;
use super::{area, SheetExtra, WorkbookBackend};
use crate::engine::backend::ImportedWorkbook;
use crate::engine::types::*;

/// Model locale: `en` keeps formulas in en-US syntax (`,` separates arguments).
pub const MODEL_LOCALE: &str = "en";
pub const MODEL_LANGUAGE: &str = "en";
pub const DEFAULT_TIMEZONE: &str = "Europe/Madrid";
/// Name of the first sheet of a new workbook (Excel es-ES).
pub const FIRST_SHEET_NAME: &str = "Hoja1";

fn parse_error(message: impl std::fmt::Display) -> EngineError {
    eprintln!("[engine] load error: {message}");
    EngineError::new(EngineErrorCode::Parse, "No se pudo leer el archivo: el formato no es válido o está dañado.")
}

fn empty_model(name: &str) -> EngineResult<Model<'static>> {
    let mut model = Model::new_empty("Libro1", MODEL_LOCALE, DEFAULT_TIMEZONE, MODEL_LANGUAGE)
        .map_err(|e| EngineError::internal(format!("No se pudo crear el libro: {e}")))?;
    model
        .rename_sheet_by_index(0, FIRST_SHEET_NAME)
        .map_err(|e| EngineError::internal(format!("No se pudo crear el libro: {e}")))?;
    model.workbook.name = name.to_string();
    Ok(model)
}

/// A new, empty workbook with one sheet (`Hoja1`).
pub fn new_workbook() -> EngineResult<WorkbookBackend> {
    Ok(WorkbookBackend::from_model(empty_model("Libro1")?, Vec::new()))
}

/// Parses xlsx bytes into an IronCalc model (locale `en`).
pub fn load_xlsx(bytes: &[u8], name: &str) -> EngineResult<Model<'static>> {
    let workbook = load_from_xlsx_bytes(bytes, name, MODEL_LOCALE, DEFAULT_TIMEZONE).map_err(|e| parse_error(e.user_message()))?;
    let mut model = Model::from_workbook(workbook, MODEL_LANGUAGE).map_err(parse_error)?;
    model.evaluate();
    Ok(model)
}

/// Fresh xlsx bytes for a model (IronCalc writes a brand-new package).
pub fn export_xlsx(model: &Model<'_>) -> EngineResult<Vec<u8>> {
    let cursor = save_xlsx_to_writer(model, Cursor::new(Vec::new())).map_err(|e| {
        eprintln!("[engine] xlsx export error: {}", e.user_message());
        EngineError::io("No se pudo generar el archivo .xlsx.")
    })?;
    Ok(cursor.into_inner())
}

/// Builds a model from a neutral import (legacy `.xls`).
pub fn import_workbook(imported: ImportedWorkbook, name: &str) -> EngineResult<WorkbookBackend> {
    let mut model = empty_model(name)?;
    for (index, sheet) in imported.sheets.iter().enumerate() {
        let index = index as u32;
        if index > 0 {
            model.add_sheet(&sheet.name).map_err(|e| EngineError::internal(e.to_string()))?;
        } else if !sheet.name.is_empty() && sheet.name != FIRST_SHEET_NAME {
            model.rename_sheet_by_index(0, &sheet.name).map_err(|e| EngineError::internal(e.to_string()))?;
        }
        for (row, col, input) in &sheet.cells {
            if *row >= MAX_ROWS || *col >= MAX_COLS {
                continue;
            }
            let _ = model.set_user_input(index, *row as i32 + 1, *col as i32 + 1, input.clone());
        }
        for (col, px) in &sheet.col_widths {
            let _ = model.set_column_width(index, *col as i32 + 1, px_to_chars(*px) * ironcalc_base::COLUMN_WIDTH_FACTOR);
        }
        for merge in &sheet.merges {
            let _ = model.merge_cells(&area(index, merge));
        }
    }
    if imported.sheets.is_empty() {
        return Ok(WorkbookBackend::from_model(model, Vec::new()));
    }
    model.evaluate();
    let extras = (0..imported.sheets.len()).map(|i| SheetExtra { original_index: Some(i), ..SheetExtra::default() }).collect();
    Ok(WorkbookBackend::from_model(model, extras))
}

/// Result of a small CSV import into a workbook model.
pub struct CsvImport {
    pub backend: WorkbookBackend,
    /// Options actually used (detected where the caller passed `None`).
    pub options: CsvOptions,
}

/// Decodes CSV bytes: UTF-8 (± BOM), UTF-16LE (BOM) or Windows-1252.
pub fn decode_text(bytes: &[u8], encoding: Option<&str>) -> (String, &'static str) {
    let utf16 = |data: &[u8]| -> String {
        let units: Vec<u16> = data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    };
    match encoding {
        Some("utf-16le") => return (utf16(bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes)), "utf-16le"),
        Some("windows-1252") => return (decode_1252(bytes), "windows-1252"),
        Some("utf-8") => {
            let data = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
            return (String::from_utf8_lossy(data).into_owned(), "utf-8");
        }
        _ => {}
    }
    if let Some(rest) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        return (String::from_utf8_lossy(rest).into_owned(), "utf-8");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return (utf16(rest), "utf-16le");
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "utf-8"),
        Err(_) => (decode_1252(bytes), "windows-1252"),
    }
}

/// Windows-1252 → UTF-8 (0x80–0x9F differ from Latin-1).
fn decode_1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“',
        '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| if (0x80..0xa0).contains(&b) { HIGH[(b - 0x80) as usize] } else { char::from(b) })
        .collect()
}

/// Picks the delimiter that splits the first lines most consistently.
pub fn detect_delimiter(text: &str) -> char {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(20).collect();
    let mut best = (';', 0usize, false);
    for candidate in [';', ',', '\t', '|'] {
        let counts: Vec<usize> = lines.iter().map(|l| count_outside_quotes(l, candidate)).collect();
        let first = counts.first().copied().unwrap_or(0);
        if first == 0 {
            continue;
        }
        let consistent = counts.iter().all(|c| *c == first);
        let better = match (consistent, best.2) {
            (true, false) => true,
            (false, true) => false,
            _ => first > best.1,
        };
        if better {
            best = (candidate, first, consistent);
        }
    }
    best.0
}

fn count_outside_quotes(line: &str, delimiter: char) -> usize {
    let mut quoted = false;
    let mut count = 0;
    for ch in line.chars() {
        if ch == '"' {
            quoted = !quoted;
        } else if ch == delimiter && !quoted {
            count += 1;
        }
    }
    count
}

/// `,` when numbers look Spanish (`1.234,5`, `3,25`), else `.`.
pub fn detect_decimal(rows: &[Vec<String>], delimiter: char) -> char {
    if delimiter == ',' {
        return '.';
    }
    let (mut comma, mut dot) = (0, 0);
    for field in rows.iter().take(200).flatten() {
        let f = field.trim().trim_start_matches('-');
        if f.is_empty() || !f.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
            continue;
        }
        match (f.matches(',').count(), f.matches('.').count()) {
            (1, _) => comma += 1,
            (0, 1) if f.split('.').nth(1).is_some_and(|d| d.len() != 3) => dot += 1,
            _ => {}
        }
    }
    if dot > comma {
        '.'
    } else {
        ','
    }
}

/// Reads a CSV into a one-sheet workbook. Used when the fast CSV store is not
/// available; values are typed like Excel es-ES would (numbers, dates, %).
pub fn import_csv_small(bytes: &[u8], options: &CsvOptions, name: &str) -> EngineResult<CsvImport> {
    let (text, encoding) = decode_text(bytes, options.encoding.as_deref());
    let delimiter = options
        .delimiter
        .as_deref()
        .and_then(|d| d.chars().next())
        .unwrap_or_else(|| detect_delimiter(&text));
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter as u8)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());
    let mut rows: Vec<Vec<String>> = Vec::new();
    for record in reader.records() {
        let record = record.map_err(parse_error)?;
        if rows.len() as u32 >= MAX_ROWS {
            return Err(EngineError::new(EngineErrorCode::TooLarge, "El archivo tiene más filas de las que admite una hoja."));
        }
        rows.push(record.iter().map(str::to_string).collect());
    }
    let decimal = options.decimal.as_deref().and_then(|d| d.chars().next()).unwrap_or_else(|| detect_decimal(&rows, delimiter));

    let mut model = empty_model(name)?;
    let mut fmt_styles: HashMap<String, i32> = HashMap::new();
    for (r, row) in rows.iter().enumerate() {
        let ir = r as i32 + 1;
        for (c, field) in row.iter().enumerate().take(MAX_COLS as usize) {
            let ic = c as i32 + 1;
            write_csv_field(&mut model, ir, ic, field, decimal, &mut fmt_styles)?;
        }
    }
    model.evaluate();
    let used = CsvOptions {
        delimiter: Some(delimiter.to_string()),
        encoding: Some(encoding.to_string()),
        decimal: Some(decimal.to_string()),
    };
    Ok(CsvImport { backend: WorkbookBackend::from_model(model, Vec::new()), options: used })
}

fn write_csv_field(
    model: &mut Model<'static>,
    row: i32,
    col: i32,
    field: &str,
    decimal: char,
    fmt_styles: &mut HashMap<String, i32>,
) -> EngineResult<()> {
    let ic = |e: String| EngineError::internal(e);
    if field.is_empty() {
        return Ok(());
    }
    if field.starts_with('=') && field.len() > 1 {
        return model.set_user_input(0, row, col, field.to_string()).map_err(ic);
    }
    let local = if decimal == '.' {
        match parse_plain_number(field.trim()) {
            Some(n) => super::locale_in::Local { value: LocalValue::Number(n), num_fmt: None },
            None => {
                let parsed = parse_local(field);
                match parsed.value {
                    // `1.5` in es would be text; only dates / bools / errors are safe here.
                    LocalValue::Number(_) if parsed.num_fmt.is_none() => {
                        super::locale_in::Local { value: LocalValue::Text(field.to_string()), num_fmt: None }
                    }
                    _ => parsed,
                }
            }
        }
    } else {
        parse_local(field)
    };
    match local.value {
        LocalValue::Empty => {}
        LocalValue::Number(n) => {
            model.update_cell_with_number(0, row, col, n).map_err(ic)?;
            if let Some(fmt) = local.num_fmt {
                match fmt_styles.get(&fmt) {
                    Some(index) => model.workbook.worksheet_mut(0).map_err(ic)?.set_cell_style(row, col, *index).map_err(ic)?,
                    None => {
                        let mut style = model.get_style_for_cell(0, row, col).map_err(ic)?;
                        style.num_fmt = fmt.clone();
                        model.set_cell_style(0, row, col, &style).map_err(ic)?;
                        let index = model.get_cell_style_index(0, row, col).map_err(ic)?;
                        fmt_styles.insert(fmt, index);
                    }
                }
            }
        }
        LocalValue::Bool(v) => model.update_cell_with_bool(0, row, col, v).map_err(ic)?,
        LocalValue::Error(e) => model.set_user_input(0, row, col, e).map_err(ic)?,
        LocalValue::Text(t) => model.update_cell_with_text(0, row, col, &t).map_err(ic)?,
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_delimiters_and_decimals() {
        assert_eq!(detect_delimiter("a;b;c\n1;2;3\n"), ';');
        assert_eq!(detect_delimiter("a,b,c\n1,2,3\n"), ',');
        assert_eq!(detect_delimiter("a\tb\n\"x;y\"\t2\n"), '\t');
        let rows = vec![vec!["1,5".to_string(), "3.000,25".to_string()]];
        assert_eq!(detect_decimal(&rows, ';'), ',');
        let rows = vec![vec!["1.5".to_string(), "2.25".to_string()]];
        assert_eq!(detect_decimal(&rows, ';'), '.');
    }

    #[test]
    fn decodes_bom_and_1252() {
        assert_eq!(decode_text(&[0xef, 0xbb, 0xbf, b'a'], None), ("a".to_string(), "utf-8"));
        assert_eq!(decode_text(&[0xff, 0xfe, b'h', 0, b'i', 0], None).0, "hi");
        assert_eq!(decode_text(&[b'A', 0xf1, 0x80], None), ("Añ€".to_string(), "windows-1252"));
    }
}
