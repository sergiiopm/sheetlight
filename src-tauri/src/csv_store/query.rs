//! Read-only queries over the store: blocks, Ctrl+Arrow edges, autofit
//! samples, cell details, range values, status-bar stats, find, filter values.

use std::collections::HashMap;

use super::column::ColData;
use super::data::Data;
use super::value::{Fmt, Val};
use super::SHEET_ID;
use crate::engine::blocks::BlockCells;
use crate::engine::types::*;

fn kind_of(val: Val) -> CellKind {
    match val {
        Val::Empty => CellKind::Empty,
        Val::Num(..) => CellKind::Number,
        Val::Bool(_) => CellKind::Bool,
        Val::Text(_) => CellKind::Text,
    }
}

/// Fills one 64x16 block. One scratch buffer per call, no per-cell allocation.
pub fn write_block(data: &Data, key: BlockKey, cells: &mut BlockCells) {
    let row0 = key.br * BLOCK_ROWS;
    let col0 = key.bc * BLOCK_COLS;
    let ncols = data.ncols();
    if col0 >= ncols {
        return;
    }
    let pending_to = if data.loading { data.est_rows.max(data.rows) } else { 0 };
    let mut buf = String::with_capacity(64);
    for r in 0..BLOCK_ROWS {
        let row = row0 + r;
        if row >= data.rows {
            if row < pending_to {
                for c in 0..BLOCK_COLS.min(ncols - col0) {
                    cells.set((r * BLOCK_COLS + c) as usize, "", CellKind::Pending, 0, 0);
                }
                continue;
            }
            // Edited cells can live past the loaded rows only after loading.
            if data.loading {
                break;
            }
        }
        for c in 0..BLOCK_COLS.min(ncols - col0) {
            let val = data.cols[(col0 + c) as usize].get(row);
            let index = (r * BLOCK_COLS + c) as usize;
            match val {
                Val::Empty => {}
                Val::Text(id) => cells.set(index, data.strings.get(id), CellKind::Text, 0, 0),
                other => {
                    buf.clear();
                    data.write_display(other, &mut buf);
                    cells.set(index, &buf, kind_of(other), 0, 0);
                }
            }
        }
    }
}

/// Excel Ctrl+Arrow: from a filled cell with a filled neighbour, go to the
/// last filled cell of the run; otherwise jump to the next filled cell, or
/// to the sheet edge when there is none.
pub fn find_data_edge(data: &Data, from: CellAddress, dir: Direction) -> CellAddress {
    let filled = |row: u32, col: u32| !data.get(row, col).is_empty();
    match dir {
        Direction::Down | Direction::Up => {
            let col = from.col;
            let bound = data.cols.get(col as usize).map_or(0, |c| c.extent());
            let down = dir == Direction::Down;
            let edge = if down { MAX_ROWS - 1 } else { 0 };
            if from.row == edge {
                return from;
            }
            let step = |r: u32| if down { r + 1 } else { r - 1 };
            let mut r = from.row;
            if filled(r, col) && filled(step(r), col) {
                while r != edge && filled(step(r), col) {
                    r = step(r);
                }
                return CellAddress { row: r, col };
            }
            // Next filled cell in the direction.
            loop {
                if r == edge || (down && r + 1 >= bound) {
                    return CellAddress { row: edge, col };
                }
                r = step(r);
                if filled(r, col) {
                    return CellAddress { row: r, col };
                }
            }
        }
        Direction::Right | Direction::Left => {
            let row = from.row;
            let bound = data.ncols();
            let right = dir == Direction::Right;
            let edge = if right { MAX_COLS - 1 } else { 0 };
            if from.col == edge {
                return from;
            }
            let step = |c: u32| if right { c + 1 } else { c - 1 };
            let mut c = from.col;
            if filled(row, c) && filled(row, step(c)) {
                while c != edge && filled(row, step(c)) {
                    c = step(c);
                }
                return CellAddress { row, col: c };
            }
            loop {
                if c == edge || (right && c + 1 >= bound) {
                    return CellAddress { row, col: edge };
                }
                c = step(c);
                if filled(row, c) {
                    return CellAddress { row, col: c };
                }
            }
        }
    }
}

