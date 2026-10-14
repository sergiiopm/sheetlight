//! Read-side queries of the workbook backend: sheet info, blocks, cell
//! details, stats, data edges, samples, export.

use std::borrow::Cow;
use std::collections::{BinaryHeap, HashSet};

use ironcalc_base::types::{ArrayKind, Cell, Link, SheetState, Worksheet};

use super::display::{self, canonical_value_input, raw_value, RawValue};
use super::styles::{display_num_fmt, resolve_color, to_cell_style};
use super::units::{chars_to_px, points_to_px, DEFAULT_COL_PX, DEFAULT_ROW_PX};
use super::{ic_col, ic_row, parse_a1, WorkbookBackend};
use crate::engine::blocks::BlockCells;
use crate::engine::types::*;

/// Inclusive 1-based rectangle.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Rect {
    pub r0: i32,
    pub c0: i32,
    pub r1: i32,
    pub c1: i32,
}

impl Rect {
    fn contains(&self, row: i32, col: i32) -> bool {
        row >= self.r0 && row <= self.r1 && col >= self.c0 && col <= self.c1
    }

    fn intersects(&self, other: &Rect) -> bool {
        self.r0 <= other.r1 && other.r0 <= self.r1 && self.c0 <= other.c1 && other.c0 <= self.c1
    }
}

/// Parses an sqref (`A1:B5 D7`) into 1-based rectangles.
pub(crate) fn parse_sqref(sqref: &str) -> Vec<Rect> {
    sqref
        .split_whitespace()
        .filter_map(|part| {
            let mut ends = part.split(':');
            let a = parse_a1(ends.next()?)?;
            let b = ends.next().and_then(parse_a1).unwrap_or(a);
            Some(Rect {
                r0: a.0.min(b.0) as i32 + 1,
                c0: a.1.min(b.1) as i32 + 1,
                r1: a.0.max(b.0) as i32 + 1,
                c1: a.1.max(b.1) as i32 + 1,
            })
        })
        .collect()
}

/// Rows (1-based) between `r0` and `r1` that may hold cells, ascending.
pub(crate) fn rows_between(ws: &Worksheet, r0: i32, r1: i32) -> Vec<i32> {
    if r1 < r0 {
        return Vec::new();
    }
    if r1 - r0 < 2048 {
        return (r0..=r1).collect();
    }
    ws.sheet_data.rows().into_iter().filter(|r| *r >= r0 && *r <= r1).collect()
}

/// Hidden rows (1-based) of a sheet.
pub(crate) fn hidden_rows(ws: &Worksheet) -> HashSet<i32> {
    ws.rows.iter().filter(|r| r.hidden).map(|r| r.r).collect()
}

pub(crate) fn link_target(link: &Link) -> String {
    match link {
        Link::External { target, .. } => target.clone(),
        Link::Internal { location, .. } => format!("#{location}"),
    }
}

/// Largest used row/col (1-based) of a sheet, `None` when empty.
pub(crate) fn used_bounds(ws: &Worksheet) -> Option<Rect> {
    if ws.sheet_data.is_empty() {
        return None;
    }
    let dim = ws.dimension();
    Some(Rect { r0: dim.min_row, c0: dim.min_column, r1: dim.max_row, c1: dim.max_column })
}

impl WorkbookBackend {
    pub(crate) fn sheet_metas(&self) -> Vec<SheetMeta> {
        let model = self.model();
        model
            .workbook
            .worksheets
            .iter()
            .map(|ws| SheetMeta {
                id: ws.sheet_id,
                name: ws.name.clone(),
                hidden: ws.state != SheetState::Visible,
                color: resolve_color(&ws.color, &model.workbook.theme),
            })
            .collect()
    }

