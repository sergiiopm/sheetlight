//! Typed column storage and the shared string table.
//!
//! A column has a *primary* representation chosen from its data (a dense
//! `f64` vector with one number format, or a dense vector of string ids) plus
//! a sparse map of exceptions for cells that do not fit (the header row, a
//! stray `n/a` in a numeric column…). When exceptions stop being rare the
//! column switches to a `Mixed` vector of `Val`s. Cells past the end of the
//! dense vector are empty, so sparse/ragged columns cost nothing.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use super::value::{Fmt, Val};

/// Hole marker in numeric columns (a NaN payload the parser never produces).
const NUM_HOLE: u64 = 0x7ff8_dead_beef_0001;
/// Hole marker in text columns.
const TEXT_HOLE: u32 = u32::MAX;

fn num_hole() -> f64 {
    f64::from_bits(NUM_HOLE)
}

fn is_num_hole(v: f64) -> bool {
    v.to_bits() == NUM_HOLE
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/// Identity hasher for keys that already are 64-bit hashes.
#[derive(Default)]
pub struct IdentityHasher(u64);

impl Hasher for IdentityHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 << 8) ^ u64::from(*b);
        }
    }
    fn write_u64(&mut self, value: u64) {
        self.0 = value;
    }
}

type HashIndex = HashMap<u64, u32, BuildHasherDefault<IdentityHasher>>;

/// 64-bit FNV-1a with a final mix; fast for the short strings of CSVs.
pub fn hash_str(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash ^= hash >> 33;
    hash = hash.wrapping_mul(0xff51_afd7_ed55_8ccd);
    hash ^ (hash >> 33)
}

/// Append-only string table: one arena + end offsets. Ids are stable.
#[derive(Default)]
pub struct Strings {
    arena: String,
    ends: Vec<u32>,
    index: HashIndex,
}

impl Strings {
    pub fn get(&self, id: u32) -> &str {
        let id = id as usize;
        let start = if id == 0 { 0 } else { self.ends[id - 1] as usize };
        &self.arena[start..self.ends[id] as usize]
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.ends.len()
    }

    fn push(&mut self, text: &str) -> u32 {
        let id = self.ends.len() as u32;
        self.arena.push_str(text);
        self.ends.push(self.arena.len() as u32);
        id
    }

    /// Returns the id of `text`, deduplicating when `dedupe` is set.
    pub fn intern_hashed(&mut self, text: &str, hash: u64, dedupe: bool) -> (u32, bool) {
        if dedupe {
            if let Some(&id) = self.index.get(&hash) {
                if self.get(id) == text {
                    return (id, false);
                }
                // Hash collision: store a duplicate, keep the first mapping.
                return (self.push(text), true);
            }
            let id = self.push(text);
            self.index.insert(hash, id);
            return (id, true);
        }
        (self.push(text), true)
    }

    pub fn intern(&mut self, text: &str) -> u32 {
        self.intern_hashed(text, hash_str(text), true).0
    }

    pub fn heap_bytes(&self) -> usize {
        self.arena.capacity() + self.ends.capacity() * 4 + self.index.capacity() * 24
    }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub enum ColData {
    Num { vals: Vec<f64>, fmt: Fmt },
    Text { ids: Vec<u32> },
    Mixed(Vec<Val>),
}

#[derive(Clone)]
pub struct Column {
    pub data: ColData,
    exceptions: HashMap<u32, Val>,
    /// Dictionary-encode new strings (turned off for high-cardinality columns).
    pub dedupe: bool,
    pub text_seen: u32,
    pub text_new: u32,
}

impl Default for Column {
    fn default() -> Self {
        Self::with_data(ColData::Text { ids: Vec::new() })
    }
}

impl Column {
    pub fn with_data(data: ColData) -> Self {
        Self { data, exceptions: HashMap::new(), dedupe: true, text_seen: 0, text_new: 0 }
    }

