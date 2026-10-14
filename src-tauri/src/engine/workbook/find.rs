//! Find and replace (IronCalc has neither).

use super::history::Batch;
use super::ops::invalid;
use super::queries::{rows_between, used_bounds};
use super::{norm, WorkbookBackend};
use crate::engine::types::*;

/// Case-insensitive (or exact) substring / whole-cell matcher.
struct Matcher {
    needle: String,
    match_case: bool,
    whole_cell: bool,
}

impl Matcher {
    fn new(query: &FindQuery) -> Self {
        let needle = if query.match_case { query.text.clone() } else { query.text.to_lowercase() };
        Self { needle, match_case: query.match_case, whole_cell: query.whole_cell }
    }

    fn is_match(&self, text: &str) -> bool {
        if self.needle.is_empty() || text.is_empty() {
            return false;
        }
        if self.match_case {
            if self.whole_cell {
                text == self.needle
            } else {
                text.contains(&self.needle)
            }
        } else {
            let lower = text.to_lowercase();
            if self.whole_cell {
                lower == self.needle
            } else {
                lower.contains(&self.needle)
            }
        }
    }
}

/// Replaces every occurrence of `needle` in `text` (case-insensitively unless `match_case`).
pub(crate) fn replace_text(text: &str, needle: &str, replacement: &str, match_case: bool) -> String {
    if needle.is_empty() {
        return text.to_string();
    }
    if match_case {
        return text.replace(needle, replacement);
    }
    let needle: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        let mut k = 0;
        // Compare lower-cased chars one by one.
        'scan: while k < needle.len() && j < chars.len() {
            for lc in chars[j].1.to_lowercase() {
                if k >= needle.len() || lc != needle[k] {
                    break 'scan;
                }
                k += 1;
            }
            j += 1;
        }
        if k == needle.len() {
            out.push_str(replacement);
            i = j;
        } else {
            out.push(chars[i].1);
            i += 1;
        }
    }
    out
}

impl WorkbookBackend {
    /// Sheets a query looks at, in workbook order.
    fn query_sheets(&self, query: &FindQuery) -> EngineResult<Vec<SheetId>> {
        match query.sheet {
            Some(sheet) => {
                self.sheet_index(sheet)?;
                Ok(vec![sheet])
            }
            None => Ok(self.model().workbook.worksheets.iter().map(|ws| ws.sheet_id).collect()),
        }
    }

