//! RFC 4180 record parsing (quotes, doubled quotes, embedded newlines, CRLF/LF,
//! ragged rows) and detection of encoding, delimiter and decimal separator.

use memchr::{memchr, memchr3};

/// Text encodings the CSV store reads and writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enc {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Windows1252,
}

impl Enc {
    /// Wire name (`CsvOptions.encoding`).
    pub fn name(self) -> &'static str {
        match self {
            Enc::Utf8 => "utf-8",
            Enc::Utf8Bom => "utf-8-bom",
            Enc::Utf16Le => "utf-16le",
            Enc::Utf16Be => "utf-16be",
            Enc::Windows1252 => "windows-1252",
        }
    }

    pub fn from_name(name: &str) -> Option<Enc> {
        Some(match name.trim().to_ascii_lowercase().as_str() {
            "utf-8" | "utf8" => Enc::Utf8,
            "utf-8-bom" | "utf-8-sig" | "utf8-bom" => Enc::Utf8Bom,
            "utf-16le" | "utf-16" | "utf16le" | "unicode" => Enc::Utf16Le,
            "utf-16be" | "utf16be" => Enc::Utf16Be,
            "windows-1252" | "cp1252" | "latin1" | "iso-8859-1" | "ansi" => Enc::Windows1252,
            _ => return None,
        })
    }

    pub fn encoding(self) -> &'static encoding_rs::Encoding {
        match self {
            Enc::Utf8 | Enc::Utf8Bom => encoding_rs::UTF_8,
            Enc::Utf16Le => encoding_rs::UTF_16LE,
            Enc::Utf16Be => encoding_rs::UTF_16BE,
            Enc::Windows1252 => encoding_rs::WINDOWS_1252,
        }
    }
}

/// Detects the encoding of the first bytes of a file.
pub fn detect_encoding(sample: &[u8]) -> Enc {
    if sample.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Enc::Utf8Bom;
    }
    if sample.starts_with(&[0xFF, 0xFE]) {
        return Enc::Utf16Le;
    }
    if sample.starts_with(&[0xFE, 0xFF]) {
        return Enc::Utf16Be;
    }
    // BOM-less UTF-16: many NULs in one byte lane.
    let probe = &sample[..sample.len().min(4096)];
    if probe.len() >= 4 {
        let even = probe.iter().step_by(2).filter(|b| **b == 0).count();
        let odd = probe.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
        let half = probe.len() / 2;
        if odd > half * 3 / 10 && even <= half / 20 {
            return Enc::Utf16Le;
        }
        if even > half * 3 / 10 && odd <= half / 20 {
            return Enc::Utf16Be;
        }
    }
    match std::str::from_utf8(sample) {
        Ok(_) => Enc::Utf8,
        // A multi-byte sequence cut at the end of the sample is fine.
        Err(e) if e.error_len().is_none() => Enc::Utf8,
        Err(_) => Enc::Windows1252,
    }
}

/// Field boundaries of one record inside a buffer.
#[derive(Debug, Clone, Copy)]
pub struct FieldSpan {
    pub start: u32,
    pub end: u32,
    /// Quoted field containing doubled quotes: needs unescaping.
    pub escaped: bool,
}

/// Parses one record starting at `pos`. Pushes field spans (content without
/// the surrounding quotes) and returns the position after the record's line
/// break. Returns `None` when the record is incomplete and `eof` is false.
pub fn parse_record(buf: &[u8], pos: usize, delim: u8, eof: bool, fields: &mut Vec<FieldSpan>) -> Option<usize> {
    fields.clear();
    let mut i = pos;
    loop {
        // Start of a field.
        if i < buf.len() && buf[i] == b'"' {
            // Quoted field.
            let start = i + 1;
            let mut j = start;
            let mut escaped = false;
            let end;
            loop {
                match memchr(b'"', &buf[j..]) {
                    Some(off) => {
                        let q = j + off;
                        if q + 1 < buf.len() && buf[q + 1] == b'"' {
                            escaped = true;
                            j = q + 2;
                            continue;
                        }
                        if q + 1 >= buf.len() && !eof {
                            return None;
                        }
                        end = q;
                        j = q + 1;
                        break;
                    }
                    None => {
                        if !eof {
                            return None;
                        }
                        // Unterminated quote: take the rest of the buffer.
                        end = buf.len();
                        j = buf.len();
                        break;
                    }
                }
            }
            // Lenient: characters after the closing quote up to the delimiter
            // are appended (`"abc"def` -> `abc"def` would be odd; Excel keeps
            // `abcdef`). We keep the quoted part and skip stray text.
            let mut k = j;
            while k < buf.len() && buf[k] != delim && buf[k] != b'\n' && buf[k] != b'\r' {
                k += 1;
            }
            fields.push(FieldSpan { start: start as u32, end: end as u32, escaped });
            if k >= buf.len() {
                if !eof {
                    return None;
                }
                return Some(k);
            }
            if buf[k] == delim {
                i = k + 1;
                continue;
            }
            return line_end(buf, k, eof);
        }
        // Unquoted field: up to the delimiter or line break.
        match memchr3(delim, b'\n', b'\r', &buf[i..]) {
            Some(off) => {
                let k = i + off;
                fields.push(FieldSpan { start: i as u32, end: k as u32, escaped: false });
                if buf[k] == delim {
                    i = k + 1;
                    continue;
                }
                return line_end(buf, k, eof);
            }
            None => {
                if !eof {
                    return None;
                }
                fields.push(FieldSpan { start: i as u32, end: buf.len() as u32, escaped: false });
                return Some(buf.len());
            }
        }
    }
}

