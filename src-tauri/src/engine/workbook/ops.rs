//! `EngineOp` dispatch and the write primitives shared by the ops.

use ironcalc_base::expressions::parser::Node;
use ironcalc_base::types::{Cell, Link, Style};

use super::display::{parse_canonical, Parsed};
use super::history::Batch;
use super::queries::used_bounds;
use super::styles::{self, apply_patch, patch_to_paths};
use super::units::{px_to_ic_col, px_to_ic_row, DEFAULT_COL_PX, DEFAULT_ROW_PX};
use super::{area, full_cols, full_rows, ic_col, ic_row, norm, WorkbookBackend};
use crate::engine::types::*;

pub(crate) fn invalid(message: &str) -> EngineError {
    EngineError::new(EngineErrorCode::InvalidOp, message)
}

/// Contiguous runs of sorted, deduplicated indices.
pub(crate) fn runs(indices: &[u32]) -> Vec<(u32, u32)> {
    let mut sorted: Vec<u32> = indices.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out: Vec<(u32, u32)> = Vec::new();
    for i in sorted {
        match out.last_mut() {
            Some((_, end)) if *end + 1 == i => *end = i,
            _ => out.push((i, i)),
        }
    }
    out
}

impl WorkbookBackend {
    pub(crate) fn apply_op(&mut self, op: &EngineOp, b: &mut Batch) -> EngineResult<()> {
        match op {
            EngineOp::SetCells { sheet, cells } => self.op_set_cells(b, *sheet, cells),
            EngineOp::Clear { sheet, ranges, what } => self.op_clear(b, *sheet, ranges, *what),
            EngineOp::Fill { sheet, source, target } => self.op_fill(b, *sheet, norm(*source), norm(*target)),
            EngineOp::Paste { sheet, target, source, mode } => self.op_paste(b, *sheet, norm(*target), source, *mode),
            EngineOp::Sort { sheet, range, keys, has_header } => self.op_sort(b, *sheet, norm(*range), keys, *has_header),
            EngineOp::Replace { query, replacement, all, at } => self.op_replace(b, query, replacement, *all, at.as_ref()),
            EngineOp::SetComment { sheet, row, col, text } => self.op_set_comment(b, *sheet, *row, *col, text.as_deref()),
            EngineOp::SetHyperlink { sheet, row, col, url } => self.op_set_hyperlink(b, *sheet, *row, *col, url.as_deref()),
            EngineOp::SetStyle { sheet, ranges, patch } => self.op_set_style(b, *sheet, ranges, patch),
            EngineOp::SetBorders { sheet, ranges, preset, style, color } => {
                self.op_set_borders(b, *sheet, ranges, *preset, *style, color)
            }
            EngineOp::CopyFormat { sheet, source, targets } => self.op_copy_format(b, *sheet, norm(*source), targets),
            EngineOp::Merge { sheet, range, mode } => self.op_merge(b, *sheet, norm(*range), *mode),
            EngineOp::Unmerge { sheet, ranges } => self.op_unmerge(b, *sheet, ranges),
            EngineOp::InsertRows { sheet, index, count } => self.op_insert_delete(b, *sheet, Axis::Row, true, *index, *count),
            EngineOp::DeleteRows { sheet, index, count } => self.op_insert_delete(b, *sheet, Axis::Row, false, *index, *count),
            EngineOp::InsertCols { sheet, index, count } => self.op_insert_delete(b, *sheet, Axis::Col, true, *index, *count),
            EngineOp::DeleteCols { sheet, index, count } => self.op_insert_delete(b, *sheet, Axis::Col, false, *index, *count),
            EngineOp::InsertCells { sheet, range, shift } => self.op_shift_cells(b, *sheet, norm(*range), *shift, true),
            EngineOp::DeleteCells { sheet, range, shift } => self.op_shift_cells(b, *sheet, norm(*range), *shift, false),
            EngineOp::SetRowHeights { sheet, rows, size } => self.op_sizes(b, *sheet, Axis::Row, rows, *size),
            EngineOp::SetColWidths { sheet, cols, size } => self.op_sizes(b, *sheet, Axis::Col, cols, *size),
            EngineOp::SetHidden { sheet, axis, indices, hidden } => self.op_hidden(b, *sheet, *axis, indices, *hidden),
            EngineOp::SetFrozen { sheet, rows, cols } => self.op_frozen(b, *sheet, *rows, *cols),
            EngineOp::SetShowGridLines { sheet, show } => {
                let index = self.sheet_index(*sheet)?;
                self.ic(b, |um| um.set_show_grid_lines(index, *show))?;
                b.scope.info.insert(*sheet);
                Ok(())
            }
            EngineOp::AddSheet { name, index } => self.op_add_sheet(b, name.as_deref(), *index),
            EngineOp::DeleteSheet { sheet } => self.op_delete_sheet(b, *sheet),
            EngineOp::RenameSheet { sheet, name } => self.op_rename_sheet(b, *sheet, name),
            EngineOp::MoveSheet { sheet, index } => self.op_move_sheet(b, *sheet, *index),
            EngineOp::DuplicateSheet { sheet } => self.op_duplicate_sheet(b, *sheet),
            EngineOp::SetSheetHidden { sheet, hidden } => self.op_sheet_hidden(b, *sheet, *hidden),
            EngineOp::SetSheetColor { sheet, color } => self.op_sheet_color(b, *sheet, color.as_deref()),
            EngineOp::SetActiveSheet { sheet } => {
                self.sheet_index(*sheet)?;
                b.active = Some(*sheet);
                Ok(())
            }
            EngineOp::SetAutoFilter { sheet, range } => self.op_set_auto_filter(b, *sheet, range.map(norm)),
            EngineOp::FilterColumn { sheet, col, criteria } => self.op_filter_column(b, *sheet, *col, criteria.as_ref()),
            EngineOp::AddChart { chart } => self.op_add_chart(b, chart),
            EngineOp::UpdateChart { chart } => self.op_update_chart(b, chart),
            EngineOp::DeleteChart { sheet, id } => self.op_delete_chart(b, *sheet, *id),
        }
    }

