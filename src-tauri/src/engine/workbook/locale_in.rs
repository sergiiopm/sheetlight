//! Parsing of display strings typed or pasted in the Spanish locale
//! (`1.234,56 €`, `25 %`, `14/02/2025`, `VERDADERO`). Used for clipboard text
//! from other applications and small CSV imports; the editor has its own TS
//! parser (`src/lib/locale.ts`) for typed input.

use ironcalc_base::formatter::dates::date_to_serial_number;

use super::display::is_error_code;

#[derive(Debug, Clone, PartialEq)]
pub enum LocalValue {
    Empty,
    Number(f64),
    Bool(bool),
    Error(String),
    Text(String),
}

/// A parsed value and the number format it implies (if any).
#[derive(Debug, Clone, PartialEq)]
pub struct Local {
    pub value: LocalValue,
    pub num_fmt: Option<String>,
}

impl Local {
    fn plain(value: LocalValue) -> Self {
        Self { value, num_fmt: None }
    }
}

pub fn parse_local(text: &str) -> Local {
    let t = text.trim();
    if t.is_empty() {
        return Local::plain(LocalValue::Empty);
    }
    let upper = t.to_uppercase();
    match upper.as_str() {
        "VERDADERO" | "TRUE" => return Local::plain(LocalValue::Bool(true)),
        "FALSO" | "FALSE" => return Local::plain(LocalValue::Bool(false)),
        _ => {}
    }
    if is_error_code(&upper) {
        return Local::plain(LocalValue::Error(upper));
    }
    if let Some(local) = parse_date_time(t) {
        return local;
    }
    if let Some(local) = parse_number(t) {
        return local;
    }
    Local::plain(LocalValue::Text(text.to_string()))
}

fn decimals_suffix(decimals: usize) -> String {
    if decimals == 0 {
        String::new()
    } else {
        format!(".{}", "0".repeat(decimals.min(10)))
    }
}

