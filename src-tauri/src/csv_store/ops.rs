//! Mutations of the CSV store and their undo records. One `apply` batch is
//! one `Step`; redo re-applies the original ops.

use std::cmp::Ordering;
use std::collections::HashMap;

use super::column::Column;
use super::data::{Data, View};
use super::value::{type_input, Fmt, Typed, Val};
use super::SHEET_ID;
use crate::engine::backend::ApplyOutcome;
use crate::engine::types::*;

/// Undo record of one primitive change.
#[derive(Clone)]
enum Undo {
    /// Old values of changed cells.
    Cells(Vec<(u32, u32, Val)>),
    /// Rows `start..start+inverse.len()` of columns `c0..=c1` were permuted;
    /// applying `inverse` restores them.
    Permute { start: u32, c0: u32, c1: u32, inverse: Vec<u32> },
    View(Box<View>),
    InsertedRows { index: u32, count: u32 },
    /// Deleted rows: values per column.
    DeletedRows { index: u32, count: u32, values: Vec<Vec<Val>> },
    InsertedCols { index: u32, count: u32 },
    DeletedCols { index: u32, columns: Vec<Column> },
    Rows(u32),
}

pub struct Step {
    pub ops: Vec<EngineOp>,
    undo: Vec<Undo>,
}

impl Step {
    pub fn is_empty(&self) -> bool {
        self.undo.is_empty()
    }
}

fn plain_cells(cells: &[CellInput]) -> bool {
    cells.iter().all(|c| {
        c.num_fmt.as_deref().is_none_or(|f| Fmt::from_code(f).is_some()) && type_input(&c.input).is_some() && c.col < MAX_COLS && c.row < MAX_ROWS
    })
}

/// Ops the store applies itself; anything else promotes to a workbook.
pub fn supports(op: &EngineOp) -> bool {
    match op {
        EngineOp::SetCells { sheet, cells } => *sheet == SHEET_ID && plain_cells(cells),
        EngineOp::Clear { sheet, .. }
        | EngineOp::Sort { sheet, .. }
        | EngineOp::InsertRows { sheet, .. }
        | EngineOp::DeleteRows { sheet, .. }
        | EngineOp::InsertCols { sheet, .. }
        | EngineOp::DeleteCols { sheet, .. }
        | EngineOp::SetRowHeights { sheet, .. }
        | EngineOp::SetColWidths { sheet, .. }
        | EngineOp::SetHidden { sheet, .. }
        | EngineOp::SetFrozen { sheet, .. }
        | EngineOp::SetShowGridLines { sheet, .. }
        | EngineOp::SetAutoFilter { sheet, .. }
        | EngineOp::FilterColumn { sheet, .. }
        | EngineOp::SetActiveSheet { sheet } => *sheet == SHEET_ID,
        _ => false,
    }
}

/// View-only ops are fine while rows are still streaming in.
pub fn allowed_while_loading(op: &EngineOp) -> bool {
    matches!(
        op,
        EngineOp::SetRowHeights { .. }
            | EngineOp::SetColWidths { .. }
            | EngineOp::SetHidden { .. }
            | EngineOp::SetFrozen { .. }
            | EngineOp::SetShowGridLines { .. }
            | EngineOp::SetActiveSheet { .. }
    )
}

fn invalid(message: &str) -> EngineError {
    EngineError::new(EngineErrorCode::InvalidOp, message)
}

fn cells_event(range: CellRange) -> EngineEvent {
    // `doc` is patched by `CsvStore` before returning the outcome.
    EngineEvent::Cells { doc: 0, sheet: SHEET_ID, ranges: vec![range] }
}

fn info_event(data: &mut Data) -> EngineEvent {
    data.info_version += 1;
    EngineEvent::SheetInfo { doc: 0, sheet: SHEET_ID, version: data.info_version }
}

/// Bounding box accumulator.
#[derive(Default)]
struct Bounds(Option<CellRange>);

impl Bounds {
    fn add(&mut self, row: u32, col: u32) {
        self.0 = Some(match self.0 {
            None => CellRange { r0: row, c0: col, r1: row, c1: col },
            Some(r) => CellRange { r0: r.r0.min(row), c0: r.c0.min(col), r1: r.r1.max(row), c1: r.c1.max(col) },
        });
    }
}