    // ----- primitives --------------------------------------------------------

    /// Whether IronCalc would read `text` as something other than plain text
    /// (number, date, percent, currency, boolean, error, formula).
    pub(crate) fn text_needs_quote(&self, text: &str) -> bool {
        let trimmed = text.trim_start();
        let Some(first) = trimmed.chars().next() else { return false };
        let suspicious = first.is_ascii_digit()
            || "+-=.,$€(#%".contains(first)
            || trimmed.eq_ignore_ascii_case("true")
            || trimmed.eq_ignore_ascii_case("false")
            || trimmed.ends_with('%')
            || trimmed.ends_with('€')
            || trimmed.ends_with('$');
        if !suspicious {
            return false;
        }
        let mut scratch = self.scratch.borrow_mut();
        if scratch.set_user_input(0, 1, 1, text.to_string()).is_err() {
            return true;
        }
        let plain = match scratch.workbook.worksheets[0].cell(1, 1).as_deref() {
            Some(Cell::SharedString { s, .. }) => super::styles::style_at(&scratch.workbook.styles, *s).map(|st| !st.quote_prefix).unwrap_or(false),
            _ => false,
        };
        let _ = scratch.set_user_input(0, 1, 1, String::new());
        !plain
    }

    /// Canonical contract input → what to pass to IronCalc's `set_user_input`.
    pub(crate) fn ic_input(&self, input: &str) -> String {
        match parse_canonical(input) {
            Parsed::Empty => String::new(),
            Parsed::Formula(f) => f.to_string(),
            Parsed::Number(n) => plain_number(n),
            Parsed::Bool(true) => "TRUE".to_string(),
            Parsed::Bool(false) => "FALSE".to_string(),
            Parsed::Error(e) => e.to_ascii_uppercase(),
            Parsed::Text { text, forced } => {
                if forced || self.text_needs_quote(text) {
                    format!("'{text}")
                } else {
                    text.to_string()
                }
            }
        }
    }

    /// Writes one cell (1-based) from a canonical input; rejects broken formulas.
    pub(crate) fn write_input(&mut self, b: &mut Batch, sheet_index: u32, row: i32, col: i32, input: &str) -> EngineResult<()> {
        let value = self.ic_input(input);
        let is_formula = value.starts_with('=');
        self.ic(b, |um| um.set_user_input(sheet_index, row, col, &value))?;
        if is_formula && self.has_parse_error(sheet_index, row, col) {
            return Err(EngineError::new(EngineErrorCode::InvalidFormula, "Hay un problema con esta fórmula."));
        }
        Ok(())
    }

