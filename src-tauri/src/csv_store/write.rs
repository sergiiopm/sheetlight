//! Export: CSV writing (delimiter, encoding incl. BOM, decimal separator) and
//! the canonical cell/format walk used to promote the store to a workbook.

use std::io::Write;

use super::data::Data;
use super::parse::Enc;
use super::value::{self, Fmt, Val};
use super::Resolved;
use crate::engine::types::{CellRange, CsvOptions, EngineError, EngineErrorCode, EngineResult};

/// Visits every non-empty cell in row-major order with its canonical input.
pub fn export_cells(data: &Data, visit: &mut dyn FnMut(u32, u32, &str)) {
    let rows = data.row_bound();
    let mut buf = String::new();
    for row in 0..rows {
        for (c, col) in data.cols.iter().enumerate() {
            let val = col.get(row);
            if val.is_empty() {
                continue;
            }
            buf.clear();
            data.write_input(val, &mut buf);
            visit(row, c as u32, &buf);
        }
    }
}

/// Visits maximal vertical runs of cells with a non-General number format
/// (dates, percentages), column by column.
pub fn export_number_formats(data: &Data, visit: &mut dyn FnMut(CellRange, &str)) {
    for (c, col) in data.cols.iter().enumerate() {
        let c = c as u32;
        let mut run: Option<(u32, u32, Fmt)> = None;
        let extent = col.extent();
        for row in 0..=extent {
            let fmt = if row < extent {
                match col.get(row) {
                    Val::Num(_, f) if f != Fmt::General => Some(f),
                    _ => None,
                }
            } else {
                None
            };
            let same = matches!((run, fmt), (Some((_, _, rf)), Some(f)) if rf.code() == f.code());
            if same {
                if let Some(r) = run.as_mut() {
                    r.1 = row;
                }
                continue;
            }
            if let Some((r0, r1, f)) = run.take() {
                visit(CellRange { r0, c0: c, r1, c1: c }, f.code());
            }
            if let Some(f) = fmt {
                run = Some((row, row, f));
            }
        }
    }
}

/// Fully resolved CSV output settings.
#[derive(Debug, Clone, Copy)]
pub struct CsvTarget {
    pub enc: Enc,
    pub delim: u8,
    pub decimal: char,
}

impl CsvTarget {
    /// Explicit options win; missing ones fall back to what was detected on open.
    pub fn resolve(options: &CsvOptions, detected: Resolved) -> EngineResult<Self> {
        let enc = match options.encoding.as_deref() {
            Some(name) => Enc::from_name(name).ok_or_else(|| EngineError::new(EngineErrorCode::InvalidOp, format!("Codificación no admitida: {name}.")))?,
            None => detected.enc,
        };
        let delim = match options.delimiter.as_deref() {
            Some(",") => b',',
            Some(";") => b';',
            Some("\t") | Some("\\t") | Some("tab") => b'\t',
            Some("|") => b'|',
            Some(other) => return Err(EngineError::new(EngineErrorCode::InvalidOp, format!("Separador no admitido: {other}."))),
            None => detected.delim,
        };
        let decimal = match options.decimal.as_deref() {
            Some(".") => '.',
            Some(",") => ',',
            Some(other) => return Err(EngineError::new(EngineErrorCode::InvalidOp, format!("Separador decimal no admitido: {other}."))),
            None => char::from(detected.decimal),
        };
        if decimal == char::from(delim) {
            return Err(EngineError::new(EngineErrorCode::InvalidOp, "El separador decimal no puede ser igual al separador de campos."));
        }
        Ok(Self { enc, delim, decimal })
    }

    /// Default target for workbooks saved as CSV (Spanish Excel: `;` + `,`).
    #[allow(dead_code)] // For the workbook backend's `write_csv` (WS2).
    pub fn for_workbook(options: &CsvOptions) -> EngineResult<Self> {
        Self::resolve(options, Resolved { enc: Enc::Utf8Bom, delim: b';', decimal: b',' })
    }
}

/// Encodes UTF-8 text into the target encoding as it is written.
pub struct EncodedWriter<'a> {
    out: std::io::BufWriter<&'a mut dyn Write>,
    enc: Enc,
    scratch: Vec<u8>,
}

impl<'a> EncodedWriter<'a> {
    pub fn new(out: &'a mut dyn Write, enc: Enc) -> std::io::Result<Self> {
        let mut out = std::io::BufWriter::with_capacity(1 << 16, out);
        match enc {
            Enc::Utf8Bom => out.write_all(&[0xEF, 0xBB, 0xBF])?,
            Enc::Utf16Le => out.write_all(&[0xFF, 0xFE])?,
            Enc::Utf16Be => out.write_all(&[0xFE, 0xFF])?,
            Enc::Utf8 | Enc::Windows1252 => {}
        }
        Ok(Self { out, enc, scratch: Vec::new() })
    }