/// Longest display strings of a column (by characters), for autofit. Large
/// columns are sampled: the first 2,000 rows plus ~10,000 evenly spaced.
pub fn column_text_samples(data: &Data, col: u32, limit: u32) -> Vec<TextSample> {
    let Some(column) = data.cols.get(col as usize) else { return Vec::new() };
    let limit = limit.max(1) as usize;
    let rows = column.extent();
    let mut best: Vec<(usize, String)> = Vec::new();
    let mut buf = String::new();
    let stride = if rows > 12_000 { (rows - 2_000) / 10_000 } else { 1 }.max(1);
    let mut row = 0u32;
    while row < rows {
        let val = column.get(row);
        if !val.is_empty() {
            buf.clear();
            data.write_display(val, &mut buf);
            let len = buf.chars().count();
            if (best.len() < limit || len > best.last().map_or(0, |b| b.0)) && !best.iter().any(|(_, t)| *t == buf) {
                let pos = best.partition_point(|(l, _)| *l >= len);
                best.insert(pos, (len, buf.clone()));
                best.truncate(limit);
            }
        }
        row += if row < 2_000 { 1 } else { stride };
    }
    best.into_iter().map(|(_, text)| TextSample { text, style_id: 0 }).collect()
}

pub fn cell_value(data: &Data, val: Val) -> CellValue {
    match val {
        Val::Empty => CellValue::Empty,
        Val::Num(v, _) => CellValue::Number { value: v },
        Val::Bool(b) => CellValue::Bool { value: b },
        Val::Text(id) => CellValue::Text { value: data.strings.get(id).to_string() },
    }
}

fn num_fmt(val: Val) -> &'static str {
    match val {
        Val::Num(_, fmt) => fmt.code(),
        _ => Fmt::General.code(),
    }
}

pub fn cell_details(data: &Data, cell: CellAddress) -> CellDetails {
    let val = data.get(cell.row, cell.col);
    let mut input = String::new();
    data.write_input(val, &mut input);
    let mut display = String::new();
    data.write_display(val, &mut display);
    CellDetails {
        sheet: SHEET_ID,
        row: cell.row,
        col: cell.col,
        input,
        value: cell_value(data, val),
        display,
        format: CellFormat { style: CellStyle::default(), num_fmt: num_fmt(val).to_string() },
        merge: None,
        spill_anchor: None,
        comment: None,
        hyperlink: None,
    }
}

/// Clamps a range to the cells that can hold data.
fn clamp(data: &Data, range: CellRange) -> Option<CellRange> {
    let rows = data.row_bound();
    let cols = data.ncols();
    if rows == 0 || cols == 0 || range.r0 >= rows || range.c0 >= cols {
        return None;
    }
    Some(CellRange { r0: range.r0, c0: range.c0, r1: range.r1.min(rows - 1), c1: range.c1.min(cols - 1) })
}

pub fn range_values(data: &Data, range: CellRange) -> RangeValues {
    // Charts ask for exact ranges; cap the materialized size anyway.
    let r1 = range.r1.min(range.r0.saturating_add(100_000));
    let c1 = range.c1.min(range.c0.saturating_add(1_000));
    let mut values = Vec::new();
    let mut display = Vec::new();
    let mut buf = String::new();
    for row in range.r0..=r1 {
        let mut vrow = Vec::with_capacity((c1 - range.c0 + 1) as usize);
        let mut drow = Vec::with_capacity(vrow.capacity());
        for col in range.c0..=c1 {
            let val = data.get(row, col);
            buf.clear();
            data.write_display(val, &mut buf);
            vrow.push(cell_value(data, val));
            drow.push(buf.clone());
        }
        values.push(vrow);
        display.push(drow);
    }
    RangeValues { range: CellRange { r0: range.r0, c0: range.c0, r1, c1 }, values, display }
}