    /// Chooses the primary representation from a sample of values.
    pub fn for_sample(sample: &[Val]) -> Self {
        let mut nums: HashMap<Fmt, usize> = HashMap::new();
        let mut texts = 0usize;
        let mut others = 0usize;
        for v in sample {
            match v {
                Val::Num(_, fmt) => *nums.entry(*fmt).or_default() += 1,
                Val::Text(_) => texts += 1,
                Val::Bool(_) => others += 1,
                Val::Empty => {}
            }
        }
        let (best_fmt, best_nums) = nums.iter().max_by_key(|(f, n)| (**n, std::cmp::Reverse(**f))).map(|(f, n)| (*f, *n)).unwrap_or((Fmt::General, 0));
        let total_nums: usize = nums.values().sum();
        if others > total_nums.max(texts) {
            Self::with_data(ColData::Mixed(Vec::new()))
        } else if best_nums > 0 && total_nums >= texts {
            Self::with_data(ColData::Num { vals: Vec::new(), fmt: best_fmt })
        } else {
            Self::default()
        }
    }

    /// Length of the dense part (cells past it are empty or exceptions).
    pub fn dense_len(&self) -> usize {
        match &self.data {
            ColData::Num { vals, .. } => vals.len(),
            ColData::Text { ids } => ids.len(),
            ColData::Mixed(v) => v.len(),
        }
    }

    pub fn exception_count(&self) -> usize {
        self.exceptions.len()
    }

    #[inline]
    pub fn get(&self, row: u32) -> Val {
        let r = row as usize;
        match &self.data {
            ColData::Num { vals, fmt } => {
                if let Some(v) = vals.get(r) {
                    if !is_num_hole(*v) {
                        return Val::Num(*v, *fmt);
                    }
                }
            }
            ColData::Text { ids } => {
                if let Some(id) = ids.get(r) {
                    if *id != TEXT_HOLE {
                        return Val::Text(*id);
                    }
                }
            }
            ColData::Mixed(v) => return v.get(r).copied().unwrap_or(Val::Empty),
        }
        if self.exceptions.is_empty() {
            Val::Empty
        } else {
            self.exceptions.get(&row).copied().unwrap_or(Val::Empty)
        }
    }

    /// Quick emptiness check (no exception lookup when the dense cell is set).
    #[inline]
    pub fn is_empty_at(&self, row: u32) -> bool {
        self.get(row).is_empty()
    }

    fn grow_to(&mut self, len: usize) {
        match &mut self.data {
            ColData::Num { vals, .. } => vals.resize(len, num_hole()),
            ColData::Text { ids } => ids.resize(len, TEXT_HOLE),
            ColData::Mixed(v) => v.resize(len, Val::Empty),
        }
    }

    /// Sets one cell, growing the dense vector when needed.
    pub fn set(&mut self, row: u32, val: Val) {
        let r = row as usize;
        let fits = match (&self.data, val) {
            (ColData::Num { fmt, .. }, Val::Num(_, f)) => *fmt == f,
            (ColData::Text { .. }, Val::Text(_)) => true,
            (ColData::Mixed(_), _) => true,
            _ => false,
        };
        if fits {
            if r >= self.dense_len() {
                self.grow_to(r + 1);
            }
            match (&mut self.data, val) {
                (ColData::Num { vals, .. }, Val::Num(v, _)) => vals[r] = v,
                (ColData::Text { ids }, Val::Text(id)) => ids[r] = id,
                (ColData::Mixed(v), val) => v[r] = val,
                _ => unreachable!(),
            }
            if !self.exceptions.is_empty() {
                self.exceptions.remove(&row);
            }
            return;
        }
        // Clear the dense slot, then record as exception (or nothing if empty).
        if r < self.dense_len() {
            match &mut self.data {
                ColData::Num { vals, .. } => vals[r] = num_hole(),
                ColData::Text { ids } => ids[r] = TEXT_HOLE,
                ColData::Mixed(_) => unreachable!(),
            }
        }
        if val.is_empty() {
            self.exceptions.remove(&row);
        } else {
            self.exceptions.insert(row, val);
            let limit = (self.dense_len() / 16).max(1024);
            if self.exceptions.len() > limit {
                self.make_mixed();
            }
        }
    }

