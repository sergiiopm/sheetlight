//! Locale layer: display strings for the `es` locale and canonical inputs.
//!
//! The IronCalc model runs with locale/language `en` so formulas stay en-US
//! (`=SUM(A1:A3,2)`). Everything the user *sees* is formatted here with
//! IronCalc's public formatter and the `es` locale (`1.234,56 €`,
//! `14/02/2025`). Booleans display `VERDADERO`/`FALSO`; errors keep the Excel
//! codes (`#DIV/0!`), which Spanish Excel also shows.

use std::borrow::Cow;

use ironcalc_base::expressions::token::Error as IcError;
use ironcalc_base::formatter::format::format_number;
use ironcalc_base::locale::{get_locale, Locale};
use ironcalc_base::number_format::to_excel_precision_str;
use ironcalc_base::types::{Cell, FormulaValue, SpillValue};

use crate::engine::types::{CellKind, CellValue};

pub const TRUE_ES: &str = "VERDADERO";
pub const FALSE_ES: &str = "FALSO";

/// The display locale (Spanish).
pub fn es_locale() -> &'static Locale {
    #[allow(clippy::expect_used)]
    get_locale("es").expect("IronCalc ships the es locale")
}

/// Raw value of a cell, borrowed when possible (shared strings are not cloned).
#[derive(Debug, Clone, PartialEq)]
pub enum RawValue<'a> {
    Empty,
    Number(f64),
    Text(Cow<'a, str>),
    Bool(bool),
    Error(IcError),
}

impl RawValue<'_> {
    pub fn kind(&self) -> CellKind {
        match self {
            RawValue::Empty => CellKind::Empty,
            RawValue::Number(_) => CellKind::Number,
            RawValue::Text(_) => CellKind::Text,
            RawValue::Bool(_) => CellKind::Bool,
            RawValue::Error(_) => CellKind::Error,
        }
    }

    pub fn to_contract(&self) -> CellValue {
        match self {
            RawValue::Empty => CellValue::Empty,
            RawValue::Number(n) => CellValue::Number { value: *n },
            RawValue::Text(t) => CellValue::Text { value: t.to_string() },
            RawValue::Bool(b) => CellValue::Bool { value: *b },
            RawValue::Error(e) => CellValue::Error { value: e.to_string() },
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            RawValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn is_empty(&self) -> bool {
        matches!(self, RawValue::Empty)
    }
}

/// Reads the value of an IronCalc cell without allocating for shared strings.
pub fn raw_value<'a>(cell: &'a Cell, shared_strings: &'a [String]) -> RawValue<'a> {
    match cell {
        Cell::EmptyCell { .. } => RawValue::Empty,
        Cell::BooleanCell { v, .. } => RawValue::Bool(*v),
        Cell::NumberCell { v, .. } => RawValue::Number(*v),
        Cell::ErrorCell { ei, .. } => RawValue::Error(ei.clone()),
        Cell::SharedString { si, .. } => RawValue::Text(Cow::Borrowed(
            shared_strings.get(*si as usize).map(String::as_str).unwrap_or(""),
        )),
        Cell::CellFormula { v, .. } | Cell::ArrayFormula { v, .. } => match v {
            FormulaValue::Unevaluated => RawValue::Error(IcError::ERROR),
            FormulaValue::Boolean(b) => RawValue::Bool(*b),
            FormulaValue::Number(n) => RawValue::Number(*n),
            FormulaValue::Text(s) => RawValue::Text(Cow::Borrowed(s.as_str())),
            FormulaValue::Error { ei, .. } => RawValue::Error(ei.clone()),
        },
        Cell::SpillCell { v, .. } => match v {
            SpillValue::Boolean(b) => RawValue::Bool(*b),
            SpillValue::Number(n) => RawValue::Number(*n),
            SpillValue::Text(s) => RawValue::Text(Cow::Borrowed(s.as_str())),
            SpillValue::Error(e) => RawValue::Error(e.clone()),
        },
    }
}

/// Result of formatting a value for display.
pub struct Shown<'a> {
    pub text: Cow<'a, str>,
    /// Number-format color (`[Red]`), as `#rrggbb`.
    pub color: Option<&'static str>,
}

