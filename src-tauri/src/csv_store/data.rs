//! The in-memory sheet of the CSV store: columns, strings and view state
//! (sizes, hidden rows/cols, frozen panes, autofilter). Shared between the
//! backend (actor thread) and the background loader behind an `RwLock`.

use std::collections::{BTreeMap, BTreeSet};

use super::column::{Column, Strings};
use super::value::{self, Val};
use crate::engine::types::{CellRange, MAX_COLS, MAX_ROWS};


/// Growable bit set for row flags (hidden rows, filtered rows).
#[derive(Clone, Default, Debug)]
pub struct BitSet {
    words: Vec<u64>,
    count: usize,
}

impl BitSet {
    pub fn get(&self, i: u32) -> bool {
        let w = (i / 64) as usize;
        w < self.words.len() && self.words[w] & (1 << (i % 64)) != 0
    }

    pub fn set(&mut self, i: u32, on: bool) {
        let w = (i / 64) as usize;
        if w >= self.words.len() {
            if !on {
                return;
            }
            self.words.resize(w + 1, 0);
        }
        let mask = 1u64 << (i % 64);
        let was = self.words[w] & mask != 0;
        if on && !was {
            self.words[w] |= mask;
            self.count += 1;
        } else if !on && was {
            self.words[w] &= !mask;
            self.count -= 1;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn clear(&mut self) {
        self.words.clear();
        self.count = 0;
    }

    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.words.iter().enumerate().flat_map(|(w, word)| {
            let mut bits = *word;
            std::iter::from_fn(move || {
                if bits == 0 {
                    return None;
                }
                let t = bits.trailing_zeros();
                bits &= bits - 1;
                Some(w as u32 * 64 + t)
            })
        })
    }

    /// Shifts set bits at or after `index` by `count` (insert rows).
    pub fn insert_gap(&mut self, index: u32, count: u32) {
        if self.is_empty() {
            return;
        }
        let ones: Vec<u32> = self.iter().collect();
        self.clear();
        for i in ones {
            let j = if i >= index { i.saturating_add(count) } else { i };
            if j < MAX_ROWS.max(MAX_COLS) {
                self.set(j, true);
            }
        }
    }

    /// Removes `index..index+count` and shifts the rest up.
    pub fn remove_range(&mut self, index: u32, count: u32) {
        if self.is_empty() {
            return;
        }
        let ones: Vec<u32> = self.iter().collect();
        self.clear();
        for i in ones {
            if i < index {
                self.set(i, true);
            } else if i >= index + count {
                self.set(i - count, true);
            }
        }
    }
}

fn shift_map<V: Clone>(map: &BTreeMap<u32, V>, index: u32, count: u32, insert: bool) -> BTreeMap<u32, V> {
    map.iter()
        .filter_map(|(k, v)| {
            if *k < index {
                Some((*k, v.clone()))
            } else if insert {
                Some((k + count, v.clone()))
            } else if *k >= index + count {
                Some((k - count, v.clone()))
            } else {
                None
            }
        })
        .collect()
}

/// Moves the inclusive span `lo..=hi` for an insert/delete of `count` lines
/// at `index`. `None` when a delete removes the whole span.
fn shift_span(lo: u32, hi: u32, index: u32, count: u32, insert: bool) -> Option<(u32, u32)> {
    if insert {
        return Some(if index <= lo {
            (lo + count, hi + count)
        } else if index <= hi {
            (lo, hi + count)
        } else {
            (lo, hi)
        });
    }
    let end = index + count;
    if index > hi {
        return Some((lo, hi));
    }
    if end <= lo {
        return Some((lo - count, hi - count));
    }
    if index <= lo && end > hi {
        return None;
    }
    let before_lo = if index < lo { end.min(lo) - index } else { 0 };
    let up_to_hi = end.min(hi + 1) - index;
    Some((lo - before_lo, hi - up_to_hi))
}

/// View/geometry state; cloned as a whole for undo of view ops.
#[derive(Clone, Debug)]
pub struct View {
    pub row_heights: BTreeMap<u32, f64>,
    pub col_widths: BTreeMap<u32, f64>,
    pub hidden_rows: BitSet,
    pub hidden_cols: BTreeSet<u32>,
    pub frozen_rows: u32,
    pub frozen_cols: u32,
    pub show_grid_lines: bool,
    pub auto_filter: Option<CellRange>,
    /// Column -> display values kept visible.
    pub filters: BTreeMap<u32, Vec<String>>,
    /// Rows hidden by the autofilter.
    pub filter_hidden: BitSet,
}

impl Default for View {
    fn default() -> Self {
        Self {
            row_heights: BTreeMap::new(),
            col_widths: BTreeMap::new(),
            hidden_rows: BitSet::default(),
            hidden_cols: BTreeSet::new(),
            frozen_rows: 0,
            frozen_cols: 0,
            show_grid_lines: true,
            auto_filter: None,
            filters: BTreeMap::new(),
            filter_hidden: BitSet::default(),
        }
    }
}

impl View {
    pub fn shift_rows(&mut self, index: u32, count: u32, insert: bool) {
        self.row_heights = shift_map(&self.row_heights, index, count, insert);
        if insert {
            self.hidden_rows.insert_gap(index, count);
            self.filter_hidden.insert_gap(index, count);
        } else {
            self.hidden_rows.remove_range(index, count);
            self.filter_hidden.remove_range(index, count);
        }
        if let Some(r) = self.auto_filter {
            match shift_span(r.r0, r.r1, index, count, insert) {
                Some((r0, r1)) => self.auto_filter = Some(CellRange { r0, r1, ..r }),
                None => self.clear_filter(),
            }
        }
    }