/// `k` points at `\r` or `\n`; returns the position after the line break.
fn line_end(buf: &[u8], k: usize, eof: bool) -> Option<usize> {
    if buf[k] == b'\r' {
        if k + 1 < buf.len() {
            return Some(if buf[k + 1] == b'\n' { k + 2 } else { k + 1 });
        }
        if !eof {
            return None; // could be the first half of CRLF
        }
        return Some(k + 1);
    }
    Some(k + 1)
}

/// Field text, unescaping doubled quotes into `scratch` when needed.
pub fn field_text<'a>(buf: &'a [u8], span: FieldSpan, scratch: &'a mut String) -> &'a str {
    let bytes = &buf[span.start as usize..span.end as usize];
    // The buffer is valid UTF-8 and spans start/end at ASCII bytes.
    let text = std::str::from_utf8(bytes).unwrap_or("");
    if !span.escaped {
        return text;
    }
    scratch.clear();
    let mut rest = text;
    while let Some(p) = rest.find("\"\"") {
        scratch.push_str(&rest[..=p]);
        rest = &rest[p + 2..];
    }
    scratch.push_str(rest);
    scratch
}

const CANDIDATES: [u8; 4] = *b",;\t|";

/// Picks the delimiter whose field count is the most consistent over the
/// first records (quotes respected). Defaults to `,`.
pub fn detect_delimiter(sample: &str, eof: bool) -> u8 {
    let buf = sample.as_bytes();
    let mut best = (0u64, b',');
    let mut fields = Vec::new();
    for &delim in &CANDIDATES {
        let mut counts: Vec<usize> = Vec::new();
        let mut pos = 0;
        while pos < buf.len() && counts.len() < 64 {
            match parse_record(buf, pos, delim, eof, &mut fields) {
                Some(next) => {
                    // Skip blank lines.
                    if !(fields.len() == 1 && fields[0].start == fields[0].end) {
                        counts.push(fields.len());
                    }
                    pos = next;
                }
                None => break,
            }
        }
        if counts.is_empty() {
            continue;
        }
        let mut freq: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
        for c in &counts {
            *freq.entry(*c).or_default() += 1;
        }
        let (mode, hits) = freq.into_iter().max_by_key(|(c, n)| (*n, *c)).unwrap_or((1, 0));
        if mode < 2 {
            continue;
        }
        // Consistency first, then more columns.
        let score = (hits as u64 * 1000 / counts.len() as u64) * 1000 + mode.min(999) as u64;
        if score > best.0 {
            best = (score, delim);
        }
    }
    best.1
}

/// Decides the decimal separator for non-comma-delimited files by counting
/// Spanish-style (`1.234,56`, `12,5`) vs English-style (`1,234.56`, `12.5`)
/// numbers in the sample.
pub fn detect_decimal(sample: &str, delim: u8, eof: bool) -> u8 {
    if delim == b',' {
        return b'.';
    }
    let buf = sample.as_bytes();
    let mut fields = Vec::new();
    let mut scratch = String::new();
    let (mut comma, mut dot) = (0usize, 0usize);
    let mut pos = 0;
    let mut records = 0;
    while pos < buf.len() && records < 200 {
        let Some(next) = parse_record(buf, pos, delim, eof, &mut fields) else { break };
        for span in fields.clone() {
            let text = field_text(buf, span, &mut scratch).trim();
            match classify_decimal(text) {
                Some(b',') => comma += 1,
                Some(_) => dot += 1,
                None => {}
            }
        }
        pos = next;
        records += 1;
    }
    if comma > dot {
        b','
    } else {
        b'.'
    }
}