/// Formats a value for the grid / clipboard (es locale).
pub fn display<'a>(value: &'a RawValue<'a>, num_fmt: &str) -> Shown<'a> {
    match value {
        RawValue::Empty => Shown { text: Cow::Borrowed(""), color: None },
        RawValue::Bool(true) => Shown { text: Cow::Borrowed(TRUE_ES), color: None },
        RawValue::Bool(false) => Shown { text: Cow::Borrowed(FALSE_ES), color: None },
        RawValue::Error(e) => Shown { text: Cow::Owned(e.to_string()), color: None },
        RawValue::Text(t) => {
            // A 4th format section (`;;;@`, `"x"@`) applies to text too; the
            // common case (`General`, `@`, number formats) shows the text as is.
            Shown { text: Cow::Borrowed(t.as_ref()), color: None }
        }
        RawValue::Number(n) => {
            let (text, color) = format_number_es(*n, num_fmt);
            Shown { text: Cow::Owned(text), color }
        }
    }
}

/// Formats a number with an Excel format code in the es locale.
pub fn format_number_es(value: f64, num_fmt: &str) -> (String, Option<&'static str>) {
    if is_general(num_fmt) {
        if let Some(text) = general_fast(value) {
            return (text, None);
        }
    }
    let formatted = format_number(value, num_fmt, es_locale());
    let color = formatted.color.and_then(format_color);
    (formatted.text, color)
}

pub fn is_general(num_fmt: &str) -> bool {
    num_fmt.eq_ignore_ascii_case("general")
}

/// Fast path for `General` (same output as IronCalc's formatter for values in
/// `[1e-8, 1e11)`, with a decimal comma).
fn general_fast(value: f64) -> Option<String> {
    if value == 0.0 {
        return Some("0".to_string());
    }
    let abs = value.abs();
    if !(1.0e-8..1.0e11).contains(&abs) {
        return None;
    }
    if value.fract() == 0.0 && abs < 1.0e15 {
        return Some(format!("{}", value as i64));
    }
    let mut text = format!("{value:.9}");
    while text.ends_with('0') {
        text.pop();
    }
    if text.ends_with('.') {
        text.pop();
    }
    Some(text.replace('.', ","))
}

/// IronCalc color token index → `#rrggbb`. Names map to 0..=6 (black, white,
/// red, green, blue, yellow, magenta); `[ColorN]` maps to N (Excel palette).
fn format_color(index: i32) -> Option<&'static str> {
    const NAMED: [&str; 7] = ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff"];
    if (0..7).contains(&index) {
        return Some(NAMED[index as usize]);
    }
    EXCEL_PALETTE.get((index - 1) as usize).copied()
}

/// Excel's legacy 56-color palette (`[Color1]`..`[Color56]`).
const EXCEL_PALETTE: [&str; 56] = [
    "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff", "#800000", "#008000",
    "#000080", "#808000", "#800080", "#008080", "#c0c0c0", "#808080", "#9999ff", "#993366", "#ffffcc", "#ccffff",
    "#660066", "#ff8080", "#0066cc", "#ccccff", "#000080", "#ff00ff", "#ffff00", "#00ffff", "#800080", "#800000",
    "#008080", "#0000ff", "#00ccff", "#ccffff", "#ccffcc", "#ffff99", "#99ccff", "#ff99cc", "#cc99ff", "#ffcc99",
    "#3366ff", "#33cccc", "#99cc00", "#ffcc00", "#ff9900", "#ff6600", "#666699", "#969696", "#003366", "#339966",
    "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
];

/// Canonical en-US input of a non-formula value (what `CellDetails.input`
/// shows and what re-entering reproduces): numbers plain (`1234.5`, dates as
/// serial numbers), `TRUE`/`FALSE`, error codes, text as is (with a leading
/// `'` when the cell has the quote-prefix flag).
pub fn canonical_value_input(value: &RawValue<'_>, quote_prefix: bool) -> String {
    match value {
        RawValue::Empty => String::new(),
        RawValue::Number(n) => number_input(*n),
        RawValue::Bool(true) => "TRUE".to_string(),
        RawValue::Bool(false) => "FALSE".to_string(),
        RawValue::Error(e) => e.to_string(),
        RawValue::Text(t) => {
            if quote_prefix {
                format!("'{t}")
            } else {
                t.to_string()
            }
        }
    }
}

/// `1234.5`, `0.1`, `1E+20` — 15 significant digits like Excel.
pub fn number_input(n: f64) -> String {
    to_excel_precision_str(n)
}

