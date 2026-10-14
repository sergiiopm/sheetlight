//! Autofilter model. IronCalc does not model `<autoFilter>`, so Sheetlight
//! keeps the range and per-column criteria in `SheetExtra` and implements the
//! filtering itself by hiding rows (an IronCalc mutation, so undo works).

use std::collections::{BTreeMap, HashMap};

use super::display::RawValue;
use super::history::Batch;
use super::ops::{invalid, runs};
use super::queries::{hidden_rows, used_bounds};
use super::{ic_col, ic_row, AutoFilter, WorkbookBackend};
use crate::engine::types::*;

impl WorkbookBackend {
    /// Whether a cell (0-based) holds a non-empty value.
    pub(crate) fn has_value(&self, sheet_index: u32, row: u32, col: u32) -> bool {
        let ws = &self.model().workbook.worksheets[sheet_index as usize];
        match ws.sheet_data.cell(ic_row(row), ic_col(col)) {
            None => false,
            Some(cell) => {
                cell.has_formula()
                    || !super::display::raw_value(&cell, &self.model().workbook.shared_strings).is_empty()
            }
        }
    }

    fn segment_has_value(&self, sheet_index: u32, row: u32, c0: u32, c1: u32) -> bool {
        let ws = &self.model().workbook.worksheets[sheet_index as usize];
        let shared = &self.model().workbook.shared_strings;
        ws.sheet_data
            .cells_in_row_between(ic_row(row), ic_col(c0), ic_col(c1))
            .any(|(_, cell)| cell.has_formula() || !super::display::raw_value(&cell, shared).is_empty())
    }

    /// Excel's "current region": the block of non-empty cells around `range`
    /// bounded by empty rows and columns. Whole rows/columns are clamped to
    /// the used area.
    pub(crate) fn current_region(&self, sheet: SheetId, range: CellRange) -> EngineResult<CellRange> {
        let sheet_index = self.sheet_index(sheet)?;
        let ws = self.worksheet(sheet)?;
        let Some(bounds) = used_bounds(ws) else { return Ok(range) };
        let (last_row, last_col) = ((bounds.r1 - 1) as u32, (bounds.c1 - 1) as u32);
        let mut r = CellRange { r0: range.r0, c0: range.c0, r1: range.r1.min(last_row.max(range.r0)), c1: range.c1.min(last_col.max(range.c0)) };
        if r.r0 != r.r1 || r.c0 != r.c1 {
            return Ok(r);
        }
        // Grow while a bordering row/column segment holds data.
        for _ in 0..100_000 {
            let mut grown = false;
            if r.r0 > 0 && self.segment_has_value(sheet_index, r.r0 - 1, r.c0.saturating_sub(1), (r.c1 + 1).min(last_col.max(r.c1))) {
                r.r0 -= 1;
                grown = true;
            }
            if r.r1 < last_row && self.segment_has_value(sheet_index, r.r1 + 1, r.c0.saturating_sub(1), (r.c1 + 1).min(last_col.max(r.c1))) {
                r.r1 += 1;
                grown = true;
            }
            let rows = r.r0.saturating_sub(1)..=(r.r1 + 1).min(last_row.max(r.r1));
            if r.c0 > 0 && rows.clone().any(|row| self.has_value(sheet_index, row, r.c0 - 1)) {
                r.c0 -= 1;
                grown = true;
            }
            if r.c1 < last_col && rows.clone().any(|row| self.has_value(sheet_index, row, r.c1 + 1)) {
                r.c1 += 1;
                grown = true;
            }
            if !grown {
                break;
            }
        }
        Ok(r)
    }

