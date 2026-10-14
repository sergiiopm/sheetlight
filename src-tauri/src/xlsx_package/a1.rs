//! A1 references of package XML (`ref`, `sqref`), 0-based.

use crate::engine::types::{CellRange, MAX_COLS, MAX_ROWS};

/// `A1`, `$B$2`, `A1:C10`, `A:C`, `2:5` -> inclusive 0-based range.
pub fn parse_range(text: &str) -> Option<CellRange> {
    let text = text.trim();
    let text = text.rsplit_once('!').map_or(text, |(_, r)| r);
    let (a, b) = text.split_once(':').unwrap_or((text, text));
    let (ra, ca) = parse_cell(a)?;
    let (rb, cb) = parse_cell(b)?;
    let (r0, r1) = match (ra, rb) {
        (Some(x), Some(y)) => (x.min(y), x.max(y)),
        (None, None) => (0, MAX_ROWS - 1),
        _ => return None,
    };
    let (c0, c1) = match (ca, cb) {
        (Some(x), Some(y)) => (x.min(y), x.max(y)),
        (None, None) => (0, MAX_COLS - 1),
        _ => return None,
    };
    Some(CellRange { r0, c0, r1, c1 })
}

/// Space-separated list of ranges (`sqref`).
pub fn parse_sqref(text: &str) -> Vec<CellRange> {
    text.split_ascii_whitespace().filter_map(parse_range).collect()
}

/// (row, col), each optional for whole-column / whole-row references.
fn parse_cell(text: &str) -> Option<(Option<u32>, Option<u32>)> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let mut i = 0;
    if bytes.get(i) == Some(&b'$') {
        i += 1;
    }
    let mut col: u32 = 0;
    let col_start = i;
    while i < bytes.len() && bytes[i].is_ascii_alphabetic() {
        col = col.checked_mul(26)?.checked_add(u32::from(bytes[i].to_ascii_uppercase() - b'A') + 1)?;
        i += 1;
    }
    let has_col = i > col_start;
    if bytes.get(i) == Some(&b'$') {
        i += 1;
    }
    let row_text = &text[i..];
    let row = if row_text.is_empty() {
        None
    } else {
        let r: u32 = row_text.parse().ok()?;
        if r == 0 || r > MAX_ROWS {
            return None;
        }
        Some(r - 1)
    };
    if !has_col && row.is_none() {
        return None;
    }
    let col = if has_col {
        if col > MAX_COLS {
            return None;
        }
        Some(col - 1)
    } else {
        None
    };
    Some((row, col))
}

pub fn column_name(col: u32) -> String {
    let mut n = col + 1;
    let mut out = Vec::new();
    while n > 0 {
        let rem = (n - 1) % 26;
        out.push(b'A' + rem as u8);
        n = (n - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

pub fn format_range(range: CellRange) -> String {
    let a = format!("{}{}", column_name(range.c0), range.r0 + 1);
    if range.r0 == range.r1 && range.c0 == range.c1 {
        a
    } else {
        format!("{a}:{}{}", column_name(range.c1), range.r1 + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats() {
        assert_eq!(parse_range("A1:C10"), Some(CellRange { r0: 0, c0: 0, r1: 9, c1: 2 }));
        assert_eq!(parse_range("$B$2"), Some(CellRange { r0: 1, c0: 1, r1: 1, c1: 1 }));
        assert_eq!(parse_range("AA3:A1"), Some(CellRange { r0: 0, c0: 0, r1: 2, c1: 26 }));
        assert_eq!(parse_range("B:C"), Some(CellRange { r0: 0, c0: 1, r1: MAX_ROWS - 1, c1: 2 }));
        assert_eq!(parse_range("Hoja1!A1"), Some(CellRange { r0: 0, c0: 0, r1: 0, c1: 0 }));
        assert_eq!(parse_range("A0"), None);
        assert_eq!(parse_range("1A"), None);
        assert_eq!(parse_sqref("A1 C3:D4").len(), 2);
        assert_eq!(format_range(CellRange { r0: 0, c0: 0, r1: 9, c1: 27 }), "A1:AB10");
        assert_eq!(column_name(16_383), "XFD");
    }
}
