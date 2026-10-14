//! Cell values of the CSV store, typed field parsing (numbers, dates, booleans)
//! and allocation-free display formatting that matches the workbook engine
//! (IronCalc's `General` and date formats rendered for the `es` locale).

use std::fmt::Write as _;

/// Number format of a numeric cell. Kept tiny (`u8`) because it is stored per
/// cell in mixed columns. Date variants remember whether the source text was
/// ISO (`yyyy-mm-dd`) or day-first (`dd/mm/yyyy`) so CSV saves round-trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Fmt {
    General = 0,
    Percent0,
    Percent2,
    DateDmy,
    DateTimeDmy,
    DateTimeSecDmy,
    DateIso,
    DateTimeIso,
    DateTimeSecIso,
}

impl Fmt {
    /// Excel number format code reported to the UI / used on promotion.
    pub fn code(self) -> &'static str {
        match self {
            Fmt::General => "General",
            Fmt::Percent0 => "0%",
            Fmt::Percent2 => "0.00%",
            Fmt::DateDmy | Fmt::DateIso => "dd/mm/yyyy",
            Fmt::DateTimeDmy | Fmt::DateTimeIso => "dd/mm/yyyy hh:mm",
            Fmt::DateTimeSecDmy | Fmt::DateTimeSecIso => "dd/mm/yyyy hh:mm:ss",
        }
    }

    /// Format codes accepted from `setCells.numFmt` without promoting the
    /// document to a workbook.
    pub fn from_code(code: &str) -> Option<Fmt> {
        let code = code.trim();
        if code.eq_ignore_ascii_case("general") {
            return Some(Fmt::General);
        }
        Some(match code {
            "0%" => Fmt::Percent0,
            "0.00%" => Fmt::Percent2,
            "dd/mm/yyyy" => Fmt::DateDmy,
            "dd/mm/yyyy hh:mm" => Fmt::DateTimeDmy,
            "dd/mm/yyyy hh:mm:ss" => Fmt::DateTimeSecDmy,
            _ => return None,
        })
    }

    pub fn is_date(self) -> bool {
        self >= Fmt::DateDmy
    }

    fn is_iso(self) -> bool {
        self >= Fmt::DateIso
    }

    /// Same precision, ISO source style.
    pub fn as_iso(self) -> Fmt {
        match self {
            Fmt::DateDmy => Fmt::DateIso,
            Fmt::DateTimeDmy => Fmt::DateTimeIso,
            Fmt::DateTimeSecDmy => Fmt::DateTimeSecIso,
            other => other,
        }
    }

    fn time_precision(self) -> u8 {
        match self {
            Fmt::DateTimeDmy | Fmt::DateTimeIso => 1,
            Fmt::DateTimeSecDmy | Fmt::DateTimeSecIso => 2,
            _ => 0,
        }
    }
}

/// One cell. 16 bytes; text lives in the store's string table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Val {
    Empty,
    Num(f64, Fmt),
    Bool(bool),
    Text(u32),
}

impl Val {
    pub fn is_empty(&self) -> bool {
        matches!(self, Val::Empty)
    }
}

/// Result of typing one CSV field / one plain input.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Typed {
    Empty,
    Num(f64, Fmt),
    Bool(bool),
    Text,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Types a CSV field. `decimal` is `b'.'` or `b','`; the other one is accepted
/// as a thousands separator when correctly grouped.
pub fn type_field(field: &str, decimal: u8) -> Typed {
    let trimmed = field.trim_matches(|c| c == ' ' || c == '\t');
    if trimmed.is_empty() {
        return if field.is_empty() { Typed::Empty } else { Typed::Text };
    }
    let bytes = trimmed.as_bytes();
    let first = bytes[0];
    if first.is_ascii_digit() || first == b'-' || first == b'+' || first == b'.' || first == b',' {
        if let Some((value, fmt)) = parse_number(bytes, decimal) {
            return Typed::Num(value, fmt);
        }
        if first.is_ascii_digit() {
            if let Some((serial, fmt)) = parse_date(bytes) {
                return Typed::Num(serial, fmt);
            }
        }
        return Typed::Text;
    }
    if let Some(value) = parse_bool(trimmed) {
        return Typed::Bool(value);
    }
    Typed::Text
}