/// Applies a batch atomically: on error, already applied parts are reverted.
pub fn apply(data: &mut Data, ops: &[EngineOp]) -> EngineResult<(Step, ApplyOutcome)> {
    let mut step = Step { ops: ops.to_vec(), undo: Vec::new() };
    let mut outcome = ApplyOutcome::default();
    for op in ops {
        if let Err(error) = apply_one(data, op, &mut step.undo, &mut outcome) {
            revert(data, &step);
            return Err(error);
        }
    }
    Ok((step, outcome))
}

fn apply_one(data: &mut Data, op: &EngineOp, undo: &mut Vec<Undo>, out: &mut ApplyOutcome) -> EngineResult<()> {
    if !supports(op) {
        return Err(EngineError::unsupported("esta operación en un CSV"));
    }
    match op {
        EngineOp::SetCells { cells, .. } => {
            let mut old = Vec::with_capacity(cells.len());
            let mut bounds = Bounds::default();
            for cell in cells {
                let val = input_value(data, cell);
                let prev = data.get(cell.row, cell.col);
                if prev == val {
                    continue;
                }
                old.push((cell.row, cell.col, prev));
                data.set(cell.row, cell.col, val);
                bounds.add(cell.row, cell.col);
            }
            out.affected += old.len() as u64;
            if let Some(r) = bounds.0 {
                out.events.push(cells_event(r));
            }
            undo.push(Undo::Cells(old));
        }
        EngineOp::Clear { ranges, what, .. } => {
            let mut old = Vec::new();
            let bound = data.row_bound();
            let ncols = data.ncols();
            for range in ranges {
                if bound == 0 || range.r0 >= bound || range.c0 >= ncols {
                    continue;
                }
                let r1 = range.r1.min(bound - 1);
                let c1 = range.c1.min(ncols - 1);
                for col in range.c0..=c1 {
                    let extent = data.cols[col as usize].extent();
                    if extent == 0 || range.r0 >= extent {
                        continue;
                    }
                    for row in range.r0..=r1.min(extent - 1) {
                        let prev = data.get(row, col);
                        let next = match (what, prev) {
                            (_, Val::Empty) => continue,
                            (ClearWhat::Contents | ClearWhat::All, _) => Val::Empty,
                            (ClearWhat::Formats, Val::Num(v, f)) if f != Fmt::General => Val::Num(v, Fmt::General),
                            _ => continue,
                        };
                        old.push((row, col, prev));
                        data.set(row, col, next);
                    }
                }
                out.events.push(cells_event(CellRange { r0: range.r0, c0: range.c0, r1, c1 }));
            }
            out.affected += old.len() as u64;
            undo.push(Undo::Cells(old));
        }
        EngineOp::Sort { range, keys, has_header, .. } => {
            sort(data, *range, keys, *has_header, undo, out)?;
        }
        EngineOp::InsertRows { index, count, .. } => {
            let count = (*count).min(MAX_ROWS - (*index).min(MAX_ROWS));
            if count == 0 {
                return Ok(());
            }
            undo.push(Undo::View(Box::new(data.view.clone())));
            undo.push(Undo::Rows(data.rows));
            for col in &mut data.cols {
                col.insert_rows(*index, count);
            }
            if *index < data.rows {
                data.rows += count;
            }
            data.view.shift_rows(*index, count, true);
            undo.push(Undo::InsertedRows { index: *index, count });
            out.events.push(EngineEvent::Structure { doc: 0, sheet: SHEET_ID, axis: Axis::Row, op: StructureOp::Insert, index: *index, count });
            out.events.push(info_event(data));
        }
        EngineOp::DeleteRows { index, count, .. } => {
            if *count == 0 {
                return Ok(());
            }
            undo.push(Undo::View(Box::new(data.view.clone())));
            undo.push(Undo::Rows(data.rows));
            let values: Vec<Vec<Val>> = data.cols.iter().map(|c| c.slice(*index, (*count).min(c.extent().saturating_sub(*index)))).collect();
            for col in &mut data.cols {
                col.delete_rows(*index, *count);
            }
            if *index < data.rows {
                data.rows -= (*count).min(data.rows - index);
            }
            data.view.shift_rows(*index, *count, false);
            undo.push(Undo::DeletedRows { index: *index, count: *count, values });
            out.events.push(EngineEvent::Structure { doc: 0, sheet: SHEET_ID, axis: Axis::Row, op: StructureOp::Delete, index: *index, count: *count });
            out.events.push(info_event(data));
        }
        EngineOp::InsertCols { index, count, .. } => {
            if *count == 0 {
                return Ok(());
            }
            undo.push(Undo::View(Box::new(data.view.clone())));
            if (*index as usize) < data.cols.len() {
                let fresh = (0..*count).map(|_| Column::default()).collect();
                data.insert_columns(*index, fresh);
            }
            data.view.shift_cols(*index, *count, true);
            undo.push(Undo::InsertedCols { index: *index, count: *count });
            out.events.push(EngineEvent::Structure { doc: 0, sheet: SHEET_ID, axis: Axis::Col, op: StructureOp::Insert, index: *index, count: *count });
            out.events.push(info_event(data));
        }
        EngineOp::DeleteCols { index, count, .. } => {
            if *count == 0 {
                return Ok(());
            }
            undo.push(Undo::View(Box::new(data.view.clone())));
            let start = (*index as usize).min(data.cols.len());
            let end = (start + *count as usize).min(data.cols.len());
            let columns: Vec<Column> = data.cols.drain(start..end).collect();
            data.view.shift_cols(*index, *count, false);
            undo.push(Undo::DeletedCols { index: *index, columns });
            out.events.push(EngineEvent::Structure { doc: 0, sheet: SHEET_ID, axis: Axis::Col, op: StructureOp::Delete, index: *index, count: *count });
            out.events.push(info_event(data));
        }
        EngineOp::SetRowHeights { rows, size, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            for r in rows {
                match size {
                    Some(s) => data.view.row_heights.insert(*r, s.max(0.0)),
                    None => data.view.row_heights.remove(r),
                };
            }
            out.events.push(info_event(data));
        }
        EngineOp::SetColWidths { cols, size, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            for c in cols {
                match size {
                    Some(s) => data.view.col_widths.insert(*c, s.max(0.0)),
                    None => data.view.col_widths.remove(c),
                };
            }
            out.events.push(info_event(data));
        }
        EngineOp::SetHidden { axis, indices, hidden, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            for i in indices {
                match axis {
                    Axis::Row => {
                        data.view.hidden_rows.set(*i, *hidden);
                        if !*hidden {
                            // Unhiding also shows rows hidden by the filter (Excel).
                            data.view.filter_hidden.set(*i, false);
                        }
                    }
                    Axis::Col => {
                        if *hidden {
                            data.view.hidden_cols.insert(*i);
                        } else {
                            data.view.hidden_cols.remove(i);
                        }
                    }
                }
            }
            out.events.push(info_event(data));
        }
        EngineOp::SetFrozen { rows, cols, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            data.view.frozen_rows = (*rows).min(MAX_ROWS - 1);
            data.view.frozen_cols = (*cols).min(MAX_COLS - 1);
            out.events.push(info_event(data));
        }
        EngineOp::SetShowGridLines { show, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            data.view.show_grid_lines = *show;
            out.events.push(info_event(data));
        }
        EngineOp::SetAutoFilter { range, .. } => {
            undo.push(Undo::View(Box::new(data.view.clone())));
            data.view.auto_filter = *range;
            data.view.filters.clear();
            data.view.filter_hidden.clear();
            out.events.push(info_event(data));
        }
        EngineOp::FilterColumn { col, criteria, .. } => {
            let Some(range) = data.view.auto_filter else {
                return Err(invalid("No hay ningún filtro activo en la hoja."));
            };
            if *col < range.c0 || *col > range.c1 {
                return Err(invalid("La columna está fuera del rango filtrado."));
            }
            undo.push(Undo::View(Box::new(data.view.clone())));
            match criteria {
                Some(c) => data.view.filters.insert(*col, c.values.clone()),
                None => data.view.filters.remove(col),
            };
            data.refilter();
            out.events.push(info_event(data));
        }
        EngineOp::SetActiveSheet { .. } => {}
        _ => return Err(EngineError::unsupported("esta operación en un CSV")),
    }
    Ok(())
}