    /// Appends a value at `row` (>= current length) during loading.
    #[inline]
    pub fn push_at(&mut self, row: u32, val: Val) {
        match (&mut self.data, val) {
            (ColData::Num { vals, fmt }, Val::Num(v, f)) if *fmt == f => {
                if vals.len() < row as usize {
                    vals.resize(row as usize, num_hole());
                }
                vals.push(v);
            }
            (ColData::Text { ids }, Val::Text(id)) => {
                if ids.len() < row as usize {
                    ids.resize(row as usize, TEXT_HOLE);
                }
                ids.push(id);
            }
            (_, Val::Empty) => {}
            _ => self.set(row, val),
        }
    }

    fn make_mixed(&mut self) {
        let len = self.dense_len().max(self.exceptions.keys().max().map_or(0, |m| *m as usize + 1));
        let mut out = Vec::with_capacity(len);
        for row in 0..len as u32 {
            out.push(self.get(row));
        }
        self.data = ColData::Mixed(out);
        self.exceptions = HashMap::new();
    }

    /// Last row that may hold a value (exclusive bound).
    pub fn extent(&self) -> u32 {
        let dense = self.dense_len() as u32;
        let exc = self.exceptions.keys().max().map_or(0, |m| m + 1);
        dense.max(exc)
    }

    /// Takes the values of rows `start..start+count` (for undo of deletes).
    pub fn slice(&self, start: u32, count: u32) -> Vec<Val> {
        (start..start + count).map(|r| self.get(r)).collect()
    }

    /// Inserts `count` empty rows at `index`.
    pub fn insert_rows(&mut self, index: u32, count: u32) {
        let i = index as usize;
        let n = count as usize;
        if i < self.dense_len() {
            match &mut self.data {
                ColData::Num { vals, .. } => {
                    vals.splice(i..i, std::iter::repeat_n(num_hole(), n));
                }
                ColData::Text { ids } => {
                    ids.splice(i..i, std::iter::repeat_n(TEXT_HOLE, n));
                }
                ColData::Mixed(v) => {
                    v.splice(i..i, std::iter::repeat_n(Val::Empty, n));
                }
            }
        }
        if !self.exceptions.is_empty() {
            let old = std::mem::take(&mut self.exceptions);
            self.exceptions = old.into_iter().map(|(r, v)| (if r >= index { r + count } else { r }, v)).collect();
        }
    }

    /// Removes rows `index..index+count`.
    pub fn delete_rows(&mut self, index: u32, count: u32) {
        let i = index as usize;
        let len = self.dense_len();
        if i < len {
            let end = (i + count as usize).min(len);
            match &mut self.data {
                ColData::Num { vals, .. } => {
                    vals.drain(i..end);
                }
                ColData::Text { ids } => {
                    ids.drain(i..end);
                }
                ColData::Mixed(v) => {
                    v.drain(i..end);
                }
            }
        }
        if !self.exceptions.is_empty() {
            let old = std::mem::take(&mut self.exceptions);
            self.exceptions = old
                .into_iter()
                .filter(|(r, _)| *r < index || *r >= index + count)
                .map(|(r, v)| (if r >= index + count { r - count } else { r }, v))
                .collect();
        }
    }

    /// Reorders rows `start..start+perm.len()`: new row `start+i` gets the
    /// old row `start+perm[i]`.
    pub fn permute(&mut self, start: u32, perm: &[u32]) {
        let values: Vec<Val> = perm.iter().map(|p| self.get(start + p)).collect();
        for (i, v) in values.into_iter().enumerate() {
            let row = start + i as u32;
            if v.is_empty() && row as usize >= self.dense_len() && self.exceptions.is_empty() {
                continue;
            }
            self.set(row, v);
        }
    }