/// Status-bar stats. Rows hidden by the autofilter are skipped (Excel).
pub fn selection_stats(data: &Data, ranges: &[CellRange]) -> SelectionStats {
    let mut s = SelectionStats::default();
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let filtered = !data.view.filter_hidden.is_empty();
    for range in ranges {
        let Some(r) = clamp(data, *range) else { continue };
        for col in r.c0..=r.c1 {
            let column = &data.cols[col as usize];
            // Fast path: dense numeric column without exceptions or filters.
            if let (ColData::Num { vals, .. }, 0, false) = (&column.data, column.exception_count(), filtered) {
                let end = ((r.r1 + 1) as usize).min(vals.len());
                if (r.r0 as usize) < end {
                    for v in &vals[r.r0 as usize..end] {
                        if v.is_nan() {
                            continue;
                        }
                        s.count += 1;
                        s.numeric_count += 1;
                        s.sum += v;
                        min = min.min(*v);
                        max = max.max(*v);
                    }
                }
                continue;
            }
            let end = r.r1.min(column.extent().saturating_sub(1));
            if column.extent() == 0 {
                continue;
            }
            for row in r.r0..=end {
                if filtered && data.view.filter_hidden.get(row) {
                    continue;
                }
                match column.get(row) {
                    Val::Empty => {}
                    Val::Num(v, _) => {
                        s.count += 1;
                        s.numeric_count += 1;
                        s.sum += v;
                        min = min.min(v);
                        max = max.max(v);
                    }
                    _ => s.count += 1,
                }
            }
        }
    }
    if s.numeric_count > 0 {
        s.average = Some(s.sum / s.numeric_count as f64);
        s.min = Some(min);
        s.max = Some(max);
    }
    s
}

/// Lowercases `text` char by char into `out` (no allocation when reused).
fn fold_into(text: &str, out: &mut String) {
    out.clear();
    for ch in text.chars() {
        out.extend(ch.to_lowercase());
    }
}

struct Matcher {
    needle: String,
    match_case: bool,
    whole: bool,
    could_be_number: bool,
    scratch: String,
}

impl Matcher {
    fn new(query: &FindQuery) -> Self {
        let mut needle = String::new();
        if query.match_case {
            needle.push_str(&query.text);
        } else {
            fold_into(&query.text, &mut needle);
        }
        let could_be_number = query.text.chars().all(|c| c.is_ascii_digit() || " .,-+eE%/:".contains(c));
        Self { needle, match_case: query.match_case, whole: query.whole_cell, could_be_number, scratch: String::new() }
    }

    fn matches(&mut self, hay: &str) -> bool {
        let hay = if self.match_case {
            hay
        } else {
            fold_into(hay, &mut self.scratch);
            self.scratch.as_str()
        };
        if self.whole {
            hay == self.needle
        } else {
            hay.contains(self.needle.as_str())
        }
    }
}