/// Value for a `setCells` input (already checked by `supports`).
fn input_value(data: &mut Data, cell: &CellInput) -> Val {
    let fmt = cell.num_fmt.as_deref().and_then(Fmt::from_code);
    match type_input(&cell.input).unwrap_or(Typed::Text) {
        Typed::Empty => Val::Empty,
        Typed::Bool(b) => Val::Bool(b),
        Typed::Num(v, f) => {
            let mut fmt = fmt.unwrap_or(f);
            // Keep the source style of an ISO date column for CSV saves.
            if fmt.is_date() {
                if let Some(Val::Num(_, existing)) = data.cols.get(cell.col as usize).map(|c| c.get(cell.row)) {
                    if existing.is_date() && existing.as_iso() == existing {
                        fmt = fmt.as_iso();
                    }
                }
                if let Some(super::column::ColData::Num { fmt: col_fmt, .. }) = data.cols.get(cell.col as usize).map(|c| &c.data) {
                    if col_fmt.is_date() && col_fmt.as_iso() == *col_fmt {
                        fmt = fmt.as_iso();
                    }
                }
            }
            Val::Num(v, fmt)
        }
        Typed::Text => {
            let text = cell.input.strip_prefix('\'').unwrap_or(&cell.input);
            Val::Text(data.strings.intern(text))
        }
    }
}