    pub(crate) fn sheet_info_impl(&self, sheet: SheetId) -> EngineResult<SheetInfo> {
        let ws = self.worksheet(sheet)?;
        let used_range = used_bounds(ws).map(|b| CellRange {
            r0: (b.r0 - 1) as u32,
            c0: (b.c0 - 1) as u32,
            r1: (b.r1 - 1) as u32,
            c1: (b.c1 - 1) as u32,
        });
        let mut row_overrides: Vec<AxisOverride> = ws
            .rows
            .iter()
            .filter(|r| r.custom_height || r.hidden)
            .map(|r| AxisOverride {
                index: (r.r - 1) as u32,
                size: r.custom_height.then(|| points_to_px(r.height)),
                hidden: r.hidden.then_some(true),
            })
            .collect();
        row_overrides.sort_by_key(|o| o.index);

        // A column range reaching the last column with a custom width is how
        // files set the sheet's default width.
        let mut default_col_width = DEFAULT_COL_PX;
        let mut col_overrides = Vec::new();
        for col in &ws.cols {
            if !(col.custom_width || col.hidden) {
                continue;
            }
            let span = col.max - col.min + 1;
            if col.max >= MAX_COLS as i32 && span > 256 && !col.hidden {
                default_col_width = chars_to_px(col.width);
                continue;
            }
            for index in col.min..=col.max.min(MAX_COLS as i32) {
                col_overrides.push(AxisOverride {
                    index: (index - 1) as u32,
                    size: col.custom_width.then(|| chars_to_px(col.width)),
                    hidden: col.hidden.then_some(true),
                });
            }
        }
        col_overrides.sort_by_key(|o| o.index);

        let merges = ws
            .merged_cells
            .iter()
            .map(|m| CellRange {
                r0: (m.row - 1) as u32,
                c0: (m.column - 1) as u32,
                r1: (m.last_row() - 1) as u32,
                c1: (m.last_column() - 1) as u32,
            })
            .collect();
        let auto_filter = self.extra(sheet).and_then(|e| e.filter.as_ref()).map(|f| AutoFilterInfo {
            range: f.range,
            filtered_cols: f.criteria.keys().copied().collect(),
        });
        Ok(SheetInfo {
            sheet,
            row_count: MAX_ROWS,
            col_count: MAX_COLS,
            default_row_height: DEFAULT_ROW_PX,
            default_col_width,
            used_range,
            row_overrides,
            col_overrides,
            merges,
            frozen_rows: ws.frozen_rows.max(0) as u32,
            frozen_cols: ws.frozen_columns.max(0) as u32,
            show_grid_lines: ws.show_grid_lines,
            auto_filter,
            version: self.info_version(sheet),
        })
    }

    pub(crate) fn write_block_impl(&self, sheet: SheetId, key: BlockKey, cells: &mut BlockCells) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        let model = self.model();
        let ws = &model.workbook.worksheets[sheet_index as usize];
        let r0 = (key.br * BLOCK_ROWS) as i32 + 1;
        let c0 = (key.bc * BLOCK_COLS) as i32 + 1;
        if r0 > MAX_ROWS as i32 || c0 > MAX_COLS as i32 {
            return Ok(());
        }
        let r1 = (r0 + BLOCK_ROWS as i32 - 1).min(MAX_ROWS as i32);
        let c1 = (c0 + BLOCK_COLS as i32 - 1).min(MAX_COLS as i32);
        let block = Rect { r0, c0, r1, c1 };
        let shared = &model.workbook.shared_strings;

        // Row / column styles apply to cells without an entry.
        let mut row_styles: Vec<(i32, i32)> = ws
            .rows
            .iter()
            .filter(|r| r.custom_format && r.s != 0 && r.r >= r0 && r.r <= r1)
            .map(|r| (r.r, r.s))
            .collect();
        row_styles.sort_unstable();
        let mut col_styles = [0i32; BLOCK_COLS as usize];
        let mut any_col_style = false;
        for col in &ws.cols {
            if let Some(style) = col.style.filter(|s| *s != 0) {
                for c in col.min.max(c0)..=col.max.min(c1) {
                    col_styles[(c - c0) as usize] = style;
                    any_col_style = true;
                }
            }
        }
        let cf_rects: Vec<Rect> = ws
            .conditional_formatting
            .iter()
            .flat_map(|cf| parse_sqref(&cf.range))
            .filter(|r| r.intersects(&block))
            .collect();
        let comments = self.extra(sheet).map(|e| &e.comments);

