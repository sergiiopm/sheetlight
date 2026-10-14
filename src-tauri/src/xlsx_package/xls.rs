//! Legacy `.xls` (BIFF8) import through calamine: values, formulas (en-US,
//! as calamine decodes them), dates (serials + a date format) and merges.
//! Styles, column widths, charts and comments are not read (reported by the
//! engine as a `.xls` limitation).

use std::collections::HashMap;
use std::io::Cursor;

use calamine::{Data, Reader, SheetType, Xls, XlsError};

use crate::csv_store::{write_number_input, write_text_input};
use crate::engine::backend::{ImportedSheet, ImportedWorkbook};
use crate::engine::types::{CellRange, EngineError, EngineErrorCode, EngineResult};

/// Days between the 1904 and the 1900 date systems.
const EPOCH_1904_SHIFT: f64 = 1462.0;

fn map_error(error: XlsError, bytes: &[u8]) -> EngineError {
    if bytes.starts_with(b"PK\x03\x04") {
        return EngineError::new(EngineErrorCode::Parse, "El archivo tiene extensión .xls pero es un libro .xlsx. Cámbiale la extensión a .xlsx para abrirlo.");
    }
    match error {
        XlsError::Password => EngineError::new(EngineErrorCode::Protected, "El archivo está protegido con contraseña."),
        _ => EngineError::new(EngineErrorCode::Parse, "No se pudo leer el archivo .xls: está dañado o no es un libro de Excel 97-2003."),
    }
}

pub fn import_xls(bytes: &[u8]) -> EngineResult<ImportedWorkbook> {
    let mut workbook: Xls<Cursor<&[u8]>> = Xls::new(Cursor::new(bytes)).map_err(|e| map_error(e, bytes))?;
    let shift = if workbook.has_1904_epoch() { EPOCH_1904_SHIFT } else { 0.0 };
    let metas: Vec<_> = workbook.sheets_metadata().iter().filter(|m| m.typ == SheetType::WorkSheet).map(|m| m.name.clone()).collect();
    let mut out = ImportedWorkbook::default();
    for name in metas {
        let values = workbook.worksheet_range(&name).map_err(|e| map_error(e, bytes))?;
        // Formulas are optional: a sheet whose formulas fail to decode still
        // opens with its cached values.
        let mut formulas: HashMap<(u32, u32), String> = HashMap::new();
        if let Ok(range) = workbook.worksheet_formula(&name) {
            let (r0, c0) = range.start().unwrap_or((0, 0));
            for (r, c, f) in range.used_cells() {
                if !f.is_empty() {
                    formulas.insert((r0 + r as u32, c0 + c as u32), f.clone());
                }
            }
        }
        let mut sheet = ImportedSheet { name: name.clone(), ..ImportedSheet::default() };
        let mut formats = FormatRuns::default();
        let (r0, c0) = values.start().unwrap_or((0, 0));
        for (r, c, value) in values.used_cells() {
            let (row, col) = (r0 + r as u32, c0 + c as u32);
            let mut input = String::new();
            let formula = formulas.remove(&(row, col)).and_then(|f| repair_formula(&f));
            if let Some(formula) = formula {
                input.push('=');
                input.push_str(&formula);
            } else {
                match value {
                    Data::Empty => continue,
                    Data::Int(i) => input.push_str(&i.to_string()),
                    Data::Float(f) => write_number_input(*f, &mut input),
                    Data::Bool(b) => input.push_str(if *b { "TRUE" } else { "FALSE" }),
                    Data::String(s) => write_text_input(s, &mut input),
                    Data::DateTimeIso(s) | Data::DurationIso(s) => write_text_input(s, &mut input),
                    Data::Error(e) => input.push_str(&e.to_string()),
                    Data::DateTime(dt) => write_number_input(dt.as_f64() + shift, &mut input),
                }
            }
            if let Data::DateTime(dt) = value {
                formats.add(row, col, date_format(dt.as_f64() + shift, dt.is_duration()));
            }
            sheet.cells.push((row, col, input));
        }
        // Formula cells without a cached value.
        let mut rest: Vec<_> = formulas.into_iter().collect();
        rest.sort_unstable_by_key(|(k, _)| *k);
        for ((row, col), f) in rest {
            if let Some(f) = repair_formula(&f) {
                sheet.cells.push((row, col, format!("={f}")));
            }
        }
        sheet.cells.sort_by_key(|(r, c, _)| (*r, *c));
        sheet.number_formats = formats.finish();
        sheet.merges = workbook
            .merge_cells_by_sheet_name(&name)
            .unwrap_or_default()
            .into_iter()
            .map(|d| CellRange { r0: d.start.0, c0: d.start.1, r1: d.end.0, c1: d.end.1 })
            .collect();
        out.sheets.push(sheet);
    }
    Ok(out)
}