/// Reverts a step (undo). Also used to roll back a failed batch.
pub fn revert(data: &mut Data, step: &Step) -> ApplyOutcome {
    for record in step.undo.iter().rev() {
        match record {
            Undo::Cells(old) => {
                for (row, col, val) in old.iter().rev() {
                    data.set(*row, *col, *val);
                }
            }
            Undo::Permute { start, c0, c1, inverse } => {
                for col in *c0..=*c1 {
                    if let Some(c) = data.cols.get_mut(col as usize) {
                        c.permute(*start, inverse);
                    }
                }
            }
            Undo::View(view) => data.view = (**view).clone(),
            Undo::InsertedRows { index, count } => {
                for col in &mut data.cols {
                    col.delete_rows(*index, *count);
                }
            }
            Undo::DeletedRows { index, count, values } => {
                for (c, col) in data.cols.iter_mut().enumerate() {
                    col.insert_rows(*index, *count);
                    if let Some(vals) = values.get(c) {
                        for (i, v) in vals.iter().enumerate() {
                            if !v.is_empty() {
                                col.set(index + i as u32, *v);
                            }
                        }
                    }
                }
            }
            Undo::InsertedCols { index, count } => {
                let start = (*index as usize).min(data.cols.len());
                let end = (start + *count as usize).min(data.cols.len());
                data.cols.drain(start..end);
            }
            Undo::DeletedCols { index, columns } => data.insert_columns(*index, columns.clone()),
            Undo::Rows(rows) => data.rows = *rows,
        }
    }
    data.info_version += 1;
    ApplyOutcome {
        events: vec![EngineEvent::SheetData { doc: 0, sheet: SHEET_ID }, EngineEvent::SheetInfo { doc: 0, sheet: SHEET_ID, version: data.info_version }],
        ..ApplyOutcome::default()
    }
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/// Collation key char: case-insensitive, accents ignored, `ñ` after `n`.
fn collate_key(c: char) -> (u32, u8) {
    let base = match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
        'ç' | 'Ç' => 'c',
        'ñ' | 'Ñ' => return ('n' as u32, 1),
        other => other.to_lowercase().next().unwrap_or(other),
    };
    (base as u32, 0)
}

/// Spanish-friendly, case-insensitive text order.
pub fn collate(a: &str, b: &str) -> Ordering {
    let mut ia = a.chars().map(collate_key);
    let mut ib = b.chars().map(collate_key);
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
            }
        }
    }
}