pub fn find(data: &Data, query: &FindQuery) -> Vec<FindMatch> {
    let mut out = Vec::new();
    if query.text.is_empty() || query.limit == 0 {
        return out;
    }
    let mut matcher = Matcher::new(query);
    let rows = data.row_bound();
    let cols = data.ncols();
    if rows == 0 || cols == 0 {
        return out;
    }
    let ranges: Vec<CellRange> = match &query.within {
        Some(list) if !list.is_empty() => list.iter().filter_map(|r| clamp(data, *r)).collect(),
        _ => vec![CellRange { r0: 0, c0: 0, r1: rows - 1, c1: cols - 1 }],
    };
    // Text ids are often shared (dictionary): cache their verdicts.
    let mut cache: HashMap<u32, bool> = HashMap::new();
    let mut buf = String::new();
    let by_cols = query.by_columns.unwrap_or(false);
    let look_formulas = query.look_in == LookIn::Formulas;
    let mut check = |row: u32, col: u32, out: &mut Vec<FindMatch>| -> bool {
        let val = data.get(row, col);
        let hit = match val {
            Val::Empty => false,
            Val::Text(id) => *cache.entry(id).or_insert_with(|| matcher.matches(data.strings.get(id))),
            Val::Num(..) if !matcher.could_be_number => false,
            other => {
                buf.clear();
                if look_formulas {
                    data.write_input(other, &mut buf);
                } else {
                    data.write_display(other, &mut buf);
                }
                matcher.matches(&buf)
            }
        };
        if hit {
            buf.clear();
            data.write_display(val, &mut buf);
            out.push(FindMatch { sheet: SHEET_ID, row, col, display: buf.clone() });
        }
        out.len() >= query.limit as usize
    };
    for r in ranges {
        if by_cols {
            for col in r.c0..=r.c1 {
                for row in r.r0..=r.r1 {
                    if check(row, col, &mut out) {
                        return out;
                    }
                }
            }
        } else {
            for row in r.r0..=r.r1 {
                for col in r.c0..=r.c1 {
                    if check(row, col, &mut out) {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// Sort class of a value for filter lists: numbers, text, booleans, blanks.
fn class_of(val: Val) -> u8 {
    match val {
        Val::Num(..) => 0,
        Val::Text(_) => 1,
        Val::Bool(_) => 2,
        Val::Empty => 3,
    }
}

/// Distinct display values of `col` inside the autofilter range (or the
/// whole column below the header), considering the other columns' filters.
pub fn filter_values(data: &Data, col: u32, limit: u32) -> Vec<FilterValue> {
    let bound = data.row_bound();
    let (r0, r1) = match data.view.auto_filter {
        Some(r) => (r.r0 + 1, r.r1.min(bound.saturating_sub(1))),
        None => (1, bound.saturating_sub(1)),
    };
    let column = data.cols.get(col as usize);
    let mut counts: HashMap<(u8, u64), (Val, u64)> = HashMap::new();
    let mut buf = String::new();
    if r0 <= r1 {
        for row in r0..=r1 {
            if !data.row_passes_filters(row, Some(col), &mut buf) {
                continue;
            }
            let val = column.map_or(Val::Empty, |c| c.get(row));
            let key = match val {
                Val::Empty => (3, 0),
                Val::Num(v, fmt) => (0, v.to_bits() ^ ((fmt as u64) << 56)),
                Val::Bool(b) => (2, u64::from(b)),
                Val::Text(id) => (1, u64::from(id)),
            };
            counts.entry(key).or_insert((val, 0)).1 += 1;
        }
    }
    // Merge by display string (duplicate text ids, equal formatted numbers).
    let mut by_display: HashMap<String, (Val, u64)> = HashMap::new();
    for (_, (val, n)) in counts {
        buf.clear();
        data.write_display(val, &mut buf);
        by_display.entry(buf.clone()).or_insert((val, 0)).1 += n;
    }
    let mut list: Vec<(String, Val, u64)> = by_display.into_iter().map(|(d, (v, n))| (d, v, n)).collect();
    list.sort_by(|a, b| {
        let ca = class_of(a.1);
        let cb = class_of(b.1);
        ca.cmp(&cb).then_with(|| match (a.1, b.1) {
            (Val::Num(x, _), Val::Num(y, _)) => x.total_cmp(&y),
            _ => super::ops::collate(&a.0, &b.0),
        })
    });
    list.truncate(limit as usize);
    let criteria = data.view.filters.get(&col);
    list.into_iter()
        .map(|(value, _, count)| {
            let selected = criteria.is_none_or(|vals| vals.contains(&value));
            FilterValue { value, count, selected }
        })
        .collect()
}
