//! Excel-like autofill (fill handle).
//!
//! `target` is the whole destination range after the drag (it contains the
//! source) or a range adjacent to the source. Per column (vertical fill) or
//! row (horizontal fill) the source cells are classified:
//! - 2+ numbers → linear trend (least squares, exact for arithmetic steps);
//!   a single number is copied (Excel without Ctrl);
//! - dates → +1 day for a single date; 2+ dates with the same day of month
//!   step by months (or years), otherwise by days;
//! - text ending in an integer (`Item 1`, `T3`) → increments;
//! - month / weekday names in Spanish or English, full or abbreviated
//!   (`ene`, `enero`, `lun`, `Jan`, `Monday`…) → continue the list;
//! - anything else (formulas, mixed) → repeats the source cyclically, shifting
//!   relative references of formulas.
//! Formats are copied from the source cells cyclically.

use ironcalc_base::formatter::dates::{date_to_serial_number, from_excel_date};
use ironcalc_base::number_format::to_excel_precision;
use ironcalc_base::types::Style;

use chrono::Datelike;

use super::display::{raw_value, RawValue};
use super::history::Batch;
use super::ops::plain_number;
use super::{ic_col, ic_row, WorkbookBackend};
use crate::engine::types::*;

#[derive(Debug, Clone, PartialEq)]
enum Src {
    Empty,
    Number { value: f64, date: bool },
    Text(String),
    /// Anything copied verbatim (formulas, booleans, errors).
    Other,
}

#[derive(Debug, Clone, PartialEq)]
enum Series {
    Copy,
    Linear { a: f64, b: f64 },
    Days { start: f64, step: f64 },
    Months { start: f64, step: i32 },
    TextNumber { prefix: String, start: i64, step: i64, width: usize },
    List { list: usize, start: usize, step: i64, case: Case },
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Case {
    Lower,
    Upper,
    Title,
}

const LISTS: [&[&str]; 8] = [
    &["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
    &[
        "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre",
        "diciembre",
    ],
    &["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
    &["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
    &["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
    &[
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november",
        "december",
    ],
    &["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    &["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
];

fn strip_accents(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' => 'u',
            other => other,
        })
        .collect()
}

fn list_index(list: &[&str], text: &str) -> Option<usize> {
    let lower = strip_accents(&text.trim().to_lowercase());
    list.iter().position(|item| strip_accents(item) == lower)
}

fn case_of(text: &str) -> Case {
    let letters: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        Case::Upper
    } else if letters.first().is_some_and(|c| c.is_uppercase()) {
        Case::Title
    } else {
        Case::Lower
    }
}

fn apply_case(text: &str, case: Case) -> String {
    match case {
        Case::Lower => text.to_string(),
        Case::Upper => text.to_uppercase(),
        Case::Title => {
            let mut chars = text.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => String::new(),
            }
        }
    }
}

/// `Item 12` → ("Item ", 12, 2).
fn split_trailing_number(text: &str) -> Option<(String, i64, usize)> {
    let digits = text.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits == text.chars().count() || digits > 15 {
        return None;
    }
    let split = text.len() - digits;
    let number: i64 = text[split..].parse().ok()?;
    Some((text[..split].to_string(), number, digits))
}

pub(crate) fn is_date_format(fmt: &str) -> bool {
    let mut cleaned = String::new();
    let mut in_quotes = false;
    let mut in_brackets = false;
    let mut chars = fmt.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => in_quotes = !in_quotes,
            '[' if !in_quotes => in_brackets = true,
            ']' if !in_quotes => in_brackets = false,
            '\\' => {
                chars.next();
            }
            _ if in_quotes || in_brackets => {}
            _ => cleaned.push(c.to_ascii_lowercase()),
        }
    }
    cleaned.contains('d') || cleaned.contains('y') || (cleaned.contains('m') && !cleaned.contains('h') && !cleaned.contains('s'))
}