/// Types a canonical (en-US) input from `setCells`: `1234.5`, `TRUE`, text.
/// A leading `'` forces text. Returns `None` for inputs the store does not
/// handle itself (formulas and locale-looking values such as `50%`, `1,5`
/// or `14/02/2025`, which the workbook engine would interpret).
pub fn type_input(input: &str) -> Option<Typed> {
    if input.is_empty() {
        return Some(Typed::Empty);
    }
    if input.starts_with('\'') {
        return Some(Typed::Text);
    }
    if input.starts_with('=') {
        return None;
    }
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Some(Typed::Text);
    }
    if let Some(value) = parse_canonical_number(trimmed) {
        return Some(Typed::Num(value, Fmt::General));
    }
    if trimmed.eq_ignore_ascii_case("true") {
        return Some(Typed::Bool(true));
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return Some(Typed::Bool(false));
    }
    // Things IronCalc would parse into numbers (percentages, currencies,
    // dates, grouped numbers): let the workbook engine handle them.
    let bytes = trimmed.as_bytes();
    let numberish = bytes
        .iter()
        .all(|b| b.is_ascii_digit() || b" .,-+%$/:eE".contains(b) || *b >= 0x80);
    if numberish && bytes.iter().any(u8::is_ascii_digit) {
        return None;
    }
    Some(Typed::Text)
}

/// Strict en-US number (`-1234.5`, `1e-7`), no grouping.
pub fn parse_canonical_number(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if !valid_plain_number(bytes, b'.') {
        return None;
    }
    text.parse::<f64>().ok().filter(|v| v.is_finite())
}

fn parse_bool(text: &str) -> Option<bool> {
    if text.len() > 9 {
        return None;
    }
    if text.eq_ignore_ascii_case("true") || text.eq_ignore_ascii_case("verdadero") {
        Some(true)
    } else if text.eq_ignore_ascii_case("false") || text.eq_ignore_ascii_case("falso") {
        Some(false)
    } else {
        None
    }
}