/// `Some(b',')` for unambiguous decimal-comma numbers, `Some(b'.')` for
/// unambiguous decimal-point numbers, `None` otherwise (`1.234` is ambiguous).
fn classify_decimal(text: &str) -> Option<u8> {
    let t = text.strip_prefix('-').unwrap_or(text);
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit() || b == b'.' || b == b',') {
        return None;
    }
    if !t.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    let last_comma = t.rfind(',');
    let last_dot = t.rfind('.');
    match (last_comma, last_dot) {
        (Some(c), Some(d)) => Some(if c > d { b',' } else { b'.' }),
        (Some(c), None) => {
            // `12,5` / `1234,56` -> comma decimal; `1,234` ambiguous.
            let frac = t.len() - c - 1;
            (t.matches(',').count() == 1 && frac != 3 && frac > 0).then_some(b',')
        }
        (None, Some(d)) => {
            let frac = t.len() - d - 1;
            (t.matches('.').count() == 1 && frac != 3 && frac > 0).then_some(b'.')
        }
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records(text: &str, delim: u8) -> Vec<Vec<String>> {
        let buf = text.as_bytes();
        let mut out = Vec::new();
        let mut fields = Vec::new();
        let mut scratch = String::new();
        let mut pos = 0;
        while pos < buf.len() {
            let next = parse_record(buf, pos, delim, true, &mut fields).unwrap();
            out.push(fields.iter().map(|f| field_text(buf, *f, &mut scratch).to_string()).collect());
            pos = next;
        }
        out
    }

    #[test]
    fn parses_rfc4180() {
        let r = records("a,\"b,c\",\"d \"\"q\"\"\"\r\n1,\"multi\nline\",3\nx\n\nlast,", b',');
        assert_eq!(r[0], vec!["a", "b,c", "d \"q\""]);
        assert_eq!(r[1], vec!["1", "multi\nline", "3"]);
        assert_eq!(r[2], vec!["x"]);
        assert_eq!(r[3], vec![""]);
        assert_eq!(r[4], vec!["last", ""]);
        assert_eq!(r.len(), 5);
    }

    #[test]
    fn incomplete_record_waits_for_more_data() {
        let mut fields = Vec::new();
        assert!(parse_record(b"a,\"open", 0, b',', false, &mut fields).is_none());
        assert!(parse_record(b"a,b", 0, b',', false, &mut fields).is_none());
        assert!(parse_record(b"a,b\r", 0, b',', false, &mut fields).is_none());
        assert_eq!(parse_record(b"a,b\r\nc", 0, b',', false, &mut fields), Some(5));
        assert_eq!(parse_record(b"a,\"open", 0, b',', true, &mut fields), Some(7));
    }

    #[test]
    fn detects_delimiters() {
        assert_eq!(detect_delimiter("a,b,c\n1,2,3\n", true), b',');
        assert_eq!(detect_delimiter("a;b;c\n1,5;2,5;3\n4;5;6\n", true), b';');
        assert_eq!(detect_delimiter("a\tb\n\"x\ty\"\t2\n", true), b'\t');
        assert_eq!(detect_delimiter("a|b|c\n1|2|3\n", true), b'|');
        assert_eq!(detect_delimiter("solo\nuna\ncolumna\n", true), b',');
        assert_eq!(detect_delimiter("nombre;importe\n\"Pérez, Juan\";1.234,56\n\"Gómez, Ana\";12,5\n", true), b';');
    }

    #[test]
    fn detects_decimal() {
        assert_eq!(detect_decimal("a;b\n1.234,56;12,5\n3;4\n", b';', true), b',');
        assert_eq!(detect_decimal("a;b\n1234.56;12.5\n", b';', true), b'.');
        assert_eq!(detect_decimal("a,b\n1,5\n", b',', true), b'.');
        assert_eq!(detect_decimal("a;b\n1.234;2.345\n", b';', true), b'.', "ambiguous stays '.'");
    }

    #[test]
    fn detects_encoding() {
        assert_eq!(detect_encoding(b"\xEF\xBB\xBFa,b"), Enc::Utf8Bom);
        assert_eq!(detect_encoding(b"\xFF\xFEa\0,\0"), Enc::Utf16Le);
        assert_eq!(detect_encoding("año,ñ".as_bytes()), Enc::Utf8);
        assert_eq!(detect_encoding(b"a\xf1o,b"), Enc::Windows1252);
        assert_eq!(detect_encoding(b"a\0,\0b\0\n\0c\0,\0d\0"), Enc::Utf16Le);
        // Cut multi-byte sequence at the end of the sample.
        assert_eq!(detect_encoding(&"añ".as_bytes()[..2]), Enc::Utf8);
    }
}