/// Sort key of a cell: class (numbers, text, booleans, blanks) + value.
#[derive(Clone, Copy)]
struct Key {
    class: u8,
    value: f64,
}

fn sort(data: &mut Data, range: CellRange, keys: &[SortKey], has_header: bool, undo: &mut Vec<Undo>, out: &mut ApplyOutcome) -> EngineResult<()> {
    if keys.is_empty() {
        return Ok(());
    }
    let bound = data.row_bound();
    let start = range.r0 + u32::from(has_header);
    if bound == 0 || start >= bound || start > range.r1 {
        return Ok(());
    }
    let end = range.r1.min(bound - 1);
    let n = (end - start + 1) as usize;
    let ncols = data.ncols();
    // Key vectors (text ranked once per distinct string).
    let mut key_vecs: Vec<(Vec<Key>, bool)> = Vec::with_capacity(keys.len());
    for k in keys {
        if k.col < range.c0 || k.col > range.c1 {
            return Err(invalid("La columna de ordenación está fuera del rango."));
        }
        let mut ranks: HashMap<u32, f64> = HashMap::new();
        if let Some(column) = data.cols.get(k.col as usize) {
            let mut ids: Vec<u32> = Vec::new();
            for row in start..=end {
                if let Val::Text(id) = column.get(row) {
                    if let std::collections::hash_map::Entry::Vacant(e) = ranks.entry(id) {
                        e.insert(0.0);
                        ids.push(id);
                    }
                }
            }
            ids.sort_by(|a, b| collate(data.strings.get(*a), data.strings.get(*b)));
            let mut rank = 0.0;
            let mut prev: Option<&str> = None;
            for id in ids {
                let text = data.strings.get(id);
                if let Some(p) = prev {
                    if collate(p, text) != Ordering::Equal {
                        rank += 1.0;
                    }
                }
                prev = Some(text);
                ranks.insert(id, rank);
            }
        }
        let column = data.cols.get(k.col as usize);
        let vec: Vec<Key> = (start..=end)
            .map(|row| match column.map_or(Val::Empty, |c| c.get(row)) {
                Val::Num(v, _) => Key { class: 0, value: v },
                Val::Text(id) => Key { class: 1, value: ranks[&id] },
                Val::Bool(b) => Key { class: 2, value: f64::from(u8::from(b)) },
                Val::Empty => Key { class: 3, value: 0.0 },
            })
            .collect();
        key_vecs.push((vec, k.ascending));
    }
    let mut perm: Vec<u32> = (0..n as u32).collect();
    perm.sort_by(|a, b| {
        for (vec, asc) in &key_vecs {
            let x = vec[*a as usize];
            let y = vec[*b as usize];
            // Blanks always last, whatever the direction.
            let ord = match (x.class == 3, y.class == 3) {
                (true, true) => Ordering::Equal,
                (true, false) => return Ordering::Greater,
                (false, true) => return Ordering::Less,
                _ => {
                    let o = x.class.cmp(&y.class).then(x.value.total_cmp(&y.value));
                    if *asc {
                        o
                    } else {
                        o.reverse()
                    }
                }
            };
            if ord != Ordering::Equal {
                return ord;
            }
        }
        Ordering::Equal
    });
    if perm.iter().enumerate().all(|(i, p)| i as u32 == *p) {
        return Ok(());
    }
    let c1 = range.c1.min(ncols.saturating_sub(1));
    for col in range.c0..=c1 {
        if let Some(c) = data.cols.get_mut(col as usize) {
            c.permute(start, &perm);
        }
    }
    let mut inverse = vec![0u32; n];
    for (i, p) in perm.iter().enumerate() {
        inverse[*p as usize] = i as u32;
    }
    undo.push(Undo::Permute { start, c0: range.c0, c1, inverse });
    out.affected += n as u64 * u64::from(c1 - range.c0 + 1);
    out.selection = Some(SelectionHint { sheet: SHEET_ID, ranges: vec![range], active: CellAddress { row: range.r0, col: range.c0 } });
    out.events.push(cells_event(CellRange { r0: start, c0: range.c0, r1: end, c1 }));
    Ok(())
}