/// `[sign] digits [. digits] [e [sign] digits]` with `dec` as the decimal mark.
fn valid_plain_number(bytes: &[u8], dec: u8) -> bool {
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
        i += 1;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < bytes.len() && bytes[i] == dec {
        i += 1;
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits + frac_digits == 0 {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        i += 1;
        if i < bytes.len() && (bytes[i] == b'-' || bytes[i] == b'+') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

/// Parses a locale number field into `(value, fmt)`. Rules (chosen to keep
/// identifiers intact, unlike Excel):
/// - integers with leading zeros (`007`) and integers with more than 15
///   digits stay text;
/// - the non-decimal separator is accepted only as a correctly grouped
///   thousands separator (`1.234.567,8` / `1,234,567.8`);
/// - a trailing `%` makes a percentage.
fn parse_number(bytes: &[u8], decimal: u8) -> Option<(f64, Fmt)> {
    let group = if decimal == b',' { b'.' } else { b',' };
    let (body, percent) = match bytes.last() {
        Some(b'%') => (bytes[..bytes.len() - 1].strip_suffix(b" ").unwrap_or(&bytes[..bytes.len() - 1]), true),
        _ => (bytes, false),
    };
    if body.is_empty() || body.len() > 48 {
        return None;
    }
    let mut buf = [0u8; 48];
    let mut n = 0;
    let mut i = 0;
    if body[0] == b'-' || body[0] == b'+' {
        buf[n] = body[0];
        n += 1;
        i = 1;
    }
    // Integer part with optional grouping.
    let int_start = i;
    let mut digits_in_group = 0usize;
    let mut groups = 0usize;
    let mut first_group_len = 0usize;
    let mut int_digits = 0usize;
    while i < body.len() {
        let b = body[i];
        if b.is_ascii_digit() {
            buf[n] = b;
            n += 1;
            digits_in_group += 1;
            int_digits += 1;
        } else if b == group {
            if groups == 0 {
                if digits_in_group == 0 || digits_in_group > 3 {
                    return None;
                }
                first_group_len = digits_in_group;
            } else if digits_in_group != 3 {
                return None;
            }
            groups += 1;
            digits_in_group = 0;
        } else {
            break;
        }
        i += 1;
    }
    if groups > 0 && digits_in_group != 3 {
        return None;
    }
    let _ = first_group_len;
    let int_part = &body[int_start..i];
    if groups > 0 && int_part.first() == Some(&b'0') {
        return None;
    }
    let mut frac_digits = 0;
    if i < body.len() && body[i] == decimal {
        buf[n] = b'.';
        n += 1;
        i += 1;
        while i < body.len() && body[i].is_ascii_digit() {
            buf[n] = body[i];
            n += 1;
            frac_digits += 1;
            i += 1;
        }
    }
    if int_digits + frac_digits == 0 {
        return None;
    }
    let mut has_exp = false;
    if i < body.len() && (body[i] == b'e' || body[i] == b'E') && groups == 0 {
        has_exp = true;
        buf[n] = b'e';
        n += 1;
        i += 1;
        if i < body.len() && (body[i] == b'-' || body[i] == b'+') {
            buf[n] = body[i];
            n += 1;
            i += 1;
        }
        let start = i;
        while i < body.len() && body[i].is_ascii_digit() {
            buf[n] = body[i];
            n += 1;
            i += 1;
        }
        if i == start {
            return None;
        }
    }
    if i != body.len() {
        return None;
    }
    // Identifiers: leading zeros / too many digits for an f64.
    if groups == 0 && frac_digits == 0 && !has_exp {
        if int_part.len() > 1 && int_part[0] == b'0' {
            return None;
        }
        if int_digits > 15 {
            return None;
        }
    }
    let text = std::str::from_utf8(&buf[..n]).ok()?;
    let mut value: f64 = text.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    if percent {
        value /= 100.0;
        let fmt = if frac_digits > 0 { Fmt::Percent2 } else { Fmt::Percent0 };
        return Some((value, fmt));
    }
    Some((value, Fmt::General))
}

fn digits(bytes: &[u8], at: usize, min: usize, max: usize) -> Option<(u32, usize)> {
    let mut value = 0u32;
    let mut i = at;
    while i < bytes.len() && i - at < max && bytes[i].is_ascii_digit() {
        value = value * 10 + u32::from(bytes[i] - b'0');
        i += 1;
    }
    if i - at < min {
        return None;
    }
    Some((value, i))
}

/// `yyyy-mm-dd[( |T)hh:mm[:ss[.fff]]]` or `d/m/yyyy[ hh:mm[:ss]]`.
fn parse_date(bytes: &[u8]) -> Option<(f64, Fmt)> {
    let (y, m, d, iso, mut i) = if bytes.len() >= 10 && bytes[4] == b'-' {
        let (y, i) = digits(bytes, 0, 4, 4)?;
        if bytes.get(i) != Some(&b'-') {
            return None;
        }
        let (m, i) = digits(bytes, i + 1, 2, 2)?;
        if bytes.get(i) != Some(&b'-') {
            return None;
        }
        let (d, i) = digits(bytes, i + 1, 2, 2)?;
        (y, m, d, true, i)
    } else {
        let (d, i) = digits(bytes, 0, 1, 2)?;
        if bytes.get(i) != Some(&b'/') {
            return None;
        }
        let (m, i) = digits(bytes, i + 1, 1, 2)?;
        if bytes.get(i) != Some(&b'/') {
            return None;
        }
        let (y, i) = digits(bytes, i + 1, 4, 4)?;
        (y, m, d, false, i)
    };
    let days = days_from_civil(y as i32, m, d)?;
    let mut serial = days as f64;
    let mut precision = 0u8;
    if i < bytes.len() {
        if bytes[i] != b' ' && !(iso && bytes[i] == b'T') {
            return None;
        }
        i += 1;
        let (hh, j) = digits(bytes, i, 1, 2)?;
        if bytes.get(j) != Some(&b':') {
            return None;
        }
        let (mm, mut j) = digits(bytes, j + 1, 2, 2)?;
        let mut ss = 0f64;
        precision = 1;
        if bytes.get(j) == Some(&b':') {
            let (s, k) = digits(bytes, j + 1, 2, 2)?;
            ss = f64::from(s);
            j = k;
            precision = 2;
            if bytes.get(j) == Some(&b'.') {
                let start = j + 1;
                let (frac, k) = digits(bytes, start, 1, 9)?;
                ss += f64::from(frac) / 10f64.powi((k - start) as i32);
                j = k;
            }
        }
        if j != bytes.len() || hh > 23 || mm > 59 || ss >= 60.0 {
            return None;
        }
        serial += (f64::from(hh) * 3600.0 + f64::from(mm) * 60.0 + ss) / 86_400.0;
    }
    let fmt = match (iso, precision) {
        (true, 0) => Fmt::DateIso,
        (true, 1) => Fmt::DateTimeIso,
        (true, _) => Fmt::DateTimeSecIso,
        (false, 0) => Fmt::DateDmy,
        (false, 1) => Fmt::DateTimeDmy,
        (false, _) => Fmt::DateTimeSecDmy,
    };
    Some((serial, fmt))
}

/// Excel serial (1900 system) of a civil date; `None` when invalid or before
/// 1900-03-01 (Excel's fake 1900-02-29 makes earlier serials ambiguous).
pub fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y, m) || !(1900..=9999).contains(&y) {
        return None;
    }
    let serial = epoch_days(y, m, d) - epoch_days(1899, 12, 30);
    if serial < 61 {
        return None;
    }
    Some(serial)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    }
}