    /// Writes an IronCalc-ready input (already shifted / quoted).
    pub(crate) fn write_raw(&mut self, b: &mut Batch, sheet_index: u32, row: i32, col: i32, value: &str) -> EngineResult<()> {
        self.ic(b, |um| um.set_user_input(sheet_index, row, col, value))
    }

    fn has_parse_error(&self, sheet_index: u32, row: i32, col: i32) -> bool {
        let model = self.model();
        let Some(index) = model.workbook.worksheets[sheet_index as usize].cell(row, col).and_then(|c| c.get_formula()) else {
            return false;
        };
        model
            .parsed_formulas
            .get(sheet_index as usize)
            .and_then(|f| f.get(index as usize))
            .is_some_and(|(node, _)| matches!(**node, Node::ParseErrorKind { .. }))
    }

    /// Selects a range on a sheet (IronCalc paste/style APIs act on the selection).
    pub(crate) fn select(&mut self, sheet_index: u32, range: CellRange) -> EngineResult<()> {
        let um = &mut self.um;
        um.set_selected_sheet(sheet_index).map_err(super::ic_error)?;
        um.set_selected_cell(ic_row(range.r0), ic_col(range.c0)).map_err(super::ic_error)?;
        um.set_selected_range(ic_row(range.r0), ic_col(range.c0), ic_row(range.r1), ic_col(range.c1))
            .map_err(super::ic_error)
    }

    /// Rewrites the full style of every cell of `range` (grown over merged
    /// cells) as one IronCalc step. `f(row, col, style)` gets 0-based coords.
    pub(crate) fn write_styles(
        &mut self,
        b: &mut Batch,
        sheet_index: u32,
        range: CellRange,
        mut f: impl FnMut(u32, u32, &mut Style) -> EngineResult<()>,
    ) -> EngineResult<CellRange> {
        self.select(sheet_index, range)?;
        let [r0, c0, r1, c1] = self.um.get_selected_view().range;
        let mut matrix = Vec::with_capacity((r1 - r0 + 1) as usize);
        {
            let model = self.model();
            for row in r0..=r1 {
                let mut line = Vec::with_capacity((c1 - c0 + 1) as usize);
                for col in c0..=c1 {
                    let mut style = model.get_style_for_cell(sheet_index, row, col).map_err(super::ic_error)?;
                    f((row - 1) as u32, (col - 1) as u32, &mut style)?;
                    line.push(style);
                }
                matrix.push(line);
            }
        }
        self.ic(b, |um| um.on_paste_styles(&matrix))?;
        Ok(CellRange { r0: (r0 - 1) as u32, c0: (c0 - 1) as u32, r1: (r1 - 1) as u32, c1: (c1 - 1) as u32 })
    }

    /// Clamps a range to the used area of a sheet (for content operations on
    /// whole rows/columns). `None` when nothing is used there.
    pub(crate) fn clamp_to_used(&self, sheet: SheetId, range: CellRange) -> EngineResult<Option<CellRange>> {
        let ws = self.worksheet(sheet)?;
        let Some(bounds) = used_bounds(ws) else { return Ok(None) };
        let r1 = range.r1.min((bounds.r1 - 1) as u32);
        let c1 = range.c1.min((bounds.c1 - 1) as u32);
        if r1 < range.r0 || c1 < range.c0 {
            return Ok(None);
        }
        Ok(Some(CellRange { r0: range.r0, c0: range.c0, r1, c1 }))
    }

    // ----- cells ---------------------------------------------------------------

    fn op_set_cells(&mut self, b: &mut Batch, sheet: SheetId, cells: &[CellInput]) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let mut bounds: Option<CellRange> = None;
        for cell in cells {
            if cell.row >= MAX_ROWS || cell.col >= MAX_COLS {
                return Err(invalid("La celda está fuera de la hoja."));
            }
            let (row, col) = (ic_row(cell.row), ic_col(cell.col));
            self.write_input(b, index, row, col, &cell.input)?;
            if let Some(fmt) = &cell.num_fmt {
                let one = CellRange { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
                let fmt = styles::normalize_num_fmt(fmt);
                self.ic(b, |um| um.update_range_style(&area(index, &one), "num_fmt", &fmt))?;
            }
            let one = CellRange { r0: cell.row, c0: cell.col, r1: cell.row, c1: cell.col };
            bounds = Some(match bounds {
                None => one,
                Some(r) => CellRange { r0: r.r0.min(one.r0), c0: r.c0.min(one.c0), r1: r.r1.max(one.r1), c1: r.c1.max(one.c1) },
            });
            b.affected += 1;
        }
        if let Some(range) = bounds {
            b.cells(sheet, range);
            b.select(sheet, vec![range]);
        }
        Ok(())
    }

