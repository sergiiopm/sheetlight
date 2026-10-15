//! Rewriting of chart series references (`Hoja1!$B$2:$B$13`) when the cells
//! they point to move: rows/columns inserted or deleted, sheets renamed. The
//! engine stores references as text, so it calls these after structural ops
//! (formulas in cells are rewritten by IronCalc itself).

use super::write::quote_sheet;
use crate::engine::types::ChartDraft;

/// A row/column insertion or deletion on one sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefShift {
    /// True for rows, false for columns.
    pub rows: bool,
    pub insert: bool,
    /// 0-based first row/column inserted or deleted.
    pub index: u32,
    pub count: u32,
}

/// Splits a union `(A!$B$2:$B$5,A!$C$2)` into areas, honoring quoted sheet names.
fn split_areas(formula: &str) -> Vec<&str> {
    let text = formula.trim();
    let text = text.strip_prefix('(').and_then(|t| t.strip_suffix(')')).unwrap_or(text);
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (i, ch) in text.char_indices() {
        match ch {
            '\'' => quoted = !quoted,
            ',' if !quoted => {
                parts.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// `(sheet name unquoted, cells part)`; the sheet is None when unqualified.
fn split_sheet(area: &str) -> (Option<String>, &str) {
    match area.rsplit_once('!') {
        Some((sheet, cells)) => {
            let sheet = sheet.trim();
            let bare = if sheet.len() >= 2 && sheet.starts_with('\'') && sheet.ends_with('\'') {
                sheet[1..sheet.len() - 1].replace("''", "'")
            } else {
                sheet.to_string()
            };
            (Some(bare), cells.trim())
        }
        None => (None, area.trim()),
    }
}

/// One end of an A1 reference, keeping its `$` markers.
#[derive(Debug, Clone, Copy)]
struct Endpoint {
    col: Option<(u32, bool)>,
    row: Option<(u32, bool)>,
}

fn parse_endpoint(text: &str) -> Option<Endpoint> {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut col = None;
    let abs_col = bytes.first() == Some(&b'$');
    let mut j = if abs_col { 1 } else { 0 };
    let letters_start = j;
    while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
        j += 1;
    }
    if j > letters_start {
        if j - letters_start > 3 {
            return None;
        }
        let mut n: u32 = 0;
        for b in &bytes[letters_start..j] {
            n = n * 26 + u32::from(b.to_ascii_uppercase() - b'A' + 1);
        }
        col = Some((n - 1, abs_col));
        i = j;
    } else if abs_col {
        // `$5` (whole-row form): the `$` belongs to the row.
        i = 0;
    }
    let mut row = None;
    if i < bytes.len() {
        let abs_row = bytes[i] == b'$';
        let digits_start = if abs_row { i + 1 } else { i };
        let digits = &text[digits_start..];
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let n: u32 = digits.parse().ok()?;
        if n == 0 {
            return None;
        }
        row = Some((n - 1, abs_row));
    }
    if col.is_none() && row.is_none() {
        return None;
    }
    Some(Endpoint { col, row })
}

fn column_name(mut col: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (col % 26) as u8);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn format_endpoint(e: &Endpoint) -> String {
    let mut s = String::new();
    if let Some((c, abs)) = e.col {
        if abs {
            s.push('$');
        }
        s.push_str(&column_name(c));
    }
    if let Some((r, abs)) = e.row {
        if abs {
            s.push('$');
        }
        s.push_str(&(r + 1).to_string());
    }
    s
}

/// New `(start, end)` of an inclusive interval after the shift; None when deleted entirely.
fn shift_interval(a: u32, z: u32, shift: &RefShift) -> Option<(u32, u32)> {
    let (index, count) = (shift.index, shift.count);
    if shift.insert {
        let a2 = if a >= index { a.saturating_add(count) } else { a };
        let z2 = if z >= index { z.saturating_add(count) } else { z };
        return Some((a2, z2));
    }
    let end = index.saturating_add(count); // first index after the deleted block
    if a >= index && z < end {
        return None;
    }
    let map = |v: u32, inside: u32| {
        if v < index {
            v
        } else if v >= end {
            v - count
        } else {
            inside
        }
    };
    // A start inside the block moves to the first surviving line; an end
    // inside it (only possible when the start is before it) to the last one.
    Some((map(a, index), map(z, index.saturating_sub(1))))
}

/// Shifts one area's cells part. `Err(())` when the area was deleted.
fn shift_cells(cells: &str, shift: &RefShift) -> Result<Option<String>, ()> {
    let (first, second) = match cells.split_once(':') {
        Some((a, b)) => (a, Some(b)),
        None => (cells, None),
    };
    let (Some(mut a), b) = (parse_endpoint(first), second.map(parse_endpoint)) else {
        return Ok(None);
    };
    let mut b = match b {
        Some(Some(e)) => Some(e),
        Some(None) => return Ok(None),
        None => None,
    };
    let get = |e: &Endpoint| if shift.rows { e.row } else { e.col };
    let (Some(start), end) = (get(&a), b.as_ref().map(get)) else {
        // Whole columns on a row shift (or whole rows on a column shift): unaffected.
        return Ok(None);
    };
    let end = match end {
        Some(Some(e)) => e,
        Some(None) => return Ok(None),
        None => start,
    };
    let (lo, hi) = (start.0.min(end.0), start.0.max(end.0));
    let Some((lo2, hi2)) = shift_interval(lo, hi, shift) else {
        return Err(());
    };
    if (lo2, hi2) == (lo, hi) {
        return Ok(None);
    }
    let set = |e: &mut Endpoint, v: u32, abs: bool| {
        if shift.rows {
            e.row = Some((v, abs));
        } else {
            e.col = Some((v, abs));
        }
    };
    set(&mut a, lo2, start.1);
    match b.as_mut() {
        Some(b) => set(b, hi2, end.1),
        None if hi2 != lo2 => {
            let mut e = a;
            set(&mut e, hi2, start.1);
            b = Some(e);
        }
        None => {}
    }
    Ok(Some(match b {
        Some(b) => format!("{}:{}", format_endpoint(&a), format_endpoint(&b)),
        None => format_endpoint(&a),
    }))
}

/// Shifts one reference for an insert/delete on `target_sheet`. Unqualified
/// areas belong to `chart_sheet`. Returns None when nothing changed; an area
/// whose cells were all deleted becomes `Sheet!#REF!` like in Excel.
pub fn shift_ref(formula: &str, chart_sheet: &str, target_sheet: &str, shift: &RefShift) -> Option<String> {
    if shift.count == 0 {
        return None;
    }
    let areas = split_areas(formula);
    let mut changed = false;
    let mut out = Vec::with_capacity(areas.len());
    for area in &areas {
        let (sheet, cells) = split_sheet(area);
        let on_target = sheet.as_deref().unwrap_or(chart_sheet).eq_ignore_ascii_case(target_sheet);
        if !on_target {
            out.push(area.trim().to_string());
            continue;
        }
        let prefix = match &sheet {
            Some(s) => format!("{}!", quote_sheet(s)),
            None => String::new(),
        };
        match shift_cells(cells, shift) {
            Ok(None) => out.push(area.trim().to_string()),
            Ok(Some(cells)) => {
                changed = true;
                out.push(format!("{prefix}{cells}"));
            }
            Err(()) => {
                changed = true;
                out.push(format!("{prefix}#REF!"));
            }
        }
    }
    if !changed {
        return None;
    }
    Some(if out.len() > 1 { format!("({})", out.join(",")) } else { out.remove(0) })
}

/// Renames `old` to `new` in a reference. Returns None when nothing changed.
pub fn rename_sheet_ref(formula: &str, old: &str, new: &str) -> Option<String> {
    let areas = split_areas(formula);
    let mut changed = false;
    let out: Vec<String> = areas
        .iter()
        .map(|area| match split_sheet(area) {
            (Some(sheet), cells) if sheet.eq_ignore_ascii_case(old) => {
                changed = true;
                format!("{}!{cells}", quote_sheet(new))
            }
            _ => area.trim().to_string(),
        })
        .collect();
    if !changed {
        return None;
    }
    Some(if out.len() > 1 { format!("({})", out.join(",")) } else { out.join("") })
}

/// Applies `f` to every reference of a chart; true when any changed.
fn rewrite_draft(draft: &mut ChartDraft, f: impl Fn(&str) -> Option<String>) -> bool {
    let mut changed = false;
    for series in &mut draft.series {
        for reference in [&mut series.name_ref, &mut series.categories_ref].into_iter().flatten() {
            if let Some(next) = f(reference) {
                *reference = next;
                changed = true;
            }
        }
        if let Some(next) = f(&series.values_ref) {
            series.values_ref = next;
            changed = true;
        }
    }
    changed
}

/// Moves every series reference of a chart that lives on `chart_sheet` for an
/// insert/delete on `target_sheet`. True when any reference changed.
pub fn shift_chart_refs(draft: &mut ChartDraft, chart_sheet: &str, target_sheet: &str, shift: &RefShift) -> bool {
    rewrite_draft(draft, |r| shift_ref(r, chart_sheet, target_sheet, shift))
}

/// Points the chart's references at a renamed sheet. True when any changed.
pub fn rename_chart_refs(draft: &mut ChartDraft, old: &str, new: &str) -> bool {
    rewrite_draft(draft, |r| rename_sheet_ref(r, old, new))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn rows(insert: bool, index: u32, count: u32) -> RefShift {
        RefShift { rows: true, insert, index, count }
    }

    const fn cols(insert: bool, index: u32, count: u32) -> RefShift {
        RefShift { rows: false, insert, index, count }
    }

    fn shift(f: &str, s: RefShift) -> String {
        shift_ref(f, "Hoja1", "Hoja1", &s).unwrap_or_else(|| f.to_string())
    }

    #[test]
    fn inserting_rows_moves_or_grows_ranges() {
        // Above: the whole range moves.
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(true, 0, 2)), "Hoja1!$B$4:$B$7");
        // At the first row: moves (Excel semantics).
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(true, 1, 1)), "Hoja1!$B$3:$B$6");
        // Inside: grows.
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(true, 3, 1)), "Hoja1!$B$2:$B$6");
        // Below: untouched.
        assert_eq!(shift_ref("Hoja1!$B$2:$B$5", "Hoja1", "Hoja1", &rows(true, 5, 1)), None);
        // Single cells keep their form.
        assert_eq!(shift("Hoja1!$B$1", rows(true, 0, 1)), "Hoja1!$B$2");
        // Relative markers are kept.
        assert_eq!(shift("B2:C3", rows(true, 0, 1)), "B3:C4");
    }

    #[test]
    fn deleting_rows_shrinks_moves_or_invalidates() {
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(false, 0, 1)), "Hoja1!$B$1:$B$4");
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(false, 2, 2)), "Hoja1!$B$2:$B$3");
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(false, 0, 3)), "Hoja1!$B$1:$B$2");
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(false, 4, 5)), "Hoja1!$B$2:$B$4");
        assert_eq!(shift("Hoja1!$B$2:$B$5", rows(false, 1, 4)), "Hoja1!#REF!");
        assert_eq!(shift("Hoja1!$B$1", rows(false, 0, 1)), "Hoja1!#REF!");
        assert_eq!(shift_ref("Hoja1!$B$2:$B$5", "Hoja1", "Hoja1", &rows(false, 9, 1)), None);
    }

    #[test]
    fn columns_whole_lines_and_other_sheets() {
        assert_eq!(shift("Hoja1!$B$2:$C$5", cols(true, 0, 1)), "Hoja1!$C$2:$D$5");
        assert_eq!(shift("Hoja1!$B$2:$C$5", cols(false, 1, 1)), "Hoja1!$B$2:$B$5");
        // Whole columns ignore row shifts but move with column shifts.
        assert_eq!(shift_ref("Hoja1!$B:$B", "Hoja1", "Hoja1", &rows(true, 0, 3)), None);
        assert_eq!(shift("Hoja1!$B:$B", cols(true, 0, 1)), "Hoja1!$C:$C");
        assert_eq!(shift("Hoja1!$2:$2", rows(true, 0, 1)), "Hoja1!$3:$3");
        // Other sheet: untouched; unqualified refs belong to the chart's sheet.
        assert_eq!(shift_ref("Otra!$B$2:$B$5", "Hoja1", "Hoja1", &rows(true, 0, 1)), None);
        assert_eq!(shift_ref("$B$2:$B$5", "Otra", "Hoja1", &rows(true, 0, 1)), None);
        assert_eq!(shift_ref("$B$2:$B$5", "Hoja1", "hoja1", &rows(true, 0, 1)).as_deref(), Some("$B$3:$B$6"));
        // Quoted names and unions.
        assert_eq!(shift("'Mi hoja'!$A$1:$A$3", RefShift { rows: true, insert: true, index: 0, count: 1 }), "'Mi hoja'!$A$1:$A$3");
        assert_eq!(
            shift_ref("'Mi hoja'!$A$1:$A$3", "X", "Mi hoja", &rows(true, 0, 1)).as_deref(),
            Some("'Mi hoja'!$A$2:$A$4")
        );
        assert_eq!(
            shift("(Hoja1!$A$1:$A$3,Otra!$A$1,Hoja1!$C$5)", rows(true, 0, 1)),
            "(Hoja1!$A$2:$A$4,Otra!$A$1,Hoja1!$C$6)"
        );
    }

    #[test]
    fn renaming_sheets() {
        assert_eq!(rename_sheet_ref("Hoja1!$A$1:$A$3", "Hoja1", "Ventas 2026").as_deref(), Some("'Ventas 2026'!$A$1:$A$3"));
        assert_eq!(rename_sheet_ref("'Mi hoja'!$A$1", "mi hoja", "Datos").as_deref(), Some("Datos!$A$1"));
        assert_eq!(rename_sheet_ref("Otra!$A$1", "Hoja1", "X"), None);
        assert_eq!(rename_sheet_ref("$A$1", "Hoja1", "X"), None);
    }
}