    pub fn heap_bytes(&self) -> usize {
        let dense = match &self.data {
            ColData::Num { vals, .. } => vals.capacity() * 8,
            ColData::Text { ids } => ids.capacity() * 4,
            ColData::Mixed(v) => v.capacity() * std::mem::size_of::<Val>(),
        };
        dense + self.exceptions.capacity() * 24
    }

    /// Releases spare capacity after loading.
    pub fn shrink(&mut self) {
        match &mut self.data {
            ColData::Num { vals, .. } => vals.shrink_to_fit(),
            ColData::Text { ids } => ids.shrink_to_fit(),
            ColData::Mixed(v) => v.shrink_to_fit(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exceptions_hold_header_and_strays() {
        let mut col = Column::with_data(ColData::Num { vals: Vec::new(), fmt: Fmt::General });
        col.push_at(0, Val::Text(7));
        col.push_at(1, Val::Num(1.0, Fmt::General));
        col.push_at(3, Val::Num(3.0, Fmt::General));
        col.push_at(4, Val::Bool(true));
        assert_eq!(col.get(0), Val::Text(7));
        assert_eq!(col.get(1), Val::Num(1.0, Fmt::General));
        assert_eq!(col.get(2), Val::Empty);
        assert_eq!(col.get(3), Val::Num(3.0, Fmt::General));
        assert_eq!(col.get(4), Val::Bool(true));
        assert_eq!(col.get(99), Val::Empty);
        assert_eq!(col.exception_count(), 2);
        col.set(0, Val::Num(5.0, Fmt::General));
        assert_eq!(col.get(0), Val::Num(5.0, Fmt::General));
        assert_eq!(col.exception_count(), 1);
    }

    #[test]
    fn switches_to_mixed_when_exceptions_dominate() {
        let mut col = Column::with_data(ColData::Num { vals: Vec::new(), fmt: Fmt::General });
        for r in 0..5000u32 {
            let v = if r % 2 == 0 { Val::Num(f64::from(r), Fmt::General) } else { Val::Text(r) };
            col.push_at(r, v);
        }
        assert!(matches!(col.data, ColData::Mixed(_)));
        assert_eq!(col.get(10), Val::Num(10.0, Fmt::General));
        assert_eq!(col.get(11), Val::Text(11));
    }

    #[test]
    fn insert_delete_permute() {
        let mut col = Column::default();
        for r in 0..5u32 {
            col.push_at(r, Val::Text(r));
        }
        col.set(2, Val::Num(1.0, Fmt::General));
        col.insert_rows(1, 2);
        assert_eq!(col.get(0), Val::Text(0));
        assert_eq!(col.get(1), Val::Empty);
        assert_eq!(col.get(3), Val::Text(1));
        assert_eq!(col.get(4), Val::Num(1.0, Fmt::General));
        col.delete_rows(1, 2);
        assert_eq!(col.get(2), Val::Num(1.0, Fmt::General));
        col.permute(0, &[4, 3, 2, 1, 0]);
        assert_eq!(col.get(0), Val::Text(4));
        assert_eq!(col.get(2), Val::Num(1.0, Fmt::General));
        assert_eq!(col.get(4), Val::Text(0));
    }

    #[test]
    fn strings_dedupe() {
        let mut s = Strings::default();
        let a = s.intern("Madrid");
        let b = s.intern("Sevilla");
        assert_eq!(s.intern("Madrid"), a);
        assert_ne!(a, b);
        assert_eq!(s.get(b), "Sevilla");
        let (c, new) = s.intern_hashed("Madrid", hash_str("Madrid"), false);
        assert!(new);
        assert_ne!(c, a);
        assert_eq!(s.get(c), "Madrid");
    }
}