    pub fn write_str(&mut self, text: &str) -> std::io::Result<()> {
        match self.enc {
            Enc::Utf8 | Enc::Utf8Bom => self.out.write_all(text.as_bytes()),
            Enc::Utf16Le => {
                self.scratch.clear();
                for unit in text.encode_utf16() {
                    self.scratch.extend_from_slice(&unit.to_le_bytes());
                }
                self.out.write_all(&self.scratch)
            }
            Enc::Utf16Be => {
                self.scratch.clear();
                for unit in text.encode_utf16() {
                    self.scratch.extend_from_slice(&unit.to_be_bytes());
                }
                self.out.write_all(&self.scratch)
            }
            Enc::Windows1252 => {
                if text.is_ascii() {
                    return self.out.write_all(text.as_bytes());
                }
                self.scratch.clear();
                let mut buf = [0u8; 4];
                for ch in text.chars() {
                    let s = ch.encode_utf8(&mut buf);
                    let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(s);
                    if unmappable {
                        self.scratch.push(b'?');
                    } else {
                        self.scratch.extend_from_slice(&bytes);
                    }
                }
                self.out.write_all(&self.scratch)
            }
        }
    }

    pub fn finish(mut self) -> std::io::Result<()> {
        self.out.flush()
    }
}

fn io(e: std::io::Error) -> EngineError {
    EngineError::io(format!("No se pudo escribir el CSV: {e}"))
}

/// Appends `field` to `line`, quoting when needed (RFC 4180).
pub fn push_field(line: &mut String, field: &str, delim: char) {
    let needs = field.contains([delim, '"', '\n', '\r']) || field.starts_with(' ') || field.ends_with(' ');
    if needs {
        line.push('"');
        for ch in field.chars() {
            if ch == '"' {
                line.push('"');
            }
            line.push(ch);
        }
        line.push('"');
    } else {
        line.push_str(field);
    }
}

/// CSV text of a value: numbers in full precision with the target decimal
/// separator, dates in their source style, booleans TRUE/FALSE, raw text.
fn write_value(data: &Data, val: Val, decimal: char, out: &mut String) {
    match val {
        Val::Empty => {}
        Val::Num(v, fmt) => match fmt {
            Fmt::General => {
                let start = out.len();
                value::write_canonical_number(v, out);
                if decimal != '.' {
                    if let Some(p) = out[start..].find('.') {
                        out.replace_range(start + p..start + p + 1, ",");
                    }
                }
            }
            Fmt::Percent0 | Fmt::Percent2 => {
                let start = out.len();
                value::write_canonical_number(v * 100.0, out);
                if let Some(p) = out[start..].find('.') {
                    // Trim float noise (12.300000000000001 -> 12.3).
                    let digits = out.len() - (start + p + 1);
                    if digits > 10 {
                        let rounded = (v * 100.0 * 1e10).round() / 1e10;
                        out.truncate(start);
                        value::write_canonical_number(rounded, out);
                    }
                }
                if decimal != '.' {
                    if let Some(p) = out[start..].find('.') {
                        out.replace_range(start + p..start + p + 1, ",");
                    }
                }
                out.push('%');
            }
            _ => value::write_date_source(v, fmt, out),
        },
        Val::Bool(b) => out.push_str(if b { "TRUE" } else { "FALSE" }),
        Val::Text(id) => out.push_str(data.strings.get(id)),
    }
}

/// Writes the store as CSV. Rows are padded to the used width (like Excel);
/// line breaks are CRLF.
pub fn write_csv(data: &Data, out: &mut dyn Write, target: CsvTarget) -> EngineResult<()> {
    let mut writer = EncodedWriter::new(out, target.enc).map_err(io)?;
    let delim = char::from(target.delim);
    if let Some(used) = data.used_range() {
        let mut line = String::new();
        let mut field = String::new();
        for row in 0..=used.r1 {
            line.clear();
            for col in 0..=used.c1 {
                if col > 0 {
                    line.push(delim);
                }
                field.clear();
                write_value(data, data.get(row, col), target.decimal, &mut field);
                push_field(&mut line, &field, delim);
            }
            line.push_str("\r\n");
            writer.write_str(&line).map_err(io)?;
        }
    }
    writer.finish().map_err(io)
}
