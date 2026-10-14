//! Background loading: streams the file in chunks, decodes it to UTF-8,
//! parses records outside the lock and publishes them in batches.

use std::io::Read;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::column::{hash_str, Column};
use super::data::Data;
use super::parse::{field_text, parse_record, Enc, FieldSpan};
use super::value::{type_field, Typed, Val};
use super::Shared;
use crate::engine::backend::EventSink;
use crate::engine::types::{CellRange, DocumentId, EngineEvent, MAX_COLS, MAX_ROWS};

const READ_SIZE: usize = 1 << 20;
const FIRST_CHUNK_ROWS: u32 = 1_000;
const CHUNK_ROWS: u32 = 32_768;
const TICK: Duration = Duration::from_millis(100);
/// Columns keep deduplicating strings while at most this share of their
/// values is new (checked after `DEDUPE_PROBE` values).
const DEDUPE_PROBE: u32 = 20_000;

pub struct LoadParams {
    pub doc: DocumentId,
    pub enc: Enc,
    pub delim: u8,
    pub decimal: u8,
    pub bytes_total: u64,
    pub events: EventSink,
}

/// Rows parsed but not yet published.
struct Chunk {
    first_row: u32,
    rows: u32,
    /// Per column; `Val::Text(i)` indexes `texts`.
    cols: Vec<Vec<Val>>,
    texts: Vec<(u32, u32, u64)>,
    arena: String,
}

impl Chunk {
    fn new(first_row: u32) -> Self {
        Self { first_row, rows: 0, cols: Vec::new(), texts: Vec::new(), arena: String::new() }
    }

    fn reset(&mut self, first_row: u32) {
        self.first_row = first_row;
        self.rows = 0;
        for c in &mut self.cols {
            c.clear();
        }
        self.texts.clear();
        self.arena.clear();
    }

    fn push_record(&mut self, buf: &[u8], fields: &[FieldSpan], decimal: u8, scratch: &mut String) {
        let local_row = self.rows as usize;
        let n = fields.len().min(MAX_COLS as usize);
        // A blank line is one empty field: keeps an empty row.
        while self.cols.len() < n {
            self.cols.push(Vec::new());
        }
        for (c, span) in fields.iter().take(n).enumerate() {
            let text = field_text(buf, *span, scratch);
            let val = match type_field(text, decimal) {
                Typed::Empty => continue,
                Typed::Num(v, f) => Val::Num(v, f),
                Typed::Bool(b) => Val::Bool(b),
                Typed::Text => {
                    let start = self.arena.len() as u32;
                    self.arena.push_str(text);
                    self.texts.push((start, self.arena.len() as u32, hash_str(text)));
                    Val::Text(self.texts.len() as u32 - 1)
                }
            };
            let col = &mut self.cols[c];
            if col.len() < local_row {
                col.resize(local_row, Val::Empty);
            }
            col.push(val);
        }
        self.rows += 1;
    }

    /// Moves the chunk into the shared data (caller holds the write lock).
    fn publish(&self, data: &mut Data) {
        for (c, vals) in self.cols.iter().enumerate() {
            if vals.is_empty() {
                continue;
            }
            if c >= data.cols.len() {
                // New column: choose its representation from this sample,
                // ignoring the header row of the file.
                let skip = usize::from(self.first_row == 0);
                while data.cols.len() < c {
                    data.cols.push(Column::default());
                }
                data.cols.push(Column::for_sample(vals.get(skip..).unwrap_or(&[])));
            }
            let Data { cols, strings, .. } = data;
            let col = &mut cols[c];
            for (i, val) in vals.iter().enumerate() {
                let row = self.first_row + i as u32;
                let val = match *val {
                    Val::Empty => continue,
                    Val::Text(local) => {
                        let (start, end, hash) = self.texts[local as usize];
                        let text = &self.arena[start as usize..end as usize];
                        let (id, new) = strings.intern_hashed(text, hash, col.dedupe);
                        if col.dedupe {
                            col.text_seen += 1;
                            col.text_new += u32::from(new);
                            if col.text_seen >= DEDUPE_PROBE && col.text_new * 2 > col.text_seen {
                                col.dedupe = false;
                            }
                        }
                        Val::Text(id)
                    }
                    other => other,
                };
                col.push_at(row, val);
            }
        }
        data.rows = data.rows.max(self.first_row + self.rows);
    }
}

/// Incremental decoder from the file encoding to UTF-8.
struct Decoder {
    inner: encoding_rs::Decoder,
}

impl Decoder {
    fn new(enc: Enc) -> Self {
        Self { inner: enc.encoding().new_decoder_with_bom_removal() }
    }

    fn decode(&mut self, src: &[u8], dst: &mut String, last: bool) {
        let mut src = src;
        loop {
            let needed = self.inner.max_utf8_buffer_length(src.len()).unwrap_or(src.len() * 3 + 16);
            dst.reserve(needed);
            let (result, read, _) = self.inner.decode_to_string(src, dst, last);
            src = &src[read..];
            if result == encoding_rs::CoderResult::InputEmpty {
                break;
            }
        }
    }
}

/// Publishes rows of `text` that are complete; returns bytes consumed.
#[allow(clippy::too_many_arguments)]
fn parse_available(
    text: &str,
    eof: bool,
    params: &LoadParams,
    chunk: &mut Chunk,
    fields: &mut Vec<FieldSpan>,
    scratch: &mut String,
    next_row: &mut u32,
    limit: u32,
) -> usize {
    let buf = text.as_bytes();
    let mut pos = 0;
    while pos < buf.len() && chunk.rows < limit && *next_row < MAX_ROWS {
        match parse_record(buf, pos, params.delim, eof, fields) {
            Some(next) => {
                chunk.push_record(buf, fields, params.decimal, scratch);
                *next_row += 1;
                pos = next;
            }
            None => break,
        }
    }
    pos
}