/// Fixes the references calamine 0.36 renders from BIFF8 formulas, or
/// returns None when the formula cannot be trusted (the caller then keeps the
/// cell's cached value).
///
/// calamine prints area references (`tArea`) without masking the relative
/// flags out of the column field and drops the most significant base-26
/// digit of any column >= 26. For flagged areas the dropped digit is
/// recovered (the candidate with the smallest column wins, which is exact for
/// any real sheet); other references with two or more column letters are
/// ambiguous and make the formula unreliable.
fn repair_formula(formula: &str) -> Option<String> {
    let bytes = formula.as_bytes();
    let mut out = String::with_capacity(formula.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'"' || b == b'\'' {
            // String literal or quoted sheet name: copy through the closing quote.
            let close = formula[i + 1..].find(b as char).map_or(formula.len(), |p| i + 1 + p + 1);
            out.push_str(&formula[i..close]);
            i = close;
            continue;
        }
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_' || bytes[i - 1] == b'.');
        if boundary && (b == b'$' || b.is_ascii_alphabetic()) {
            if let Some((len, col_abs, letters, row_abs, digits)) = reference_at(&formula[i..]) {
                if letters.len() == 1 {
                    out.push_str(&formula[i..i + len]);
                } else if col_abs && row_abs {
                    out.push_str(&repair_area_reference(letters, digits)?);
                } else {
                    return None;
                }
                i += len;
                continue;
            }
            // A name or a function: copy the whole word.
            let end = formula[i + 1..].find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '$')).map_or(formula.len(), |p| i + 1 + p);
            out.push_str(&formula[i..end]);
            i = end;
            continue;
        }
        let ch = formula[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    Some(out)
}

/// `$?LETTERS$?DIGITS` at the start of `text`, not followed by a name
/// character or `(`: (length, col `$`, letters, row `$`, digits).
fn reference_at(text: &str) -> Option<(usize, bool, &str, bool, &str)> {
    let bytes = text.as_bytes();
    let col_abs = bytes.first() == Some(&b'$');
    let mut i = usize::from(col_abs);
    let l0 = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        i += 1;
    }
    let letters = &text[l0..i];
    if letters.is_empty() || letters.len() > 4 {
        return None;
    }
    let row_abs = bytes.get(i) == Some(&b'$');
    i += usize::from(row_abs);
    let d0 = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let digits = &text[d0..i];
    if digits.is_empty() {
        return None;
    }
    if let Some(&next) = bytes.get(i) {
        if next.is_ascii_alphanumeric() || next == b'_' || next == b'.' || next == b'(' || next == b'!' {
            return None;
        }
    }
    Some((i, col_abs, letters, row_abs, digits))
}

fn repair_area_reference(letters: &str, digits: &str) -> Option<String> {
    let k = letters.len() as u32;
    let low = letters.bytes().fold(0u64, |acc, c| acc * 26 + u64::from(c.to_ascii_uppercase() - b'A'));
    let base = 26u64.pow(k);
    let best = (1..26u64).map(|m| m * base + low).filter(|raw| *raw <= 0xFFFF && raw & 0xC000 != 0).min_by_key(|raw| raw & 0x3FFF)?;
    let col = (best & 0x3FFF) as u32;
    if col >= crate::engine::types::MAX_COLS {
        return None;
    }
    let mut out = String::new();
    if best & 0x4000 == 0 {
        out.push('$');
    }
    out.push_str(&super::a1::column_name(col));
    if best & 0x8000 == 0 {
        out.push('$');
    }
    out.push_str(digits);
    Some(out)
}

fn date_format(serial: f64, duration: bool) -> &'static str {
    if duration {
        return "[h]:mm:ss";
    }
    let frac = serial.fract();
    let seconds = (frac * 86_400.0).round() as i64;
    if serial < 1.0 {
        if seconds % 60 == 0 {
            "hh:mm"
        } else {
            "hh:mm:ss"
        }
    } else if seconds == 0 || seconds == 86_400 {
        "dd/mm/yyyy"
    } else if seconds % 60 == 0 {
        "dd/mm/yyyy hh:mm"
    } else {
        "dd/mm/yyyy hh:mm:ss"
    }
}