/// Numbers with `.` thousands and `,` decimals (also plain `1234.5`),
/// percentages, euro/dollar amounts, parentheses for negatives, exponents.
fn parse_number(text: &str) -> Option<Local> {
    let mut s = text.replace(['\u{a0}', '\u{202f}'], " ");
    let mut negative = false;
    if s.starts_with('(') && s.ends_with(')') {
        negative = true;
        s = s[1..s.len() - 1].trim().to_string();
    }
    let mut percent = false;
    if let Some(rest) = s.strip_suffix('%') {
        percent = true;
        s = rest.trim_end().to_string();
    }
    let mut currency: Option<(&str, bool)> = None; // (symbol, before)
    for symbol in ["€", "$"] {
        if let Some(rest) = s.strip_suffix(symbol) {
            currency = Some((symbol, false));
            s = rest.trim_end().to_string();
            break;
        }
        if let Some(rest) = s.strip_prefix(symbol) {
            currency = Some((symbol, true));
            s = rest.trim_start().to_string();
            break;
        }
    }
    if let Some(rest) = s.strip_prefix('-') {
        negative = !negative;
        s = rest.trim_start().to_string();
    } else if let Some(rest) = s.strip_prefix('+') {
        s = rest.trim_start().to_string();
    }
    if currency.is_none() {
        for symbol in ["€", "$"] {
            if let Some(rest) = s.strip_prefix(symbol) {
                currency = Some((symbol, true));
                s = rest.trim_start().to_string();
            }
        }
    }
    if s.is_empty() || !s.chars().next()?.is_ascii_digit() && !s.starts_with(',') {
        return None;
    }
    // Exponent.
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(pos) => {
            let exp: i32 = s[pos + 1..].trim_start_matches('+').parse().ok()?;
            (s[..pos].to_string(), Some(exp))
        }
        None => (s.clone(), None),
    };
    if !mantissa.chars().all(|c| c.is_ascii_digit() || c == '.' || c == ',') {
        return None;
    }
    let commas = mantissa.matches(',').count();
    let dots = mantissa.matches('.').count();
    let (int_part, frac_part, grouped) = if commas == 1 {
        // `1.234,56` / `1234,5`: dots must be thousands groups.
        let (int, frac) = mantissa.split_once(',')?;
        if dots > 0 && !valid_groups(int, '.') {
            return None;
        }
        (int.replace('.', ""), frac.to_string(), dots > 0)
    } else if commas == 0 && dots == 1 {
        let (int, frac) = mantissa.split_once('.')?;
        if frac.len() == 3 && !int.is_empty() && exponent.is_none() {
            (format!("{int}{frac}"), String::new(), true) // `1.234` = 1234
        } else {
            (int.to_string(), frac.to_string(), false) // `1234.5` from en sources
        }
    } else if commas == 0 && dots > 1 {
        if !valid_groups(&mantissa, '.') {
            return None;
        }
        (mantissa.replace('.', ""), String::new(), true)
    } else if commas == 0 {
        (mantissa.clone(), String::new(), false)
    } else {
        return None;
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    let literal = format!("{}.{}", if int_part.is_empty() { "0" } else { &int_part }, if frac_part.is_empty() { "0" } else { &frac_part });
    let mut value: f64 = literal.parse().ok()?;
    if let Some(exp) = exponent {
        value *= 10f64.powi(exp);
    }
    if negative {
        value = -value;
    }
    if percent {
        value /= 100.0;
    }
    let decimals = frac_part.len();
    let num_fmt = if exponent.is_some() {
        Some("0.00E+00".to_string())
    } else if percent {
        Some(format!("0{}%", decimals_suffix(decimals)))
    } else if let Some((symbol, before)) = currency {
        let body = format!("#,##0{}", decimals_suffix(decimals));
        Some(if before { format!("\"{symbol}\"{body}") } else { format!("{body} \"{symbol}\"") })
    } else if grouped {
        Some(format!("#,##0{}", decimals_suffix(decimals)))
    } else {
        None
    };
    Some(Local { value: LocalValue::Number(value), num_fmt })
}

/// `1.234.567` style grouping: first group 1–3 digits, then groups of 3.
fn valid_groups(text: &str, sep: char) -> bool {
    let groups: Vec<&str> = text.split(sep).collect();
    !groups.is_empty()
        && (1..=3).contains(&groups[0].len())
        && groups[1..].iter().all(|g| g.len() == 3)
        && groups.iter().all(|g| g.chars().all(|c| c.is_ascii_digit()))
}

fn year4(year: i32, digits: usize) -> i32 {
    if digits <= 2 {
        if year < 30 {
            2000 + year
        } else {
            1900 + year
        }
    } else {
        year
    }
}

fn parse_time(text: &str) -> Option<(f64, bool)> {
    let parts: Vec<&str> = text.split(':').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || p.len() > 2 && !p.contains(',')) {
        return None;
    }
    let h: u32 = parts[0].parse().ok()?;
    let m: u32 = parts[1].parse().ok()?;
    let s: f64 = match parts.get(2) {
        Some(p) => p.replace(',', ".").parse().ok()?,
        None => 0.0,
    };
    if h > 23 || m > 59 || s >= 60.0 {
        return None;
    }
    Some(((f64::from(h) * 3600.0 + f64::from(m) * 60.0 + s) / 86400.0, parts.len() == 3))
}