    fn op_clear(&mut self, b: &mut Batch, sheet: SheetId, ranges: &[CellRange], what: ClearWhat) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        for range in ranges {
            let range = norm(*range);
            let whole = full_cols(&range) || full_rows(&range);
            match what {
                ClearWhat::Contents | ClearWhat::All => {
                    if let Some(used) = self.clamp_to_used(sheet, range)? {
                        if what == ClearWhat::All && !whole {
                            self.ic(b, |um| um.range_clear_all(&area(index, &used)))?;
                        } else {
                            self.ic(b, |um| um.range_clear_contents(&area(index, &used)))?;
                        }
                        b.affected += u64::from(used.r1 - used.r0 + 1) * u64::from(used.c1 - used.c0 + 1);
                    }
                    if what == ClearWhat::All {
                        if whole {
                            self.ic(b, |um| um.range_clear_formatting(&area(index, &range)))?;
                        }
                        self.extra_mut(sheet).comments.retain(|(r, c), _| !range.contains(*r, *c));
                        b.data(sheet);
                    }
                }
                ClearWhat::Formats => {
                    let target = if whole { range } else { self.clamp_styles(sheet, range)? };
                    self.ic(b, |um| um.range_clear_formatting(&area(index, &target)))?;
                }
                ClearWhat::Comments => {
                    self.extra_mut(sheet).comments.retain(|(r, c), _| !range.contains(*r, *c));
                }
                ClearWhat::Hyperlinks => {
                    let links: Vec<(i32, i32)> = self
                        .worksheet(sheet)?
                        .links
                        .keys()
                        .copied()
                        .filter(|(r, c)| range.contains((*r - 1) as u32, (*c - 1) as u32))
                        .collect();
                    for (r, c) in links {
                        self.ic(b, |um| um.delete_cell_link(index, r, c))?;
                    }
                }
            }
            match (what, whole) {
                (ClearWhat::Contents | ClearWhat::All, true) => b.data(sheet),
                (ClearWhat::Contents | ClearWhat::All, false) => b.cells(sheet, range),
                (_, true) => {
                    b.scope.data.insert(sheet);
                }
                (_, false) => b.style(sheet, range),
            }
        }
        b.select(sheet, ranges.iter().map(|r| norm(*r)).collect());
        Ok(())
    }

    /// For format clearing on large non-whole ranges, only styled cells matter.
    fn clamp_styles(&self, sheet: SheetId, range: CellRange) -> EngineResult<CellRange> {
        let cells = u64::from(range.r1 - range.r0 + 1) * u64::from(range.c1 - range.c0 + 1);
        if cells <= 200_000 {
            return Ok(range);
        }
        Ok(self.clamp_to_used(sheet, range)?.unwrap_or(CellRange { r1: range.r0, c1: range.c0, ..range }))
    }

    fn op_set_comment(&mut self, b: &mut Batch, sheet: SheetId, row: u32, col: u32, text: Option<&str>) -> EngineResult<()> {
        self.sheet_index(sheet)?;
        let extra = self.extra_mut(sheet);
        match text {
            Some(text) if !text.is_empty() => {
                extra.comments.insert((row, col), text.to_string());
            }
            _ => {
                extra.comments.remove(&(row, col));
            }
        }
        let one = CellRange { r0: row, c0: col, r1: row, c1: col };
        b.style(sheet, one);
        b.select(sheet, vec![one]);
        Ok(())
    }

    fn op_set_hyperlink(&mut self, b: &mut Batch, sheet: SheetId, row: u32, col: u32, url: Option<&str>) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let (r, c) = (ic_row(row), ic_col(col));
        match url.map(str::trim).filter(|u| !u.is_empty()) {
            Some(url) => {
                let link = match url.strip_prefix('#') {
                    Some(location) => Link::Internal { location: location.to_string(), tooltip: None },
                    None => Link::External { target: url.to_string(), tooltip: None },
                };
                let empty = self.worksheet(sheet)?.cell(r, c).is_none();
                let label = empty.then(|| url.to_string());
                self.ic(b, |um| um.set_cell_link(index, r, c, link, label.as_deref()))?;
            }
            None => {
                self.ic(b, |um| um.delete_cell_link(index, r, c))?;
            }
        }
        let one = CellRange { r0: row, c0: col, r1: row, c1: col };
        b.cells(sheet, one);
        b.select(sheet, vec![one]);
        Ok(())
    }

    // ----- formatting ----------------------------------------------------------

    fn op_set_style(&mut self, b: &mut Batch, sheet: SheetId, ranges: &[CellRange], patch: &StylePatch) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let base = self.base_style.clone();
        for range in ranges {
            let range = norm(*range);
            match patch_to_paths(patch, &base) {
                Some(paths) => {
                    let target = area(index, &range);
                    for (path, value) in paths {
                        self.ic(b, |um| um.update_range_style(&target, path, &value))?;
                    }
                }
                None => {
                    let target = if full_cols(&range) || full_rows(&range) {
                        match self.clamp_to_used(sheet, range)? {
                            Some(r) => r,
                            None => continue,
                        }
                    } else {
                        range
                    };
                    let mut error = None;
                    self.write_styles(b, index, target, |_, _, style| {
                        if let Err(e) = apply_patch(style, patch, &base) {
                            error = Some(e);
                        }
                        Ok(())
                    })?;
                    if let Some(e) = error {
                        return Err(invalid(&e));
                    }
                }
            }
            if full_cols(&range) || full_rows(&range) {
                b.scope.data.insert(sheet);
            } else {
                b.style(sheet, range);
            }
        }
        b.select(sheet, ranges.iter().map(|r| norm(*r)).collect());
        Ok(())
    }

    fn op_set_borders(
        &mut self,
        b: &mut Batch,
        sheet: SheetId,
        ranges: &[CellRange],
        preset: BorderPreset,
        style: BorderStyle,
        color: &str,
    ) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let color = styles::color_in(color).map_err(|e| invalid(&e))?;
        let (kind, style) = match preset {
            BorderPreset::All => ("All", style),
            BorderPreset::Outer => ("Outer", style),
            BorderPreset::Inner => ("Inner", style),
            BorderPreset::InnerHorizontal => ("CenterH", style),
            BorderPreset::InnerVertical => ("CenterV", style),
            BorderPreset::Top => ("Top", style),
            BorderPreset::Bottom => ("Bottom", style),
            BorderPreset::Left => ("Left", style),
            BorderPreset::Right => ("Right", style),
            BorderPreset::ThickOuter => ("Outer", BorderStyle::Thick),
            BorderPreset::DoubleBottom => ("Bottom", BorderStyle::Double),
            BorderPreset::None => ("None", style),
        };
        let item = ironcalc_base::types::BorderItem { style: styles::border_style_in(style), color };
        let border_area: ironcalc_base::BorderArea = serde_json::from_value(serde_json::json!({
            "item": item,
            "type": kind,
        }))
        .map_err(|e| EngineError::internal(format!("Borde no válido: {e}")))?;
        for range in ranges {
            let range = norm(*range);
            self.ic(b, |um| um.set_area_with_border(&area(index, &range), &border_area))?;
            // Borders also change the neighbours' adjacent edges.
            let grown = CellRange {
                r0: range.r0.saturating_sub(1),
                c0: range.c0.saturating_sub(1),
                r1: (range.r1 + 1).min(MAX_ROWS - 1),
                c1: (range.c1 + 1).min(MAX_COLS - 1),
            };
            if full_cols(&range) || full_rows(&range) {
                b.scope.data.insert(sheet);
            } else {
                b.style(sheet, grown);
            }
        }
        b.select(sheet, ranges.iter().map(|r| norm(*r)).collect());
        Ok(())
    }

    /// Format painter: the source styles tile each target (a single-cell
    /// target takes the size of the source).
    fn op_copy_format(&mut self, b: &mut Batch, sheet: SheetId, source: CellRange, targets: &[CellRange]) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let (h, w) = (source.r1 - source.r0 + 1, source.c1 - source.c0 + 1);
        let mut pattern = Vec::with_capacity((h * w) as usize);
        {
            let model = self.model();
            for row in source.r0..=source.r1 {
                for col in source.c0..=source.c1 {
                    pattern.push(model.get_style_for_cell(index, ic_row(row), ic_col(col)).map_err(super::ic_error)?);
                }
            }
        }
        let mut done = Vec::new();
        for target in targets {
            let mut target = norm(*target);
            if target.r0 == target.r1 && target.c0 == target.c1 {
                target.r1 = (target.r0 + h - 1).min(MAX_ROWS - 1);
                target.c1 = (target.c0 + w - 1).min(MAX_COLS - 1);
            }
            if full_cols(&target) || full_rows(&target) {
                target = match self.clamp_to_used(sheet, target)? {
                    Some(t) => t,
                    None => continue,
                };
            }
            let (t0, tc0) = (target.r0, target.c0);
            let written = self.write_styles(b, index, target, |row, col, style| {
                let dr = (row.wrapping_sub(t0)) % h;
                let dc = (col.wrapping_sub(tc0)) % w;
                *style = pattern[(dr * w + dc) as usize].clone();
                Ok(())
            })?;
            b.style(sheet, written);
            done.push(written);
        }
        b.select(sheet, done);
        Ok(())
    }

    fn op_merge(&mut self, b: &mut Batch, sheet: SheetId, range: CellRange, mode: MergeMode) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        if range.r0 == range.r1 && range.c0 == range.c1 {
            return Ok(());
        }
        // Like Excel, merging keeps only the first value (per row for "across").
        let groups: Vec<CellRange> = if mode == MergeMode::MergeAcross {
            (range.r0..=range.r1).map(|r| CellRange { r0: r, r1: r, ..range }).collect()
        } else {
            vec![range]
        };
        for group in &groups {
            let mut first = true;
            let mut extra = Vec::new();
            {
                let ws = self.worksheet(sheet)?;
                let shared = &self.model().workbook.shared_strings;
                for row in group.r0..=group.r1 {
                    for (col, cell) in ws.sheet_data.cells_in_row_between(ic_row(row), ic_col(group.c0), ic_col(group.c1)) {
                        if super::display::raw_value(&cell, shared).is_empty() && !cell.has_formula() {
                            continue;
                        }
                        if first {
                            first = false;
                        } else {
                            extra.push(CellRange { r0: row, c0: (col - 1) as u32, r1: row, c1: (col - 1) as u32 });
                        }
                    }
                }
            }
            for cell in extra {
                self.ic(b, |um| um.range_clear_contents(&area(index, &cell)))?;
            }
        }
        self.ic(b, |um| um.unmerge_cells(&area(index, &range)))?;
        let target = area(index, &range);
        match mode {
            MergeMode::Merge => self.ic(b, |um| um.merge_cells(&target))?,
            MergeMode::MergeCenter => self.ic(b, |um| um.merge_cells_center(&target))?,
            MergeMode::MergeAcross => {
                if range.c0 == range.c1 {
                    return Ok(());
                }
                self.ic(b, |um| um.merge_cells_across(&target))?
            }
        }
        b.cells(sheet, range);
        b.scope.info.insert(sheet);
        b.select(sheet, vec![range]);
        Ok(())
    }

    fn op_unmerge(&mut self, b: &mut Batch, sheet: SheetId, ranges: &[CellRange]) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        for range in ranges {
            let range = norm(*range);
            self.ic(b, |um| um.unmerge_cells(&area(index, &range)))?;
            b.style(sheet, range);
        }
        b.scope.info.insert(sheet);
        b.select(sheet, ranges.iter().map(|r| norm(*r)).collect());
        Ok(())
    }

    // ----- structure & geometry ------------------------------------------------

    fn op_insert_delete(&mut self, b: &mut Batch, sheet: SheetId, axis: Axis, insert: bool, index: u32, count: u32) -> EngineResult<()> {
        let sheet_index = self.sheet_index(sheet)?;
        let limit = if axis == Axis::Row { MAX_ROWS } else { MAX_COLS };
        if count == 0 || index >= limit {
            return Ok(());
        }
        let count = count.min(limit - index);
        let (at, n) = (index as i32 + 1, count as i32);
        if insert {
            // Excel refuses to push data off the sheet.
            if let Some(bounds) = used_bounds(self.worksheet(sheet)?) {
                let last = if axis == Axis::Row { bounds.r1 } else { bounds.c1 } as u32;
                if last >= index + 1 && last + count > limit {
                    return Err(invalid("No se pueden insertar celdas porque se perderían datos al final de la hoja."));
                }
            }
        }
        match (axis, insert) {
            (Axis::Row, true) => self.ic(b, |um| um.insert_rows(sheet_index, at, n))?,
            (Axis::Row, false) => self.ic(b, |um| um.delete_rows(sheet_index, at, n))?,
            (Axis::Col, true) => self.ic(b, |um| um.insert_columns(sheet_index, at, n))?,
            (Axis::Col, false) => self.ic(b, |um| um.delete_columns(sheet_index, at, n))?,
        }
        self.shift_meta(sheet, axis, insert, index, count);
        let op = if insert { StructureOp::Insert } else { StructureOp::Delete };
        b.scope.structure.push((sheet, axis, op, index, count));
        b.data(sheet);
        b.scope.info.insert(sheet);
        b.scope.charts.insert(sheet);
        let range = if axis == Axis::Row {
            CellRange { r0: index, c0: 0, r1: index + count - 1, c1: MAX_COLS - 1 }
        } else {
            CellRange { r0: 0, c0: index, r1: MAX_ROWS - 1, c1: index + count - 1 }
        };
        b.select(sheet, vec![range]);
        Ok(())
    }

    /// Moves comments, the autofilter and chart anchors with inserted/deleted rows or columns.
    pub(crate) fn shift_meta(&mut self, sheet: SheetId, axis: Axis, insert: bool, index: u32, count: u32) {
        let shift = |pos: u32| -> Option<u32> {
            if pos < index {
                Some(pos)
            } else if insert {
                Some(pos + count)
            } else if pos < index + count {
                None
            } else {
                Some(pos - count)
            }
        };
        let extra = self.extra_mut(sheet);
        let comments = std::mem::take(&mut extra.comments);
        for ((row, col), text) in comments {
            let moved = if axis == Axis::Row { shift(row).map(|r| (r, col)) } else { shift(col).map(|c| (row, c)) };
            if let Some(key) = moved {
                extra.comments.insert(key, text);
            }
        }
        if let Some(filter) = extra.filter.as_mut() {
            let (a, z) = if axis == Axis::Row { (filter.range.r0, filter.range.r1) } else { (filter.range.c0, filter.range.c1) };
            let new_a = shift(a);
            let new_z = if insert { shift(z) } else { shift(z).or_else(|| index.checked_sub(1)) };
            match (new_a, new_z) {
                (Some(a2), Some(z2)) if z2 >= a2 => {
                    if axis == Axis::Row {
                        filter.range.r0 = a2;
                        filter.range.r1 = z2;
                    } else {
                        filter.range.c0 = a2;
                        filter.range.c1 = z2;
                        let criteria = std::mem::take(&mut filter.criteria);
                        for (col, values) in criteria {
                            if let Some(c) = shift(col) {
                                filter.criteria.insert(c, values);
                            }
                        }
                    }
                }
                _ => extra.filter = None,
            }
        }
        for chart in &mut extra.charts {
            let anchor = &mut chart.draft.anchor;
            if axis == Axis::Row {
                anchor.from.row = shift(anchor.from.row).unwrap_or(index.min(anchor.from.row));
                anchor.to.row = shift(anchor.to.row).unwrap_or(index).max(anchor.from.row);
            } else {
                anchor.from.col = shift(anchor.from.col).unwrap_or(index.min(anchor.from.col));
                anchor.to.col = shift(anchor.to.col).unwrap_or(index).max(anchor.from.col);
            }
        }
    }

    fn op_sizes(&mut self, b: &mut Batch, sheet: SheetId, axis: Axis, indices: &[u32], size: Option<f64>) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let size = size.map(|s| s.clamp(0.0, 2000.0));
        for (start, end) in runs(indices) {
            let (s, e) = (start as i32 + 1, end as i32 + 1);
            match axis {
                Axis::Row => {
                    let value = px_to_ic_row(size.unwrap_or(DEFAULT_ROW_PX));
                    self.ic(b, |um| um.set_rows_height(index, s, e, value))?;
                }
                Axis::Col => {
                    let value = px_to_ic_col(size.unwrap_or(DEFAULT_COL_PX));
                    self.ic(b, |um| um.set_columns_width(index, s, e, value))?;
                }
            }
        }
        b.scope.info.insert(sheet);
        Ok(())
    }

    fn op_hidden(&mut self, b: &mut Batch, sheet: SheetId, axis: Axis, indices: &[u32], hidden: bool) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        for (start, end) in runs(indices) {
            let (s, e) = (start as i32 + 1, end as i32 + 1);
            match axis {
                Axis::Row => self.ic(b, |um| um.set_rows_hidden(index, s, e, hidden))?,
                Axis::Col => self.ic(b, |um| um.set_columns_hidden(index, s, e, hidden))?,
            }
        }
        b.scope.info.insert(sheet);
        Ok(())
    }

    fn op_frozen(&mut self, b: &mut Batch, sheet: SheetId, rows: u32, cols: u32) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let rows = rows.min(MAX_ROWS - 1) as i32;
        let cols = cols.min(MAX_COLS - 1) as i32;
        if self.um.get_frozen_rows_count(index).unwrap_or(0) != rows {
            self.ic(b, |um| um.set_frozen_rows_count(index, rows))?;
        }
        if self.um.get_frozen_columns_count(index).unwrap_or(0) != cols {
            self.ic(b, |um| um.set_frozen_columns_count(index, cols))?;
        }
        b.scope.info.insert(sheet);
        Ok(())
    }

    // ----- charts --------------------------------------------------------------

    fn op_add_chart(&mut self, b: &mut Batch, chart: &ChartDraft) -> EngineResult<()> {
        self.sheet_index(chart.sheet)?;
        let id = self.next_chart_id;
        self.next_chart_id += 1;
        self.extra_mut(chart.sheet).charts.push(ChartSpec { id, draft: chart.clone(), from_file: false });
        b.created.push(id);
        b.scope.charts.insert(chart.sheet);
        Ok(())
    }

    fn op_update_chart(&mut self, b: &mut Batch, chart: &ChartUpdate) -> EngineResult<()> {
        self.sheet_index(chart.draft.sheet)?;
        // The chart may move to another sheet.
        let mut old_sheet = None;
        for (sheet, extra) in self.meta.sheets.iter_mut() {
            if let Some(pos) = extra.charts.iter().position(|c| c.id == chart.id) {
                extra.charts.remove(pos);
                old_sheet = Some(*sheet);
                break;
            }
        }
        let Some(old_sheet) = old_sheet else {
            return Err(EngineError::not_found("El gráfico no existe."));
        };
        self.extra_mut(chart.draft.sheet)
            .charts
            .push(ChartSpec { id: chart.id, draft: chart.draft.clone(), from_file: false });
        b.scope.charts.insert(old_sheet);
        b.scope.charts.insert(chart.draft.sheet);
        Ok(())
    }

    fn op_delete_chart(&mut self, b: &mut Batch, sheet: SheetId, id: ChartId) -> EngineResult<()> {
        let extra = self.extra_mut(sheet);
        let before = extra.charts.len();
        extra.charts.retain(|c| c.id != id);
        if extra.charts.len() == before {
            return Err(EngineError::not_found("El gráfico no existe."));
        }
        b.scope.charts.insert(sheet);
        Ok(())
    }
}

/// Plain decimal text of a number for IronCalc (no exponent, so no
/// scientific number format gets applied).
pub(crate) fn plain_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        let s = format!("{n}");
        if s.contains('e') {
            format!("{n:E}")
        } else {
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_group_contiguous_indices() {
        assert_eq!(runs(&[5, 1, 2, 3, 9, 10]), vec![(1, 3), (5, 5), (9, 10)]);
    }

    #[test]
    fn plain_numbers() {
        assert_eq!(plain_number(1234.5), "1234.5");
        assert_eq!(plain_number(-3.0), "-3");
        assert_eq!(plain_number(1e-7), "0.0000001");
        assert_eq!(plain_number(0.1), "0.1");
    }
}