/// Coalesces per-cell formats into vertical runs (one range per column run).
#[derive(Default)]
struct FormatRuns {
    open: HashMap<u32, (u32, u32, &'static str)>,
    done: Vec<(CellRange, String)>,
}

impl FormatRuns {
    fn add(&mut self, row: u32, col: u32, fmt: &'static str) {
        if let Some((start, last, f)) = self.open.get_mut(&col) {
            if *f == fmt && *last + 1 == row {
                *last = row;
                return;
            }
            let (s, l, f) = (*start, *last, *f);
            self.done.push((CellRange { r0: s, c0: col, r1: l, c1: col }, f.to_string()));
        }
        self.open.insert(col, (row, row, fmt));
    }

    fn finish(mut self) -> Vec<(CellRange, String)> {
        for (col, (s, l, f)) in self.open {
            self.done.push((CellRange { r0: s, c0: col, r1: l, c1: col }, f.to_string()));
        }
        self.done.sort_by_key(|(r, _)| (r.c0, r.r0));
        self.done
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_formats_by_precision() {
        assert_eq!(date_format(45_000.0, false), "dd/mm/yyyy");
        assert_eq!(date_format(45_000.5, false), "dd/mm/yyyy hh:mm");
        assert_eq!(date_format(45_000.5 + 1.0 / 86_400.0, false), "dd/mm/yyyy hh:mm:ss");
        assert_eq!(date_format(0.25, false), "hh:mm");
        assert_eq!(date_format(1.5, true), "[h]:mm:ss");
    }

    #[test]
    fn repairs_calamine_area_references() {
        // B2:B4 with both relative flags, as calamine 0.36 prints it.
        assert_eq!(repair_formula("SUM($USN$2:$USN$4)").as_deref(), Some("SUM(B2:B4)"));
        assert_eq!(repair_formula("SUM($A$1:$C$3)+A1*2").as_deref(), Some("SUM($A$1:$C$3)+A1*2"));
        let text = "IF(A1=\"AB12\",'Hoja 2'!B3,LOG10(C1))";
        assert_eq!(repair_formula(text).as_deref(), Some(text));
        assert_eq!(repair_formula("AB12+1"), None, "ambiguous column");
        assert_eq!(repair_formula("1E5+A1").as_deref(), Some("1E5+A1"));
    }

    #[test]
    fn format_runs_coalesce() {
        let mut runs = FormatRuns::default();
        for r in 1..=3 {
            runs.add(r, 0, "dd/mm/yyyy");
        }
        runs.add(5, 0, "dd/mm/yyyy");
        runs.add(1, 2, "hh:mm");
        let done = runs.finish();
        assert_eq!(done.len(), 3);
        assert_eq!(done[0].0, CellRange { r0: 1, c0: 0, r1: 3, c1: 0 });
        assert_eq!(done[1].0, CellRange { r0: 5, c0: 0, r1: 5, c1: 0 });
    }

    /// `testdata/basic.xls` is written by xlwt (BIFF8): texts, numbers,
    /// dates, a formula, a numeric-looking text, a boolean, a merge and a
    /// second sheet with a non-ASCII name.
    #[test]
    fn imports_values_formulas_dates_and_merges() {
        let workbook = import_xls(include_bytes!("testdata/basic.xls")).unwrap();
        let names: Vec<_> = workbook.sheets.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["Ventas", "Año 2"]);
        let sheet = &workbook.sheets[0];
        let cell = |r: u32, c: u32| sheet.cells.iter().find(|(row, col, _)| (*row, *col) == (r, c)).map(|(_, _, i)| i.as_str());
        assert_eq!(cell(0, 0), Some("Mes"));
        assert_eq!(cell(1, 1), Some("10.5"));
        assert_eq!(cell(1, 2), Some("46037"), "2026-01-15 as a serial");
        assert_eq!(cell(4, 1), Some("=SUM(B2:B4)"));
        assert_eq!(cell(5, 0), Some("'007"));
        assert_eq!(cell(5, 1), Some("TRUE"));
        assert_eq!(cell(6, 0), Some("Combinada"));
        assert_eq!(sheet.merges, vec![CellRange { r0: 6, c0: 0, r1: 6, c1: 2 }]);
        assert_eq!(sheet.number_formats, vec![(CellRange { r0: 1, c0: 2, r1: 3, c1: 2 }, "dd/mm/yyyy".to_string())]);
        assert!(sheet.cells.windows(2).all(|w| (w[0].0, w[0].1) < (w[1].0, w[1].1)), "row-major order");
        assert_eq!(workbook.sheets[1].cells, vec![(0, 0, "42".to_string())]);
    }

    #[test]
    fn rejects_non_xls_bytes_in_spanish() {
        let err = import_xls(b"not an xls").unwrap_err();
        assert_eq!(err.code, EngineErrorCode::Parse);
        let err = import_xls(b"PK\x03\x04rest").unwrap_err();
        assert!(err.message.contains(".xlsx"));
    }
}