    pub fn shift_cols(&mut self, index: u32, count: u32, insert: bool) {
        self.col_widths = shift_map(&self.col_widths, index, count, insert);
        let hidden: Vec<u32> = self.hidden_cols.iter().copied().collect();
        self.hidden_cols = hidden
            .into_iter()
            .filter_map(|c| {
                if c < index {
                    Some(c)
                } else if insert {
                    Some(c + count)
                } else if c >= index + count {
                    Some(c - count)
                } else {
                    None
                }
            })
            .collect();
        self.filters = shift_map(&self.filters, index, count, insert);
        if let Some(r) = self.auto_filter {
            match shift_span(r.c0, r.c1, index, count, insert) {
                Some((c0, c1)) => self.auto_filter = Some(CellRange { c0, c1, ..r }),
                None => self.clear_filter(),
            }
        }
    }

    fn clear_filter(&mut self) {
        self.auto_filter = None;
        self.filters.clear();
        self.filter_hidden.clear();
    }

}

pub struct Data {
    pub cols: Vec<Column>,
    pub strings: Strings,
    /// Rows published so far (exclusive bound of loaded data).
    pub rows: u32,
    /// Estimated total rows while loading (for `Pending` placeholders).
    pub est_rows: u32,
    pub loading: bool,
    pub view: View,
    pub info_version: u32,
}

impl Default for Data {
    fn default() -> Self {
        Self { cols: Vec::new(), strings: Strings::default(), rows: 0, est_rows: 0, loading: false, view: View::default(), info_version: 1 }
    }
}

impl Data {
    #[inline]
    pub fn get(&self, row: u32, col: u32) -> Val {
        match self.cols.get(col as usize) {
            Some(c) => c.get(row),
            None => Val::Empty,
        }
    }

    pub fn ncols(&self) -> u32 {
        self.cols.len() as u32
    }

    /// Ensures column `col` exists (new columns start as text columns).
    pub fn col_mut(&mut self, col: u32) -> &mut Column {
        while self.cols.len() <= col as usize {
            self.cols.push(Column::default());
        }
        &mut self.cols[col as usize]
    }

    pub fn set(&mut self, row: u32, col: u32, val: Val) {
        if val.is_empty() && (col as usize >= self.cols.len()) {
            return;
        }
        self.col_mut(col).set(row, val);
        if !val.is_empty() && row >= self.rows {
            self.rows = row + 1;
        }
    }

    /// Appends display text of `val` to `out`.
    pub fn write_display(&self, val: Val, out: &mut String) {
        match val {
            Val::Empty => {}
            Val::Num(v, fmt) => value::write_number_display(v, fmt, out),
            Val::Bool(b) => out.push_str(if b { value::TRUE_DISPLAY } else { value::FALSE_DISPLAY }),
            Val::Text(id) => out.push_str(self.strings.get(id)),
        }
    }

    /// Canonical en-US input of a value (what the formula bar edits).
    pub fn write_input(&self, val: Val, out: &mut String) {
        match val {
            Val::Empty => {}
            Val::Num(v, _) => value::write_canonical_number(v, out),
            Val::Bool(b) => out.push_str(if b { "TRUE" } else { "FALSE" }),
            Val::Text(id) => {
                let text = self.strings.get(id);
                if value::type_input(text) != Some(value::Typed::Text) || text.starts_with('\'') {
                    out.push('\'');
                }
                out.push_str(text);
            }
        }
    }