        let mut filled = [false; BLOCK_SIZE];
        for row in r0..=r1 {
            let base = ((row - r0) as usize) * BLOCK_COLS as usize;
            for (col, cell) in ws.sheet_data.cells_in_row_between(row, c0, c1) {
                let index = base + (col - c0) as usize;
                filled[index] = true;
                let xf = cell.get_style();
                let value = raw_value(&cell, shared);
                let info = self.xf_info(xf);
                let shown = display::display(&value, &info.num_fmt);
                let style_id = if !cf_rects.is_empty() && cf_rects.iter().any(|r| r.contains(row, col)) {
                    match model.get_extended_style_for_cell(sheet_index, row, col) {
                        Ok(ext) => self.render_style_id_for(&ext.style, shown.color),
                        Err(_) => self.render_style_id(xf, shown.color),
                    }
                } else {
                    self.render_style_id(xf, shown.color)
                };
                let mut flags = 0u8;
                match &*cell {
                    Cell::CellFormula { .. } => flags |= cell_flag::FORMULA,
                    Cell::ArrayFormula { r, kind, .. } => {
                        flags |= cell_flag::FORMULA;
                        if *kind == ArrayKind::Dynamic && (r.0 > 1 || r.1 > 1) {
                            flags |= cell_flag::SPILL;
                        }
                    }
                    Cell::SpillCell { .. } => flags |= cell_flag::SPILL,
                    _ => {}
                }
                if !ws.links.is_empty() && ws.links.contains_key(&(row, col)) {
                    flags |= cell_flag::HYPERLINK;
                }
                cells.set(index, &shown.text, value.kind(), style_id, flags);
            }
        }