    /// Visits matching cells (0-based) in search order until `visit` returns false.
    fn scan(&self, query: &FindQuery, look_in: LookIn, visit: &mut dyn FnMut(SheetId, u32, u32, String) -> bool) -> EngineResult<()> {
        let matcher = Matcher::new(query);
        if matcher.needle.is_empty() {
            return Ok(());
        }
        let by_columns = query.by_columns.unwrap_or(false);
        for sheet in self.query_sheets(query)? {
            let sheet_index = self.sheet_index(sheet)?;
            let ws = &self.model().workbook.worksheets[sheet_index as usize];
            let Some(bounds) = used_bounds(ws) else { continue };
            let ranges: Vec<CellRange> = match &query.within {
                Some(within) if !within.is_empty() => within.iter().map(|r| norm(*r)).collect(),
                _ => vec![CellRange { r0: 0, c0: 0, r1: (bounds.r1 - 1) as u32, c1: (bounds.c1 - 1) as u32 }],
            };
            for range in ranges {
                let r0 = range.r0 as i32 + 1;
                let r1 = (range.r1 as i32 + 1).min(bounds.r1);
                let c0 = range.c0 as i32 + 1;
                let c1 = (range.c1 as i32 + 1).min(bounds.c1);
                if r1 < r0 || c1 < c0 {
                    continue;
                }
                let mut found: Vec<(u32, u32, String)> = Vec::new();
                for row in rows_between(ws, r0, r1) {
                    for (col, _) in ws.sheet_data.cells_in_row_between(row, c0, c1) {
                        let (text, display) = match look_in {
                            LookIn::Formulas => {
                                let input = self.cell_input(sheet_index, ws, row, col);
                                let display = self.value_display(ws, row, col).1;
                                (input, display)
                            }
                            LookIn::Values => {
                                let display = self.value_display(ws, row, col).1;
                                (display.clone(), display)
                            }
                        };
                        if matcher.is_match(&text) {
                            let hit = ((row - 1) as u32, (col - 1) as u32, display);
                            if by_columns {
                                found.push(hit);
                            } else if !visit(sheet, hit.0, hit.1, hit.2) {
                                return Ok(());
                            }
                        }
                    }
                }
                if by_columns {
                    found.sort_by_key(|(r, c, _)| (*c, *r));
                    for (r, c, d) in found {
                        if !visit(sheet, r, c, d) {
                            return Ok(());
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub(crate) fn find_impl(&self, query: &FindQuery) -> EngineResult<Vec<FindMatch>> {
        let limit = query.limit.max(1) as usize;
        let mut out = Vec::new();
        self.scan(query, query.look_in, &mut |sheet, row, col, display| {
            out.push(FindMatch { sheet, row, col, display });
            out.len() < limit
        })?;
        Ok(out)
    }

    /// Replace works on the canonical input (like Excel, "look in formulas").
    pub(crate) fn op_replace(
        &mut self,
        b: &mut Batch,
        query: &FindQuery,
        replacement: &str,
        all: bool,
        at: Option<&CellPosition>,
    ) -> EngineResult<()> {
        let mut targets: Vec<(SheetId, u32, u32)> = Vec::new();
        if all {
            self.scan(query, LookIn::Formulas, &mut |sheet, row, col, _| {
                targets.push((sheet, row, col));
                true
            })?;
        } else if let Some(at) = at {
            let matcher = Matcher::new(query);
            let sheet_index = self.sheet_index(at.sheet)?;
            let ws = &self.model().workbook.worksheets[sheet_index as usize];
            let input = self.cell_input(sheet_index, ws, at.row as i32 + 1, at.col as i32 + 1);
            if matcher.is_match(&input) {
                targets.push((at.sheet, at.row, at.col));
            }
        }
        if !all && targets.is_empty() {
            // Nothing at `at`: replace the first match.
            self.scan(query, LookIn::Formulas, &mut |sheet, row, col, _| {
                targets.push((sheet, row, col));
                false
            })?;
        }
        for (sheet, row, col) in targets.iter().copied() {
            let sheet_index = self.sheet_index(sheet)?;
            let ws = &self.model().workbook.worksheets[sheet_index as usize];
            let input = self.cell_input(sheet_index, ws, row as i32 + 1, col as i32 + 1);
            let new_input = if query.whole_cell {
                replacement.to_string()
            } else {
                replace_text(&input, &query.text, replacement, query.match_case)
            };
            if new_input == input {
                continue;
            }
            self.write_input(b, sheet_index, row as i32 + 1, col as i32 + 1, &new_input).map_err(|e| {
                if e.code == EngineErrorCode::InvalidFormula {
                    invalid("El reemplazo produce una fórmula no válida.")
                } else {
                    e
                }
            })?;
            let one = CellRange { r0: row, c0: col, r1: row, c1: col };
            b.cells(sheet, one);
            b.affected += 1;
        }
        if let Some((sheet, row, col)) = targets.last().copied() {
            if !all {
                b.select(sheet, vec![CellRange { r0: row, c0: col, r1: row, c1: col }]);
                b.active = Some(sheet);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_case_insensitively() {
        assert_eq!(replace_text("Hola hola HOLA", "hola", "adiós", false), "adiós adiós adiós");
        assert_eq!(replace_text("Hola hola", "hola", "x", true), "Hola x");
        assert_eq!(replace_text("=SUM(a1)", "A1", "B2", false), "=SUM(B2)");
        assert_eq!(replace_text("abc", "", "x", false), "abc");
    }
}