fn detect(src: &[Src]) -> Series {
    if src.is_empty() {
        return Series::Copy;
    }
    // Numbers / dates.
    let numbers: Vec<(f64, bool)> = src
        .iter()
        .filter_map(|s| match s {
            Src::Number { value, date } => Some((*value, *date)),
            _ => None,
        })
        .collect();
    if numbers.len() == src.len() {
        let all_dates = numbers.iter().all(|(_, d)| *d);
        if numbers.len() == 1 {
            return if all_dates { Series::Days { start: numbers[0].0, step: 1.0 } } else { Series::Copy };
        }
        if all_dates {
            if let Some(step) = month_step(&numbers.iter().map(|(v, _)| *v).collect::<Vec<_>>()) {
                return Series::Months { start: numbers[0].0, step };
            }
        }
        let n = numbers.len() as f64;
        let mean_x = (n - 1.0) / 2.0;
        let mean_y = numbers.iter().map(|(v, _)| v).sum::<f64>() / n;
        let mut sxy = 0.0;
        let mut sxx = 0.0;
        for (i, (v, _)) in numbers.iter().enumerate() {
            let dx = i as f64 - mean_x;
            sxy += dx * (v - mean_y);
            sxx += dx * dx;
        }
        let b = if sxx == 0.0 { 0.0 } else { sxy / sxx };
        let a = mean_y - b * mean_x;
        return if all_dates { Series::Days { start: a, step: b } } else { Series::Linear { a, b } };
    }
    // Texts.
    let texts: Vec<&str> = src
        .iter()
        .filter_map(|s| match s {
            Src::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect();
    if texts.len() == src.len() {
        for (list_no, list) in LISTS.iter().enumerate() {
            let indices: Option<Vec<usize>> = texts.iter().map(|t| list_index(list, t)).collect();
            let Some(indices) = indices else { continue };
            let len = list.len() as i64;
            let step = if indices.len() == 1 {
                1
            } else {
                let step = (indices[1] as i64 - indices[0] as i64).rem_euclid(len);
                let consistent = indices.windows(2).all(|w| (w[1] as i64 - w[0] as i64).rem_euclid(len) == step);
                if !consistent {
                    return Series::Copy;
                }
                step
            };
            return Series::List { list: list_no, start: indices[0], step, case: case_of(texts[0]) };
        }
        let parts: Option<Vec<(String, i64, usize)>> = texts.iter().map(|t| split_trailing_number(t)).collect();
        if let Some(parts) = parts {
            if parts.iter().all(|p| p.0 == parts[0].0) {
                let step = if parts.len() == 1 { 1 } else { parts[1].1 - parts[0].1 };
                let consistent = parts.windows(2).all(|w| w[1].1 - w[0].1 == step);
                if consistent {
                    return Series::TextNumber {
                        prefix: parts[0].0.clone(),
                        start: parts[0].1,
                        step,
                        width: parts[0].2,
                    };
                }
            }
        }
    }
    Series::Copy
}

/// Constant month step between dates that share the day of month.
fn month_step(values: &[f64]) -> Option<i32> {
    let dates: Option<Vec<chrono::NaiveDate>> = values
        .iter()
        .map(|v| if v.fract() == 0.0 { from_excel_date(*v as i64).ok() } else { None })
        .collect();
    let dates = dates?;
    let day = dates[0].day();
    if !dates.iter().all(|d| d.day() == day) {
        return None;
    }
    let months: Vec<i32> = dates.iter().map(|d| d.year() * 12 + d.month0() as i32).collect();
    let step = months[1] - months[0];
    if step == 0 || !months.windows(2).all(|w| w[1] - w[0] == step) {
        return None;
    }
    Some(step)
}

fn add_months(serial: f64, months: i32) -> Option<f64> {
    let date = from_excel_date(serial as i64).ok()?;
    let total = date.year() * 12 + date.month0() as i32 + months;
    let (year, month) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    // Clamp the day to the length of the month (31 Jan + 1 month = 28/29 Feb).
    let mut day = date.day();
    loop {
        if let Ok(serial) = date_to_serial_number(day, month, year) {
            return Some(f64::from(serial));
        }
        if day <= 28 {
            return None;
        }
        day -= 1;
    }
}

/// What to write at series position `k` (0 = first source cell).
enum Generated {
    Value(String),
    /// Copy of source cell `index` (formula shifted).
    Source(usize),
}

fn generate(series: &Series, k: usize, n: usize) -> Generated {
    let kf = k as f64;
    match series {
        Series::Copy => Generated::Source(k % n),
        Series::Linear { a, b } => Generated::Value(plain_number(to_excel_precision(a + b * kf, 15))),
        Series::Days { start, step } => Generated::Value(plain_number(to_excel_precision(start + step * kf, 15))),
        Series::Months { start, step } => match add_months(*start, step * k as i32) {
            Some(v) => Generated::Value(plain_number(v)),
            None => Generated::Source(k % n),
        },
        Series::TextNumber { prefix, start, step, width } => {
            let value = start + step * k as i64;
            let digits = if value < 0 { format!("{value}") } else { format!("{value:0width$}") };
            Generated::Value(format!("{prefix}{digits}"))
        }
        Series::List { list, start, step, case } => {
            let items = LISTS[*list];
            let index = (*start as i64 + step * k as i64).rem_euclid(items.len() as i64) as usize;
            Generated::Value(apply_case(items[index], *case))
        }
    }
}

impl WorkbookBackend {
    pub(crate) fn op_fill(&mut self, b: &mut Batch, sheet: SheetId, source: CellRange, target: CellRange) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let contains = target.r0 <= source.r0 && target.c0 <= source.c0 && target.r1 >= source.r1 && target.c1 >= source.c1;
        let inside = source.r0 <= target.r0 && source.c0 <= target.c0 && source.r1 >= target.r1 && source.c1 >= target.c1;
        if inside && target != source {
            // Dragging the handle back into the selection clears the rest.
            let mut cleared = Vec::new();
            if target.r1 < source.r1 {
                cleared.push(CellRange { r0: target.r1 + 1, ..source });
            } else if target.c1 < source.c1 {
                cleared.push(CellRange { c0: target.c1 + 1, ..source });
            }
            for range in cleared {
                self.ic(b, |um| um.range_clear_contents(&super::area(index, &range)))?;
                b.cells(sheet, range);
            }
            b.select(sheet, vec![target]);
            return Ok(());
        }
        // Direction and the cells to generate.
        let (vertical, forward, fill) = if contains {
            if target.r1 > source.r1 {
                (true, true, CellRange { r0: source.r1 + 1, c0: source.c0, r1: target.r1, c1: source.c1 })
            } else if target.r0 < source.r0 {
                (true, false, CellRange { r0: target.r0, c0: source.c0, r1: source.r0 - 1, c1: source.c1 })
            } else if target.c1 > source.c1 {
                (false, true, CellRange { r0: source.r0, c0: source.c1 + 1, r1: source.r1, c1: target.c1 })
            } else if target.c0 < source.c0 {
                (false, false, CellRange { r0: source.r0, c0: target.c0, r1: source.r1, c1: source.c0 - 1 })
            } else {
                return Ok(());
            }
        } else if target.r0 > source.r1 {
            (true, true, CellRange { r0: target.r0, c0: source.c0, r1: target.r1, c1: source.c1 })
        } else if target.r1 < source.r0 {
            (true, false, CellRange { r0: target.r0, c0: source.c0, r1: target.r1, c1: source.c1 })
        } else if target.c0 > source.c1 {
            (false, true, CellRange { r0: source.r0, c0: target.c0, r1: source.r1, c1: target.c1 })
        } else if target.c1 < source.c0 {
            (false, false, CellRange { r0: source.r0, c0: target.c0, r1: source.r1, c1: target.c1 })
        } else {
            return Err(super::ops::invalid("El rango de relleno no es válido."));
        };

        // Lines: columns for vertical fills, rows for horizontal ones.
        let lines: Vec<u32> = if vertical { (source.c0..=source.c1).collect() } else { (source.r0..=source.r1).collect() };
        let mut src_positions: Vec<u32> =
            if vertical { (source.r0..=source.r1).collect() } else { (source.c0..=source.c1).collect() };
        let mut dst_positions: Vec<u32> = if vertical { (fill.r0..=fill.r1).collect() } else { (fill.c0..=fill.c1).collect() };
        if !forward {
            src_positions.reverse();
            dst_positions.reverse();
        }
        let n = src_positions.len();
        let mut writes: Vec<(u32, u32, String)> = Vec::new();
        let mut style_map: Vec<(u32, u32, u32, u32)> = Vec::new(); // (dst row, dst col, src row, src col)
        {
            let model = self.model();
            let ws = &model.workbook.worksheets[index as usize];
            let shared = &model.workbook.shared_strings;
            for line in &lines {
                let at = |pos: u32| if vertical { (pos, *line) } else { (*line, pos) };
                let src: Vec<Src> = src_positions
                    .iter()
                    .map(|pos| {
                        let (r, c) = at(*pos);
                        match ws.cell(ic_row(r), ic_col(c)) {
                            None => Src::Empty,
                            Some(cell) => {
                                if cell.has_formula() {
                                    return Src::Other;
                                }
                                match raw_value(&cell, shared) {
                                    RawValue::Empty => Src::Empty,
                                    RawValue::Number(v) => {
                                        let fmt = self.xf_info(cell.get_style()).num_fmt;
                                        Src::Number { value: v, date: is_date_format(&fmt) }
                                    }
                                    RawValue::Text(t) => Src::Text(t.into_owned()),
                                    _ => Src::Other,
                                }
                            }
                        }
                    })
                    .collect();
                let series = detect(&src);
                for (j, pos) in dst_positions.iter().enumerate() {
                    let k = n + j;
                    let (r, c) = at(*pos);
                    let (sr, sc) = at(src_positions[k % n]);
                    style_map.push((r, c, sr, sc));
                    let value = match generate(&series, k, n) {
                        Generated::Value(v) => {
                            if matches!(series, Series::TextNumber { .. } | Series::List { .. }) && self.text_needs_quote(&v) {
                                format!("'{v}")
                            } else {
                                v
                            }
                        }
                        Generated::Source(i) => {
                            let (sr, sc) = at(src_positions[i]);
                            match &src[i] {
                                Src::Empty => String::new(),
                                _ => {
                                    let cell = ws.cell(ic_row(sr), ic_col(sc));
                                    if cell.as_ref().is_some_and(|c| c.has_formula()) {
                                        model
                                            .extend_to(index, ic_row(sr), ic_col(sc), ic_row(r), ic_col(c))
                                            .map_err(super::ic_error)?
                                    } else {
                                        let input = self.cell_input(index, ws, ic_row(sr), ic_col(sc));
                                        self.ic_input(&input)
                                    }
                                }
                            }
                        }
                    };
                    writes.push((r, c, value));
                }
            }
        }
        for (r, c, value) in &writes {
            self.write_raw(b, index, ic_row(*r), ic_col(*c), value)?;
        }
        // Formats follow the source cells.
        let mut styles: std::collections::HashMap<(u32, u32), Style> = std::collections::HashMap::new();
        {
            let model = self.model();
            for (r, c, sr, sc) in &style_map {
                let style = model.get_style_for_cell(index, ic_row(*sr), ic_col(*sc)).map_err(super::ic_error)?;
                styles.insert((*r, *c), style);
            }
        }
        self.write_styles(b, index, fill, |r, c, style| {
            if let Some(s) = styles.get(&(r, c)) {
                *style = s.clone();
            }
            Ok(())
        })?;
        b.affected += writes.len() as u64;
        b.cells(sheet, fill);
        let whole = CellRange {
            r0: source.r0.min(fill.r0),
            c0: source.c0.min(fill.c0),
            r1: source.r1.max(fill.r1),
            c1: source.c1.max(fill.c1),
        };
        b.select(sheet, vec![whole]);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn num(v: f64) -> Src {
        Src::Number { value: v, date: false }
    }

    fn text(t: &str) -> Src {
        Src::Text(t.to_string())
    }

    fn values(series: &Series, n: usize, count: usize) -> Vec<String> {
        (n..n + count)
            .map(|k| match generate(series, k, n) {
                Generated::Value(v) => v,
                Generated::Source(i) => format!("src{i}"),
            })
            .collect()
    }

    #[test]
    fn numbers() {
        assert_eq!(detect(&[num(5.0)]), Series::Copy);
        let s = detect(&[num(1.0), num(3.0)]);
        assert_eq!(values(&s, 2, 3), vec!["5", "7", "9"]);
        let s = detect(&[num(0.1), num(0.2)]);
        assert_eq!(values(&s, 2, 2), vec!["0.3", "0.4"]);
        let s = detect(&[num(10.0), num(8.0), num(6.0)]);
        assert_eq!(values(&s, 3, 2), vec!["4", "2"]);
    }

    #[test]
    fn dates() {
        // 31/01/2025 = 45688.
        let jan31 = 45688.0;
        let s = detect(&[Src::Number { value: jan31, date: true }]);
        assert_eq!(values(&s, 1, 2), vec!["45689", "45690"]);
        // 15/01/2025 and 15/02/2025 → months.
        let a = f64::from(date_to_serial_number(15, 1, 2025).unwrap());
        let b = f64::from(date_to_serial_number(15, 2, 2025).unwrap());
        let s = detect(&[Src::Number { value: a, date: true }, Src::Number { value: b, date: true }]);
        let expected = f64::from(date_to_serial_number(15, 3, 2025).unwrap());
        assert_eq!(values(&s, 2, 1), vec![plain_number(expected)]);
        assert_eq!(add_months(jan31, 1), Some(f64::from(date_to_serial_number(28, 2, 2025).unwrap())));
        assert!(is_date_format("dd/mm/yyyy"));
        assert!(is_date_format("d \"de\" mmmm"));
        assert!(!is_date_format("#,##0.00 \"€\""));
        assert!(!is_date_format("hh:mm:ss"));
    }

    #[test]
    fn month_and_day_names() {
        let s = detect(&[text("ene")]);
        assert_eq!(values(&s, 1, 3), vec!["feb", "mar", "abr"]);
        let s = detect(&[text("Enero")]);
        assert_eq!(values(&s, 1, 2), vec!["Febrero", "Marzo"]);
        let s = detect(&[text("dic")]);
        assert_eq!(values(&s, 1, 1), vec!["ene"]);
        let s = detect(&[text("lunes")]);
        assert_eq!(values(&s, 1, 2), vec!["martes", "miércoles"]);
        let s = detect(&[text("mar"), text("mié")]);
        assert_eq!(values(&s, 2, 1), vec!["jue"]);
        let s = detect(&[text("Jan"), text("Mar")]);
        assert_eq!(values(&s, 2, 2), vec!["May", "Jul"]);
        let s = detect(&[text("MONDAY")]);
        assert_eq!(values(&s, 1, 1), vec!["TUESDAY"]);
        let s = detect(&[text("sábado")]);
        assert_eq!(values(&s, 1, 2), vec!["domingo", "lunes"]);
    }

    #[test]
    fn text_with_numbers_and_copies() {
        let s = detect(&[text("Item 1")]);
        assert_eq!(values(&s, 1, 2), vec!["Item 2", "Item 3"]);
        let s = detect(&[text("T01"), text("T03")]);
        assert_eq!(values(&s, 2, 1), vec!["T05"]);
        let s = detect(&[text("hola")]);
        assert_eq!(values(&s, 1, 2), vec!["src0", "src0"]);
        let s = detect(&[text("a"), num(1.0)]);
        assert_eq!(values(&s, 2, 3), vec!["src0", "src1", "src0"]);
    }
}