/// What a canonical input means (see `CellInput.input` in the contract).
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed<'a> {
    Empty,
    Formula(&'a str),
    Number(f64),
    Bool(bool),
    Error(&'a str),
    /// Text; `forced` when it came with a leading `'`.
    Text { text: &'a str, forced: bool },
}

pub fn parse_canonical(input: &str) -> Parsed<'_> {
    if input.is_empty() {
        return Parsed::Empty;
    }
    if let Some(rest) = input.strip_prefix('\'') {
        return Parsed::Text { text: rest, forced: true };
    }
    if input.starts_with('=') && input.len() > 1 {
        return Parsed::Formula(input);
    }
    let trimmed = input.trim();
    if let Some(n) = parse_plain_number(trimmed) {
        return Parsed::Number(n);
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return Parsed::Bool(true);
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Parsed::Bool(false);
    }
    if is_error_code(trimmed) {
        return Parsed::Error(trimmed);
    }
    Parsed::Text { text: input, forced: false }
}

/// Plain en-US number: optional sign, digits, `.` decimals, exponent.
pub fn parse_plain_number(text: &str) -> Option<f64> {
    if text.is_empty() {
        return None;
    }
    let bytes = text.as_bytes();
    let ok = bytes
        .iter()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E'));
    if !ok || !bytes.iter().any(u8::is_ascii_digit) {
        return None;
    }
    let value: f64 = text.parse().ok()?;
    value.is_finite().then_some(value)
}

pub const ERROR_CODES: [&str; 9] =
    ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!"];

pub fn is_error_code(text: &str) -> bool {
    ERROR_CODES.iter().any(|code| code.eq_ignore_ascii_case(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spanish_number_formats() {
        assert_eq!(format_number_es(1234.56, "#,##0.00 \"€\"").0, "1.234,56 €");
        assert_eq!(format_number_es(45702.0, "dd/mm/yyyy").0, "14/02/2025");
        assert_eq!(format_number_es(0.256, "0.0%").0, "25,6%");
        assert_eq!(format_number_es(1234.5, "general").0, "1234,5");
        assert_eq!(format_number_es(1234.5, "General").0, "1234,5");
        assert_eq!(format_number_es(-3.0, "0.00").0, "-3,00");
        assert_eq!(format_number_es(1.0 / 3.0, "general").0, "0,333333333");
        assert_eq!(format_number_es(42.0, "general").0, "42");
    }

    #[test]
    fn general_fast_path_matches_ironcalc() {
        for v in [0.5, 1.25, 123456.789, -0.001, 99999999999.0, 3.0e-7, 1.0 / 7.0, 1e10 + 0.5] {
            let fast = general_fast(v).unwrap();
            let slow = format_number(v, "general", es_locale()).text;
            assert_eq!(fast, slow, "value {v}");
        }
    }

    #[test]
    fn number_format_colors() {
        let (text, color) = format_number_es(-5.0, "0;[Red]-0");
        assert_eq!(text, "-5");
        assert_eq!(color, Some("#ff0000"));
        assert_eq!(format_number_es(5.0, "0;[Red]-0").1, None);
    }

    #[test]
    fn booleans_and_errors_display() {
        assert_eq!(display(&RawValue::Bool(true), "general").text, "VERDADERO");
        assert_eq!(display(&RawValue::Bool(false), "general").text, "FALSO");
        assert_eq!(display(&RawValue::Error(IcError::DIV), "general").text, "#DIV/0!");
    }

    #[test]
    fn canonical_parsing() {
        assert_eq!(parse_canonical("1234.5"), Parsed::Number(1234.5));
        assert_eq!(parse_canonical("-1e3"), Parsed::Number(-1000.0));
        assert_eq!(parse_canonical("TRUE"), Parsed::Bool(true));
        assert_eq!(parse_canonical("=A1*2"), Parsed::Formula("=A1*2"));
        assert_eq!(parse_canonical("'00123"), Parsed::Text { text: "00123", forced: true });
        assert_eq!(parse_canonical("#N/A"), Parsed::Error("#N/A"));
        assert_eq!(parse_canonical("hola"), Parsed::Text { text: "hola", forced: false });
        assert_eq!(parse_canonical("1.234,5"), Parsed::Text { text: "1.234,5", forced: false });
        assert_eq!(number_input(1234.5), "1234.5");
        assert_eq!(number_input(0.1 + 0.2), "0.3");
    }
}