    /// Exact bounding box of non-empty cells.
    pub fn used_range(&self) -> Option<CellRange> {
        let mut r0 = u32::MAX;
        let mut r1 = 0u32;
        let mut c0 = u32::MAX;
        let mut c1 = 0u32;
        for (c, col) in self.cols.iter().enumerate() {
            let extent = col.extent().min(self.rows.max(col.extent()));
            // Last non-empty row.
            let mut last = None;
            let mut r = extent;
            while r > 0 {
                r -= 1;
                if !col.is_empty_at(r) {
                    last = Some(r);
                    break;
                }
            }
            let Some(last) = last else { continue };
            let mut first = 0;
            while first < last && col.is_empty_at(first) {
                first += 1;
            }
            r0 = r0.min(first);
            r1 = r1.max(last);
            c0 = c0.min(c as u32);
            c1 = c1.max(c as u32);
        }
        (r0 != u32::MAX).then_some(CellRange { r0, c0, r1, c1 })
    }

    /// Exclusive row bound that may contain data.
    pub fn row_bound(&self) -> u32 {
        self.cols.iter().map(Column::extent).max().unwrap_or(0).max(self.rows)
    }

    pub fn heap_bytes(&self) -> usize {
        self.cols.iter().map(Column::heap_bytes).sum::<usize>() + self.strings.heap_bytes()
    }

    /// Whether `row` passes the autofilter criteria of every column except `skip`.
    pub fn row_passes_filters(&self, row: u32, skip: Option<u32>, buf: &mut String) -> bool {
        for (col, values) in &self.view.filters {
            if Some(*col) == skip {
                continue;
            }
            buf.clear();
            self.write_display(self.get(row, *col), buf);
            if !values.iter().any(|v| v == buf.as_str()) {
                return false;
            }
        }
        true
    }

    /// Recomputes `filter_hidden` from the autofilter criteria.
    pub fn refilter(&mut self) {
        self.view.filter_hidden.clear();
        let Some(range) = self.view.auto_filter else { return };
        if self.view.filters.is_empty() {
            return;
        }
        // Per-column criteria as sets keyed by display string.
        let sets: Vec<(u32, std::collections::HashSet<&str>)> =
            self.view.filters.iter().map(|(c, vals)| (*c, vals.iter().map(String::as_str).collect())).collect();
        let mut hidden = BitSet::default();
        let mut buf = String::new();
        let bound = self.row_bound();
        if bound == 0 {
            return;
        }
        let last = range.r1.min(bound - 1);
        for row in range.r0 + 1..=last {
            for (col, set) in &sets {
                buf.clear();
                self.write_display(self.get(row, *col), &mut buf);
                if !set.contains(buf.as_str()) {
                    hidden.set(row, true);
                    break;
                }
            }
        }
        self.view.filter_hidden = hidden;
    }

    /// Replaces the data of a column wholesale (undo of column deletes).
    pub fn insert_columns(&mut self, index: u32, columns: Vec<Column>) {
        let i = (index as usize).min(self.cols.len());
        while self.cols.len() < i {
            self.cols.push(Column::default());
        }
        for (k, c) in columns.into_iter().enumerate() {
            self.cols.insert(i + k, c);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitset_shifts() {
        let mut b = BitSet::default();
        for i in [1, 5, 64, 200] {
            b.set(i, true);
        }
        b.insert_gap(5, 2);
        assert_eq!(b.iter().collect::<Vec<_>>(), vec![1, 7, 66, 202]);
        b.remove_range(0, 2);
        assert_eq!(b.iter().collect::<Vec<_>>(), vec![5, 64, 200]);
        b.set(5, false);
        assert_eq!(b.iter().count(), 2);
    }

    #[test]
    fn autofilter_follows_row_inserts_and_deletes() {
        let mut v = View { auto_filter: Some(CellRange { r0: 2, c0: 0, r1: 10, c1: 3 }), ..View::default() };
        v.shift_rows(0, 2, true);
        assert_eq!(v.auto_filter.unwrap(), CellRange { r0: 4, c0: 0, r1: 12, c1: 3 });
        v.shift_rows(6, 2, true);
        assert_eq!(v.auto_filter.unwrap(), CellRange { r0: 4, c0: 0, r1: 14, c1: 3 });
        v.shift_rows(6, 3, false);
        assert_eq!(v.auto_filter.unwrap(), CellRange { r0: 4, c0: 0, r1: 11, c1: 3 });
        v.shift_rows(0, 2, false);
        assert_eq!(v.auto_filter.unwrap(), CellRange { r0: 2, c0: 0, r1: 9, c1: 3 });
        v.shift_rows(0, 20, false);
        assert!(v.auto_filter.is_none());
    }
}