/// `14/02/2025`, `14-2-25`, `2025-02-14`, optional time; or a bare time.
fn parse_date_time(text: &str) -> Option<Local> {
    let (date_part, time_part) = match text.split_once(' ') {
        Some((d, t)) => (d.trim(), Some(t.trim())),
        None => (text, None),
    };
    if !date_part.contains(['/', '-']) {
        // Bare time.
        if time_part.is_none() && date_part.contains(':') {
            let (fraction, seconds) = parse_time(date_part)?;
            let fmt = if seconds { "hh:mm:ss" } else { "hh:mm" };
            return Some(Local { value: LocalValue::Number(fraction), num_fmt: Some(fmt.to_string()) });
        }
        return None;
    }
    let sep = if date_part.contains('/') { '/' } else { '-' };
    let parts: Vec<&str> = date_part.split(sep).collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let (day, month, year) = if parts[0].len() == 4 {
        (parts[2].parse::<u32>().ok()?, parts[1].parse::<u32>().ok()?, parts[0].parse::<i32>().ok()?)
    } else {
        (
            parts[0].parse::<u32>().ok()?,
            parts[1].parse::<u32>().ok()?,
            year4(parts[2].parse::<i32>().ok()?, parts[2].len()),
        )
    };
    let serial = date_to_serial_number(day, month, year).ok()?;
    let mut value = f64::from(serial);
    let mut fmt = "dd/mm/yyyy".to_string();
    if let Some(time) = time_part {
        let (fraction, seconds) = parse_time(time)?;
        value += fraction;
        fmt.push_str(if seconds { " hh:mm:ss" } else { " hh:mm" });
    }
    Some(Local { value: LocalValue::Number(value), num_fmt: Some(fmt) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number(text: &str) -> (f64, Option<String>) {
        match parse_local(text) {
            Local { value: LocalValue::Number(n), num_fmt } => (n, num_fmt),
            other => panic!("{text}: {other:?}"),
        }
    }

    #[test]
    fn spanish_numbers() {
        assert_eq!(number("1234,5"), (1234.5, None));
        assert_eq!(number("1.234,56"), (1234.56, Some("#,##0.00".into())));
        assert_eq!(number("1.234.567"), (1234567.0, Some("#,##0".into())));
        assert_eq!(number("-12"), (-12.0, None));
        assert_eq!(number("1234.5"), (1234.5, None));
        assert_eq!(number("1.234"), (1234.0, Some("#,##0".into())));
        assert_eq!(number("(1.234,50)"), (-1234.5, Some("#,##0.00".into())));
        assert_eq!(number("1,5E+3").0, 1500.0);
    }

    #[test]
    fn percent_and_currency() {
        assert_eq!(number("25%"), (0.25, Some("0%".into())));
        assert_eq!(number("12,5 %"), (0.125, Some("0.0%".into())));
        assert_eq!(number("1.234,56 €"), (1234.56, Some("#,##0.00 \"€\"".into())));
        assert_eq!(number("-5 €"), (-5.0, Some("#,##0 \"€\"".into())));
        assert_eq!(number("$10"), (10.0, Some("\"$\"#,##0".into())));
    }

    #[test]
    fn dates_and_times() {
        let feb14 = f64::from(date_to_serial_number(14, 2, 2025).unwrap());
        assert_eq!(number("14/02/2025"), (feb14, Some("dd/mm/yyyy".into())));
        assert_eq!(number("14/2/25"), (feb14, Some("dd/mm/yyyy".into())));
        assert_eq!(number("2025-02-14"), (feb14, Some("dd/mm/yyyy".into())));
        assert_eq!(number("14/02/2025 12:00").0, feb14 + 0.5);
        assert_eq!(number("13:30"), (13.5 / 24.0, Some("hh:mm".into())));
        assert!(matches!(parse_local("32/13/2025").value, LocalValue::Text(_)));
    }

    #[test]
    fn other_values() {
        assert_eq!(parse_local("VERDADERO").value, LocalValue::Bool(true));
        assert_eq!(parse_local("falso").value, LocalValue::Bool(false));
        assert_eq!(parse_local("#N/A").value, LocalValue::Error("#N/A".into()));
        assert_eq!(parse_local("Madrid").value, LocalValue::Text("Madrid".into()));
        assert_eq!(parse_local("12abc").value, LocalValue::Text("12abc".into()));
        assert_eq!(parse_local("1.23.4").value, LocalValue::Text("1.23.4".into()));
        assert_eq!(parse_local("  ").value, LocalValue::Empty);
    }
}