/// Loads the whole file. Runs on its own thread; errors are reported through
/// the final `LoadProgress` event.
pub fn run(shared: Arc<Shared>, mut reader: Box<dyn Read + Send>, params: LoadParams) {
    let started = Instant::now();
    let result = load(&shared, &mut *reader, &params);
    {
        let mut data = shared.data.write().unwrap_or_else(|e| e.into_inner());
        data.loading = false;
        data.est_rows = data.rows;
        for col in &mut data.cols {
            col.shrink();
        }
        data.info_version += 1;
    }
    let (rows, version) = {
        let data = shared.data.read().unwrap_or_else(|e| e.into_inner());
        (data.rows, data.info_version)
    };
    {
        let mut done = shared.done.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        shared.done_cv.notify_all();
    }
    if shared.cancel.load(Ordering::Relaxed) {
        return;
    }
    let (bytes_read, error) = match result {
        Ok(state) => (state.bytes_read, state.warning),
        Err(message) => (0, Some(message)),
    };
    let doc = params.doc;
    let emit = &params.events;
    if let Some(range) = shared.pending_cells(rows) {
        emit(EngineEvent::Cells { doc, sheet: super::SHEET_ID, ranges: vec![range] });
    }
    emit(EngineEvent::LoadProgress { doc, rows_loaded: u64::from(rows), bytes_read: bytes_read.max(params.bytes_total), bytes_total: params.bytes_total, done: true, error });
    emit(EngineEvent::SheetInfo { doc, sheet: super::SHEET_ID, version });
    let _ = started;
}

struct LoadState {
    bytes_read: u64,
    warning: Option<String>,
}

fn load(shared: &Shared, file: &mut dyn Read, params: &LoadParams) -> Result<LoadState, String> {
    let mut decoder = Decoder::new(params.enc);
    let mut raw = vec![0u8; READ_SIZE];
    let mut text = String::new();
    let mut chunk = Chunk::new(0);
    let mut fields = Vec::new();
    let mut scratch = String::new();
    let mut next_row = 0u32;
    let mut bytes_read = 0u64;
    let mut last_tick = Instant::now();
    let mut limit = FIRST_CHUNK_ROWS;
    let mut eof = false;
    let mut truncated = false;
    loop {
        if shared.cancel.load(Ordering::Relaxed) {
            return Ok(LoadState { bytes_read, warning: None });
        }
        if !eof {
            let n = file.read(&mut raw).map_err(|e| format!("No se pudo leer el archivo: {e}"))?;
            bytes_read += n as u64;
            eof = n == 0;
            decoder.decode(&raw[..n], &mut text, eof);
        }
        loop {
            let consumed = parse_available(&text, eof, params, &mut chunk, &mut fields, &mut scratch, &mut next_row, limit);
            text.drain(..consumed);
            if next_row >= MAX_ROWS && !text.trim_matches(['\r', '\n']).is_empty() {
                truncated = true;
            }
            let full = chunk.rows >= limit;
            let ticked = last_tick.elapsed() >= TICK;
            if chunk.rows > 0 && (full || ticked || eof || truncated) {
                publish(shared, &chunk, bytes_read, params);
                chunk.reset(next_row);
                limit = CHUNK_ROWS;
            }
            if ticked {
                last_tick = Instant::now();
                shared.tick(params, bytes_read);
            }
            if !full || truncated {
                break;
            }
        }
        if eof || truncated {
            break;
        }
    }
    let warning = truncated.then(|| {
        "El archivo tiene más de 1.048.576 filas; solo se han cargado las primeras 1.048.576.".to_string()
    });
    Ok(LoadState { bytes_read, warning })
}

fn publish(shared: &Shared, chunk: &Chunk, bytes_read: u64, params: &LoadParams) {
    let mut data = shared.data.write().unwrap_or_else(|e| e.into_inner());
    chunk.publish(&mut data);
    // Estimate the total rows from the average record size so far.
    if bytes_read > 0 && data.rows > 0 {
        let per_row = bytes_read as f64 / f64::from(data.rows);
        let est = (params.bytes_total as f64 / per_row).ceil() as u64;
        data.est_rows = est.clamp(u64::from(data.rows), u64::from(MAX_ROWS)) as u32;
    }
}

impl Shared {
    /// Throttled progress: `Cells` for newly loaded rows, `LoadProgress` and
    /// `SheetInfo` (the used range grows while loading).
    fn tick(&self, params: &LoadParams, bytes_read: u64) {
        let (rows, version) = {
            let mut data = self.data.write().unwrap_or_else(|e| e.into_inner());
            data.info_version += 1;
            (data.rows, data.info_version)
        };
        let emit = &params.events;
        if let Some(range) = self.pending_cells(rows) {
            emit(EngineEvent::Cells { doc: params.doc, sheet: super::SHEET_ID, ranges: vec![range] });
        }
        emit(EngineEvent::LoadProgress {
            doc: params.doc,
            rows_loaded: u64::from(rows),
            bytes_read,
            bytes_total: params.bytes_total,
            done: false,
            error: None,
        });
        emit(EngineEvent::SheetInfo { doc: params.doc, sheet: super::SHEET_ID, version });
    }

    /// Range of rows published since the last notification.
    fn pending_cells(&self, rows: u32) -> Option<CellRange> {
        let ncols = self.data.read().map(|d| d.ncols()).unwrap_or(0);
        let from = self.notified_rows.swap(rows, Ordering::Relaxed);
        (rows > from && ncols > 0).then(|| CellRange { r0: from, c0: 0, r1: rows - 1, c1: ncols - 1 })
    }
}