/// Days since 1970-01-01 (Howard Hinnant's algorithm).
fn epoch_days(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(m);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Civil date of an Excel serial (1900 system, including the fake 29/02/1900).
pub fn civil_from_serial(serial: i64) -> (i32, u32, u32) {
    if serial == 60 {
        return (1900, 2, 29);
    }
    let days = if serial < 60 { serial + 1 } else { serial } + epoch_days(1899, 12, 30);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/// IronCalc's `General` rendering (see `formatter::format::format_number`),
/// written into `out` without allocating. `decimal` replaces `.`.
pub fn write_general(value: f64, decimal: char, out: &mut String) {
    let start = out.len();
    let abs = value.abs();
    if (1.0e-8..1.0e+11).contains(&abs) {
        let _ = write!(out, "{value:.9}");
        let trimmed = out[start..].trim_end_matches('0').trim_end_matches('.').len();
        out.truncate(start + trimmed);
    } else if abs == 0.0 {
        out.push('0');
        return;
    } else {
        let exponent = abs.log10().floor();
        let mantissa = value / 10.0_f64.powf(exponent);
        let _ = write!(out, "{mantissa:.5}");
        let trimmed = out[start..].trim_end_matches('0').trim_end_matches('.').len();
        out.truncate(start + trimmed);
        let sign = if exponent < 0.0 { '-' } else { '+' };
        let _ = write!(out, "E{sign}{:02}", exponent.abs());
    }
    if decimal != '.' {
        // Only ASCII in the buffer: replace in place.
        if let Some(pos) = out[start..].find('.') {
            out.replace_range(start + pos..start + pos + 1, decimal.encode_utf8(&mut [0; 4]));
        }
    }
}

fn push2(out: &mut String, v: u32) {
    out.push(char::from(b'0' + (v / 10 % 10) as u8));
    out.push(char::from(b'0' + (v % 10) as u8));
}

fn push4(out: &mut String, v: i32) {
    let _ = write!(out, "{v:04}");
}

/// Splits a serial into (days, hours, minutes, seconds) rounding to the
/// nearest millisecond first, so 12:30 never shows as 12:29.
fn split_serial(serial: f64) -> (i64, u32, u32, u32) {
    let ms = (serial * 86_400_000.0).round() as i64;
    let days = ms.div_euclid(86_400_000);
    let rest = ms.rem_euclid(86_400_000) / 1000;
    (days, (rest / 3600) as u32, (rest / 60 % 60) as u32, (rest % 60) as u32)
}

/// Writes a date serial using `fmt` (display: always `dd/mm/yyyy[ hh:mm[:ss]]`).
pub fn write_date_display(serial: f64, fmt: Fmt, out: &mut String) {
    let (days, h, m, s) = split_serial(serial);
    let (y, mo, d) = civil_from_serial(days);
    push2(out, d);
    out.push('/');
    push2(out, mo);
    out.push('/');
    push4(out, y);
    write_time(out, fmt.time_precision(), h, m, s);
}

/// Writes a date in its source style (ISO or dd/mm/yyyy), used by CSV export.
pub fn write_date_source(serial: f64, fmt: Fmt, out: &mut String) {
    if !fmt.is_iso() {
        write_date_display(serial, fmt, out);
        return;
    }
    let (days, h, m, s) = split_serial(serial);
    let (y, mo, d) = civil_from_serial(days);
    push4(out, y);
    out.push('-');
    push2(out, mo);
    out.push('-');
    push2(out, d);
    write_time(out, fmt.time_precision(), h, m, s);
}

fn write_time(out: &mut String, precision: u8, h: u32, m: u32, s: u32) {
    if precision == 0 {
        return;
    }
    out.push(' ');
    push2(out, h);
    out.push(':');
    push2(out, m);
    if precision == 2 {
        out.push(':');
        push2(out, s);
    }
}

/// Display string of a numeric cell for the es locale.
pub fn write_number_display(value: f64, fmt: Fmt, out: &mut String) {
    match fmt {
        Fmt::General => write_general(value, ',', out),
        Fmt::Percent0 | Fmt::Percent2 => {
            let locale = ironcalc_base::locale::get_locale("es").ok();
            match locale {
                Some(locale) => {
                    let formatted = ironcalc_base::formatter::format::format_number(value, fmt.code(), locale);
                    out.push_str(&formatted.text);
                }
                None => write_general(value * 100.0, ',', out),
            }
        }
        _ => write_date_display(value, fmt, out),
    }
}

/// Canonical en-US input of a number (`1234.5`): shortest round-trip form.
pub fn write_canonical_number(value: f64, out: &mut String) {
    if value == 0.0 {
        out.push('0');
    } else {
        let _ = write!(out, "{value}");
    }
}

pub const TRUE_DISPLAY: &str = "VERDADERO";
pub const FALSE_DISPLAY: &str = "FALSO";

#[cfg(test)]
mod tests {
    use super::*;
    use ironcalc_base::formatter::format::format_number;
    use ironcalc_base::locale::get_locale;

    fn general(v: f64) -> String {
        let mut s = String::new();
        write_general(v, ',', &mut s);
        s
    }

    #[test]
    fn general_matches_ironcalc_es() {
        let es = get_locale("es").unwrap();
        for v in [
            0.0, 1.0, -1.0, 1234.56, -1234.56, 0.1 + 0.2, 1e-9, 1.5e-8, 123456789012.0, 1e15, -2.5e20, 1.234567891234,
            99999999999.0, 1e11, 0.000123, 45678.0, 7.0 / 3.0, 1e-300, 1e300,
        ] {
            assert_eq!(general(v), format_number(v, "general", es).text, "value {v}");
        }
    }

    #[test]
    fn dates_match_ironcalc_es() {
        let es = get_locale("es").unwrap();
        for serial in [61.0, 367.0, 45678.0, 2_958_465.0, 44_000.0] {
            let mut s = String::new();
            write_date_display(serial, Fmt::DateDmy, &mut s);
            assert_eq!(s, format_number(serial, "dd/mm/yyyy", es).text);
        }
        let mut s = String::new();
        write_date_display(45678.75, Fmt::DateTimeSecDmy, &mut s);
        assert_eq!(s, format_number(45678.75, "dd/mm/yyyy hh:mm:ss", es).text);
    }

    #[test]
    fn half_past_twelve_is_not_rounded_down() {
        let (serial, fmt) = match type_field("2025-02-14 12:30", b'.') {
            Typed::Num(v, f) => (v, f),
            other => panic!("{other:?}"),
        };
        let mut s = String::new();
        write_number_display(serial, fmt, &mut s);
        assert_eq!(s, "14/02/2025 12:30");
        s.clear();
        write_date_source(serial, fmt, &mut s);
        assert_eq!(s, "2025-02-14 12:30");
    }

    #[test]
    fn types_fields() {
        assert_eq!(type_field("", b'.'), Typed::Empty);
        assert_eq!(type_field("  ", b'.'), Typed::Text);
        assert_eq!(type_field("12", b'.'), Typed::Num(12.0, Fmt::General));
        assert_eq!(type_field(" -1.5 ", b'.'), Typed::Num(-1.5, Fmt::General));
        assert_eq!(type_field("1,234.5", b'.'), Typed::Num(1234.5, Fmt::General));
        assert_eq!(type_field("1.234,56", b','), Typed::Num(1234.56, Fmt::General));
        assert_eq!(type_field("1234,56", b','), Typed::Num(1234.56, Fmt::General));
        assert_eq!(type_field("1.234", b','), Typed::Num(1234.0, Fmt::General));
        assert_eq!(type_field("1,23", b'.'), Typed::Text, "bad grouping");
        assert_eq!(type_field("007", b'.'), Typed::Text, "leading zeros keep ids");
        assert_eq!(type_field("0.5", b'.'), Typed::Num(0.5, Fmt::General));
        assert_eq!(type_field("1234567890123456789", b'.'), Typed::Text);
        assert_eq!(type_field("1e3", b'.'), Typed::Num(1000.0, Fmt::General));
        assert_eq!(type_field("12%", b'.'), Typed::Num(0.12, Fmt::Percent0));
        assert_eq!(type_field("NaN", b'.'), Typed::Text);
        assert_eq!(type_field("inf", b'.'), Typed::Text);
        assert_eq!(type_field("TRUE", b'.'), Typed::Bool(true));
        assert_eq!(type_field("falso", b'.'), Typed::Bool(false));
        assert_eq!(type_field("2025-02-14", b'.'), Typed::Num(45702.0, Fmt::DateIso));
        assert_eq!(type_field("14/02/2025", b'.'), Typed::Num(45702.0, Fmt::DateDmy));
        assert_eq!(type_field("1/3/1900", b'.'), Typed::Num(61.0, Fmt::DateDmy));
        assert_eq!(type_field("31/02/2025", b'.'), Typed::Text);
        assert_eq!(type_field("2025-02-14T08:05:09", b'.'), Typed::Num(45702.0 + (8.0 * 3600.0 + 5.0 * 60.0 + 9.0) / 86400.0, Fmt::DateTimeSecIso));
        assert_eq!(type_field("Madrid", b'.'), Typed::Text);
    }

    #[test]
    fn types_inputs() {
        assert_eq!(type_input("1234.5"), Some(Typed::Num(1234.5, Fmt::General)));
        assert_eq!(type_input("TRUE"), Some(Typed::Bool(true)));
        assert_eq!(type_input("hola"), Some(Typed::Text));
        assert_eq!(type_input("'007"), Some(Typed::Text));
        assert_eq!(type_input(""), Some(Typed::Empty));
        assert_eq!(type_input("=A1"), None);
        assert_eq!(type_input("50%"), None);
        assert_eq!(type_input("14/02/2025"), None);
        assert_eq!(type_input("calle 5"), Some(Typed::Text));
    }

    #[test]
    fn serial_roundtrip() {
        for serial in [61i64, 365, 1000, 45702, 2_958_465] {
            let (y, m, d) = civil_from_serial(serial);
            assert_eq!(days_from_civil(y, m, d), Some(serial));
        }
        assert_eq!(civil_from_serial(1), (1900, 1, 1));
        assert_eq!(civil_from_serial(60), (1900, 2, 29));
    }
}