        // Styled cells without an entry (row / column styles), comments and
        // conditional formats on empty cells.
        if !row_styles.is_empty() || any_col_style || !cf_rects.is_empty() {
            for row in r0..=r1 {
                let row_style = row_styles.iter().find(|(r, _)| *r == row).map(|(_, s)| *s);
                for col in c0..=c1 {
                    let index = ((row - r0) as usize) * BLOCK_COLS as usize + (col - c0) as usize;
                    if filled[index] {
                        continue;
                    }
                    let xf = row_style.unwrap_or(col_styles[(col - c0) as usize]);
                    let style_id = if cf_rects.iter().any(|r| r.contains(row, col)) {
                        match model.get_extended_style_for_cell(sheet_index, row, col) {
                            Ok(ext) => self.render_style_id_for(&ext.style, None),
                            Err(_) => self.render_style_id(xf, None),
                        }
                    } else if xf != 0 {
                        self.render_style_id(xf, None)
                    } else {
                        continue;
                    };
                    if style_id != 0 {
                        cells.set(index, "", CellKind::Empty, style_id, 0);
                        filled[index] = true;
                    }
                }
            }
        }
        if let Some(comments) = comments {
            let (rr0, rr1) = ((r0 - 1) as u32, (r1 - 1) as u32);
            let (cc0, cc1) = ((c0 - 1) as u32, (c1 - 1) as u32);
            for (&(row, col), _) in comments.range((rr0, 0)..=(rr1, u32::MAX)) {
                if col < cc0 || col > cc1 {
                    continue;
                }
                let index = ((row - rr0) * BLOCK_COLS + (col - cc0)) as usize;
                cells.add_flags(index, cell_flag::COMMENT);
            }
        }
        Ok(())
    }

    pub(crate) fn cell_details_impl(&self, sheet: SheetId, at: CellAddress) -> EngineResult<CellDetails> {
        let sheet_index = self.sheet_index(sheet)?;
        let model = self.model();
        let ws = &model.workbook.worksheets[sheet_index as usize];
        let (row, col) = (ic_row(at.row), ic_col(at.col));
        let cell = ws.cell(row, col);
        let xf = model.get_cell_style_index(sheet_index, row, col).unwrap_or(0);
        let info = self.xf_info(xf);
        let (input, value, display, spill_anchor) = match cell.as_deref() {
            None => (String::new(), CellValue::Empty, String::new(), None),
            Some(cell) => {
                let raw = raw_value(cell, &model.workbook.shared_strings);
                let display = display::display(&raw, &info.num_fmt).text.into_owned();
                let spill_anchor = match cell {
                    Cell::SpillCell { a, .. } => Some(CellAddress { row: (a.0 - 1) as u32, col: (a.1 - 1) as u32 }),
                    _ => None,
                };
                let input = if cell.has_formula() {
                    model.get_localized_cell_content(sheet_index, row, col).unwrap_or_default()
                } else if spill_anchor.is_some() {
                    String::new()
                } else {
                    canonical_value_input(&raw, info.quote_prefix)
                };
                (input, raw.to_contract(), display, spill_anchor)
            }
        };
        let style = model.workbook.styles.get_style(xf).unwrap_or_default();
        let format = CellFormat {
            style: to_cell_style(&style, &self.base_style, &model.workbook.theme, None),
            num_fmt: display_num_fmt(&style.num_fmt),
        };
        let merge = ws.merged_cell_containing(row, col).map(|m| CellRange {
            r0: (m.row - 1) as u32,
            c0: (m.column - 1) as u32,
            r1: (m.last_row() - 1) as u32,
            c1: (m.last_column() - 1) as u32,
        });
        let comment = self.extra(sheet).and_then(|e| e.comments.get(&(at.row, at.col)).cloned());
        let hyperlink = ws.links.get(&(row, col)).map(link_target);
        Ok(CellDetails {
            sheet,
            row: at.row,
            col: at.col,
            input,
            value,
            display,
            format,
            merge,
            spill_anchor,
            comment,
            hyperlink,
        })
    }

    /// Value + display of one cell (1-based), used by several queries.
    pub(crate) fn value_display(&self, ws: &Worksheet, row: i32, col: i32) -> (RawValue<'_>, String) {
        let model = self.model();
        match ws.sheet_data.cell(row, col) {
            None => (RawValue::Empty, String::new()),
            Some(cell) => {
                let info = self.xf_info(cell.get_style());
                let raw = to_static(raw_value(&cell, &model.workbook.shared_strings));
                let text = display::display(&raw, &info.num_fmt).text.into_owned();
                (raw, text)
            }
        }
    }

    pub(crate) fn range_values_impl(&self, sheet: SheetId, range: CellRange) -> EngineResult<RangeValues> {
        let ws = self.worksheet(sheet)?;
        let range = super::norm(range);
        let mut range = range;
        if let Some(bounds) = used_bounds(ws) {
            range.r1 = range.r1.min((bounds.r1 - 1).max(range.r0 as i32) as u32);
            range.c1 = range.c1.min((bounds.c1 - 1).max(range.c0 as i32) as u32);
        } else {
            range.r1 = range.r0;
            range.c1 = range.c0;
        }
        let mut values = Vec::new();
        let mut display = Vec::new();
        for row in range.r0..=range.r1 {
            let mut value_row = Vec::new();
            let mut display_row = Vec::new();
            for col in range.c0..=range.c1 {
                let (raw, text) = self.value_display(ws, ic_row(row), ic_col(col));
                value_row.push(raw.to_contract());
                display_row.push(text);
            }
            values.push(value_row);
            display.push(display_row);
        }
        Ok(RangeValues { range, values, display })
    }

    pub(crate) fn selection_stats_impl(&self, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<SelectionStats> {
        let ws = self.worksheet(sheet)?;
        let shared = &self.model().workbook.shared_strings;
        let filtered = self.extra(sheet).and_then(|e| e.filter.as_ref()).is_some_and(|f| !f.criteria.is_empty());
        let hidden = if filtered { hidden_rows(ws) } else { HashSet::new() };
        let mut stats = SelectionStats::default();
        let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
        for range in ranges {
            let range = super::norm(*range);
            let (c0, c1) = (ic_col(range.c0), ic_col(range.c1));
            for row in rows_between(ws, ic_row(range.r0), ic_row(range.r1)) {
                if filtered && hidden.contains(&row) {
                    continue;
                }
                if let Some(numbers) = ws.sheet_data.numbers_in_row_between(row, c0, c1) {
                    for n in numbers {
                        stats.count += 1;
                        stats.numeric_count += 1;
                        stats.sum += n;
                        min = min.min(*n);
                        max = max.max(*n);
                    }
                    continue;
                }
                for (_, cell) in ws.sheet_data.cells_in_row_between(row, c0, c1) {
                    match raw_value(&cell, shared) {
                        RawValue::Empty => {}
                        RawValue::Number(n) => {
                            stats.count += 1;
                            stats.numeric_count += 1;
                            stats.sum += n;
                            min = min.min(n);
                            max = max.max(n);
                        }
                        _ => stats.count += 1,
                    }
                }
            }
        }
        if stats.numeric_count > 0 {
            stats.average = Some(stats.sum / stats.numeric_count as f64);
            stats.min = Some(min);
            stats.max = Some(max);
        }
        Ok(stats)
    }

    /// Excel Ctrl+Arrow: from a non-empty cell whose neighbour is non-empty,
    /// go to the last non-empty cell of the run; otherwise go to the next
    /// non-empty cell, or to the sheet edge. Hidden rows/columns are skipped.
    pub(crate) fn find_data_edge_impl(&self, sheet: SheetId, from: CellAddress, dir: Direction) -> EngineResult<CellAddress> {
        let ws = self.worksheet(sheet)?;
        let shared = &self.model().workbook.shared_strings;
        let vertical = matches!(dir, Direction::Up | Direction::Down);
        let forward = matches!(dir, Direction::Down | Direction::Right);
        let (row, col) = (ic_row(from.row), ic_col(from.col));
        let limit = if vertical { MAX_ROWS as i32 } else { MAX_COLS as i32 };

        // Start at the far edge of a merged cell.
        let mut start = if vertical { row } else { col };
        if let Some(m) = ws.merged_cell_containing(row, col) {
            start = match dir {
                Direction::Up => m.row,
                Direction::Down => m.last_row(),
                Direction::Left => m.column,
                Direction::Right => m.last_column(),
            };
        }
        let non_empty = |pos: i32| -> bool {
            let (r, c) = if vertical { (pos, col) } else { (row, pos) };
            let (ar, ac) = ws.merge_anchor(r, c);
            ws.sheet_data
                .cell(ar, ac)
                .is_some_and(|cell| !raw_value(&cell, shared).is_empty())
        };
        // Positions that can hold data on this line, plus merged cells.
        let mut candidates: Vec<i32> = if vertical {
            ws.sheet_data.rows().into_iter().filter(|r| ws.sheet_data.cell(*r, col).is_some()).collect()
        } else {
            ws.sheet_data.columns_in_row(row)
        };
        for m in &ws.merged_cells {
            if vertical && m.column <= col && col <= m.last_column() {
                candidates.extend(m.row..=m.last_row());
            } else if !vertical && m.row <= row && row <= m.last_row() {
                candidates.extend(m.column..=m.last_column());
            }
        }
        candidates.sort_unstable();
        candidates.dedup();
        let hidden: HashSet<i32> = if vertical {
            hidden_rows(ws)
        } else {
            ws.cols.iter().filter(|c| c.hidden).flat_map(|c| c.min..=c.max).collect()
        };
        let visible = |pos: i32| !hidden.contains(&pos);
        let step = |pos: i32| -> Option<i32> {
            let mut p = pos;
            loop {
                p = if forward { p + 1 } else { p - 1 };
                if p < 1 || p > limit {
                    return None;
                }
                if visible(p) {
                    return Some(p);
                }
            }
        };
        let result = match step(start) {
            None => start,
            Some(next) => {
                if non_empty(start) && non_empty(next) {
                    // Last non-empty of the run.
                    let mut last = next;
                    while let Some(p) = step(last) {
                        if non_empty(p) {
                            last = p;
                        } else {
                            break;
                        }
                    }
                    last
                } else {
                    // Next non-empty cell after `start`, or the edge.
                    let found = if forward {
                        let from = candidates.partition_point(|p| *p <= start);
                        candidates[from..].iter().copied().find(|p| visible(*p) && non_empty(*p))
                    } else {
                        let to = candidates.partition_point(|p| *p < start);
                        candidates[..to].iter().rev().copied().find(|p| visible(*p) && non_empty(*p))
                    };
                    match found {
                        Some(p) => p,
                        None => {
                            // Edge: last visible position in that direction.
                            let mut edge = if forward { limit } else { 1 };
                            while !visible(edge) && edge != start {
                                edge = if forward { edge - 1 } else { edge + 1 };
                            }
                            edge
                        }
                    }
                }
            }
        };
        let (r, c) = if vertical { (result, col) } else { (row, result) };
        let (r, c) = ws.merge_anchor(r, c);
        Ok(CellAddress { row: (r - 1) as u32, col: (c - 1) as u32 })
    }

    pub(crate) fn column_text_samples_impl(&self, sheet: SheetId, col: u32, limit: u32) -> EngineResult<Vec<TextSample>> {
        let ws = self.worksheet(sheet)?;
        let model = self.model();
        let c = ic_col(col);
        let rows: Vec<i32> = ws.sheet_data.rows();
        // Above ~100k rows, numbers are sampled (text cells are always measured).
        let stride = (rows.len() / 100_000).max(1);
        let mut heap: BinaryHeap<std::cmp::Reverse<(usize, i32)>> = BinaryHeap::new();
        let limit = limit.clamp(1, 1000) as usize;
        for (i, row) in rows.iter().enumerate() {
            let Some(cell) = ws.sheet_data.cell(*row, c) else { continue };
            let raw = raw_value(&cell, &model.workbook.shared_strings);
            let len = match &raw {
                RawValue::Empty => continue,
                RawValue::Text(t) => t.chars().count(),
                _ => {
                    if i % stride != 0 {
                        continue;
                    }
                    let info = self.xf_info(cell.get_style());
                    display::display(&raw, &info.num_fmt).text.chars().count()
                }
            };
            heap.push(std::cmp::Reverse((len, *row)));
            if heap.len() > limit {
                heap.pop();
            }
        }
        let mut picked: Vec<(usize, i32)> = heap.into_iter().map(|r| r.0).collect();
        picked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut out = Vec::with_capacity(picked.len());
        for (_, row) in picked {
            let Some(cell) = ws.sheet_data.cell(row, c) else { continue };
            let xf = cell.get_style();
            let info = self.xf_info(xf);
            let raw = raw_value(&cell, &model.workbook.shared_strings);
            let shown = display::display(&raw, &info.num_fmt);
            let style_id = self.render_style_id(xf, shown.color);
            out.push(TextSample { text: shown.text.into_owned(), style_id });
        }
        Ok(out)
    }

    /// Canonical input of an existing cell (formula en-US or value).
    pub(crate) fn cell_input(&self, sheet_index: u32, ws: &Worksheet, row: i32, col: i32) -> String {
        let model = self.model();
        match ws.sheet_data.cell(row, col) {
            None => String::new(),
            Some(cell) => {
                if cell.has_formula() {
                    model.get_localized_cell_content(sheet_index, row, col).unwrap_or_default()
                } else if matches!(&*cell, Cell::SpillCell { .. }) {
                    String::new()
                } else {
                    let info = self.xf_info(cell.get_style());
                    canonical_value_input(&raw_value(&cell, &model.workbook.shared_strings), info.quote_prefix)
                }
            }
        }
    }

    pub(crate) fn export_cells_impl(&self, sheet: SheetId, visit: &mut dyn FnMut(u32, u32, &str)) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        let ws = &self.model().workbook.worksheets[sheet_index as usize];
        for (row, col, cell) in ws.sheet_data.cells() {
            if matches!(&*cell, Cell::EmptyCell { .. } | Cell::SpillCell { .. }) {
                continue;
            }
            let input = self.cell_input(sheet_index, ws, row, col);
            if !input.is_empty() {
                visit((row - 1) as u32, (col - 1) as u32, &input);
            }
        }
        Ok(())
    }

    pub(crate) fn write_csv_impl(&self, sheet: SheetId, out: &mut dyn std::io::Write, options: &CsvOptions) -> EngineResult<()> {
        let ws = self.worksheet(sheet)?;
        let delimiter = options.delimiter.as_deref().and_then(|d| d.bytes().next()).unwrap_or(b';');
        let dot_decimal = options.decimal.as_deref() == Some(".");
        let en = ironcalc_base::locale::get_locale("en").ok();
        let shared = &self.model().workbook.shared_strings;
        let mut writer = csv::WriterBuilder::new()
            .delimiter(delimiter)
            .terminator(csv::Terminator::CRLF)
            .from_writer(out);
        let io_err = |e: csv::Error| EngineError::io(format!("No se pudo escribir el CSV: {e}"));
        if let Some(bounds) = used_bounds(ws) {
            let width = bounds.c1.max(1) as usize;
            let mut record: Vec<String> = vec![String::new(); width];
            for row in 1..=bounds.r1 {
                for field in record.iter_mut() {
                    field.clear();
                }
                for (col, cell) in ws.sheet_data.cells_in_row_between(row, 1, bounds.c1) {
                    let raw = raw_value(&cell, shared);
                    let info = self.xf_info(cell.get_style());
                    let text: Cow<'_, str> = match (&raw, dot_decimal, en) {
                        (RawValue::Number(n), true, Some(en)) => {
                            Cow::Owned(ironcalc_base::formatter::format::format_number(*n, &info.num_fmt, en).text)
                        }
                        _ => display::display(&raw, &info.num_fmt).text,
                    };
                    record[(col - 1) as usize] = text.into_owned();
                }
                writer.write_record(&record).map_err(io_err)?;
            }
        }
        writer.flush().map_err(|e| EngineError::io(format!("No se pudo escribir el CSV: {e}")))?;
        Ok(())
    }
}

fn to_static(value: RawValue<'_>) -> RawValue<'static> {
    match value {
        RawValue::Empty => RawValue::Empty,
        RawValue::Number(n) => RawValue::Number(n),
        RawValue::Bool(b) => RawValue::Bool(b),
        RawValue::Error(e) => RawValue::Error(e),
        RawValue::Text(t) => RawValue::Text(Cow::Owned(t.into_owned())),
    }
}