    pub(crate) fn op_set_auto_filter(&mut self, b: &mut Batch, sheet: SheetId, range: Option<CellRange>) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        // Removing (or replacing) a filter shows the rows it hid.
        if let Some(old) = self.extra(sheet).and_then(|e| e.filter.clone()) {
            if !old.criteria.is_empty() {
                self.set_filter_rows_visible(b, sheet_index, &old)?;
                b.data(sheet);
            }
        }
        let filter = match range {
            None => None,
            Some(range) => {
                let mut region = self.current_region(sheet, range)?;
                if region.r1 == region.r0 {
                    // Header only: include the data below it.
                    while region.r1 + 1 < MAX_ROWS && self.segment_has_value(sheet_index, region.r1 + 1, region.c0, region.c1) {
                        region.r1 += 1;
                    }
                }
                Some(AutoFilter { range: region, criteria: BTreeMap::new() })
            }
        };
        if let Some(f) = &filter {
            b.select(sheet, vec![f.range]);
        }
        self.extra_mut(sheet).filter = filter;
        b.scope.info.insert(sheet);
        Ok(())
    }

    pub(crate) fn op_filter_column(&mut self, b: &mut Batch, sheet: SheetId, col: u32, criteria: Option<&FilterCriteria>) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        let Some(mut filter) = self.extra(sheet).and_then(|e| e.filter.clone()) else {
            return Err(invalid("La hoja no tiene filtro."));
        };
        if col < filter.range.c0 || col > filter.range.c1 {
            return Err(invalid("La columna está fuera del filtro."));
        }
        // Data added right below the range joins the filter (Excel reapplies over the region).
        while filter.range.r1 + 1 < MAX_ROWS
            && self.segment_has_value(sheet_index, filter.range.r1 + 1, filter.range.c0, filter.range.c1)
        {
            filter.range.r1 += 1;
        }
        match criteria {
            Some(c) => {
                filter.criteria.insert(col, c.values.clone());
            }
            None => {
                filter.criteria.remove(&col);
            }
        }
        self.apply_filter(b, sheet_index, &filter)?;
        self.extra_mut(sheet).filter = Some(filter);
        b.data(sheet);
        b.scope.info.insert(sheet);
        Ok(())
    }

    fn set_filter_rows_visible(&mut self, b: &mut Batch, sheet_index: u32, filter: &AutoFilter) -> EngineResult<()> {
        if filter.range.r1 <= filter.range.r0 {
            return Ok(());
        }
        let (s, e) = (ic_row(filter.range.r0 + 1), ic_row(filter.range.r1));
        self.ic(b, |um| um.set_rows_hidden(sheet_index, s, e, false))
    }

    /// Hides the data rows that fail any criterion and shows the rest.
    fn apply_filter(&mut self, b: &mut Batch, sheet_index: u32, filter: &AutoFilter) -> EngineResult<()> {
        if filter.range.r1 <= filter.range.r0 {
            return Ok(());
        }
        let mut hide = Vec::new();
        let mut show = Vec::new();
        {
            let ws = &self.model().workbook.worksheets[sheet_index as usize];
            let currently_hidden = hidden_rows(ws);
            for row in filter.range.r0 + 1..=filter.range.r1 {
                let visible = self.row_passes(ws, row, filter, None);
                let hidden_now = currently_hidden.contains(&ic_row(row));
                if visible && hidden_now {
                    show.push(row);
                } else if !visible && !hidden_now {
                    hide.push(row);
                }
            }
        }
        for (indices, hidden) in [(hide, true), (show, false)] {
            for (start, end) in runs(&indices) {
                let (s, e) = (ic_row(start), ic_row(end));
                self.ic(b, |um| um.set_rows_hidden(sheet_index, s, e, hidden))?;
            }
        }
        Ok(())
    }

    /// Whether a data row passes every criterion (except `skip_col`).
    fn row_passes(&self, ws: &ironcalc_base::types::Worksheet, row: u32, filter: &AutoFilter, skip_col: Option<u32>) -> bool {
        filter.criteria.iter().all(|(col, values)| {
            if Some(*col) == skip_col {
                return true;
            }
            let (_, text) = self.value_display(ws, ic_row(row), ic_col(*col));
            values.iter().any(|v| v == &text)
        })
    }

    pub(crate) fn filter_values_impl(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<FilterValue>> {
        let ws = self.worksheet(sheet)?;
        let Some(filter) = self.extra(sheet).and_then(|e| e.filter.as_ref()) else {
            return Ok(Vec::new());
        };
        if col < filter.range.c0 || col > filter.range.c1 {
            return Ok(Vec::new());
        }
        // Distinct values of the rows visible under the *other* columns' criteria.
        let mut counts: HashMap<String, (u64, SortKey)> = HashMap::new();
        for row in filter.range.r0 + 1..=filter.range.r1 {
            if !self.row_passes(ws, row, filter, Some(col)) {
                continue;
            }
            let (raw, text) = self.value_display(ws, ic_row(row), ic_col(col));
            let entry = counts.entry(text).or_insert_with_key(|t| (0, sort_key(&raw, t)));
            entry.0 += 1;
        }
        let criteria = filter.criteria.get(&col);
        let mut out: Vec<(SortKey, FilterValue)> = counts
            .into_iter()
            .map(|(value, (count, key))| {
                let selected = criteria.is_none_or(|values| values.contains(&value));
                (key, FilterValue { value, count, selected })
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out.into_iter().take(limit as usize).map(|(_, v)| v).collect())
    }
}

/// Excel ascending order: numbers, text (case-insensitive), booleans, errors, blanks.
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub(crate) enum SortKey {
    Number(f64),
    Text(String),
    Bool(bool),
    Error(String),
    Blank,
}

impl Eq for SortKey {}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.partial_cmp(other).unwrap_or(std::cmp::Ordering::Equal)
    }
}

pub(crate) fn sort_key(raw: &RawValue<'_>, display: &str) -> SortKey {
    match raw {
        RawValue::Empty => SortKey::Blank,
        RawValue::Number(n) => SortKey::Number(*n),
        RawValue::Text(t) if t.is_empty() => SortKey::Blank,
        RawValue::Text(t) => SortKey::Text(fold(t)),
        RawValue::Bool(v) => SortKey::Bool(*v),
        RawValue::Error(_) => SortKey::Error(display.to_string()),
    }
}

/// Case- and accent-insensitive comparison key (Spanish collation, roughly).
pub(crate) fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            other => other,
        })
        .collect()
}
