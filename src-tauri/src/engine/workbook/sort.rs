//! Range sort (Excel "Ordenar"): stable, multi-key, blanks always last,
//! formulas move with their row (relative references shift like a copy),
//! and rows hidden by a filter stay where they are.

use std::collections::HashMap;

use super::filter::{sort_key, SortKey as ValueKey};
use super::history::Batch;
use super::ops::invalid;
use super::paste::CellData;
use super::queries::hidden_rows;
use super::{ic_col, ic_row, WorkbookBackend};
use crate::engine::types::*;

impl WorkbookBackend {
    pub(crate) fn op_sort(&mut self, b: &mut Batch, sheet: SheetId, range: CellRange, keys: &[SortKey], has_header: bool) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        if keys.is_empty() {
            return Ok(());
        }
        let range = self.current_region(sheet, range)?;
        if keys.iter().any(|k| k.col < range.c0 || k.col > range.c1) {
            return Err(invalid("La columna de ordenación está fuera del rango."));
        }
        let first = range.r0 + u32::from(has_header);
        if first >= range.r1 {
            b.select(sheet, vec![range]);
            return Ok(());
        }
        if (range.r1 - first + 1) as u64 * (range.c1 - range.c0 + 1) as u64 > 5_000_000 {
            return Err(EngineError::new(EngineErrorCode::TooLarge, "El rango es demasiado grande para ordenarlo."));
        }
        {
            let ws = self.worksheet(sheet)?;
            if ws.merged_cells.iter().any(|m| {
                let (r0, r1) = ((m.row - 1) as u32, (m.last_row() - 1) as u32);
                let (c0, c1) = ((m.column - 1) as u32, (m.last_column() - 1) as u32);
                r0 <= range.r1 && first <= r1 && c0 <= range.c1 && range.c0 <= c1
            }) {
                return Err(invalid("No se puede ordenar un rango con celdas combinadas."));
            }
        }

        // Rows taking part (visible ones) and their keys.
        let (rows, order) = {
            let ws = self.worksheet(sheet)?;
            let hidden = hidden_rows(ws);
            let rows: Vec<u32> = (first..=range.r1).filter(|r| !hidden.contains(&ic_row(*r))).collect();
            let mut keyed: Vec<(usize, Vec<ValueKey>)> = rows
                .iter()
                .enumerate()
                .map(|(i, row)| {
                    let values = keys
                        .iter()
                        .map(|k| {
                            let (raw, text) = self.value_display(ws, ic_row(*row), ic_col(k.col));
                            sort_key(&raw, &text)
                        })
                        .collect();
                    (i, values)
                })
                .collect();
            keyed.sort_by(|a, b| {
                for (i, key) in keys.iter().enumerate() {
                    let (x, y) = (&a.1[i], &b.1[i]);
                    let ord = match (x, y) {
                        (ValueKey::Blank, ValueKey::Blank) => std::cmp::Ordering::Equal,
                        (ValueKey::Blank, _) => std::cmp::Ordering::Greater,
                        (_, ValueKey::Blank) => std::cmp::Ordering::Less,
                        _ if key.ascending => x.cmp(y),
                        _ => y.cmp(x),
                    };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
                std::cmp::Ordering::Equal
            });
            let order: Vec<usize> = keyed.into_iter().map(|(i, _)| i).collect();
            (rows, order)
        };
        if order.iter().enumerate().all(|(i, src)| i == *src) {
            b.select(sheet, vec![range]);
            return Ok(());
        }

        let (c0, c1) = (ic_col(range.c0), ic_col(range.c1));
        let snapshot = self.read_cells(sheet_index, (ic_row(first), c0, ic_row(range.r1), c1))?;
        // Destination row → source row (0-based), only for rows that move.
        let moves: Vec<(u32, u32)> =
            order.iter().enumerate().map(|(i, src)| (rows[i], rows[*src])).filter(|(d, s)| d != s).collect();

        // 1. Values and styles of every moved row in one in-place write.
        let mut block: HashMap<(i32, i32), CellData> = HashMap::new();
        let (mut lo, mut hi) = (u32::MAX, 0);
        for (dest, src) in &moves {
            lo = lo.min(*dest);
            hi = hi.max(*dest);
            for col in c0..=c1 {
                if let Some(cell) = snapshot.get(&(ic_row(*src), col)) {
                    block.insert((ic_row(*dest), col), cell.clone());
                }
            }
        }
        // The in-place writer needs every cell of its rectangle.
        for row in lo..=hi {
            for col in c0..=c1 {
                if let std::collections::hash_map::Entry::Vacant(slot) = block.entry((ic_row(row), col)) {
                    if let Some(cell) = snapshot.get(&(ic_row(row), col)) {
                        slot.insert(cell.clone());
                    }
                }
            }
        }
        self.write_block_in_place(b, sheet_index, (ic_row(lo), c0, ic_row(hi), c1), &block)?;

        // 2. Rows with formulas are pasted as a copy so relative references shift.
        for (dest, src) in &moves {
            let row: HashMap<(i32, i32), CellData> = (c0..=c1)
                .filter_map(|col| snapshot.get(&(ic_row(*src), col)).map(|c| ((ic_row(*src), col), c.clone())))
                .collect();
            if row.values().any(|c| c.text.starts_with('=')) {
                let rect = (ic_row(*src), c0, ic_row(*src), c1);
                self.paste_cells(b, sheet_index, (ic_row(*dest), c0), sheet_index, rect, &row, false)?;
            }
        }

        // 3. Notes travel with their row.
        let extra = self.extra_mut(sheet);
        let mut moved_notes = Vec::new();
        for (dest, src) in &moves {
            for col in range.c0..=range.c1 {
                if let Some(text) = extra.comments.get(&(*src, col)) {
                    moved_notes.push(((*dest, col), text.clone()));
                }
            }
        }
        for (dest, _) in &moves {
            extra.comments.retain(|(r, c), _| !(*r == *dest && *c >= range.c0 && *c <= range.c1));
        }
        for (key, text) in moved_notes {
            extra.comments.insert(key, text);
        }

        b.affected += moves.len() as u64;
        b.data(sheet);
        b.select(sheet, vec![range]);
        Ok(())
    }
}
