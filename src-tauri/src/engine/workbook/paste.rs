//! Paste (internal clips, TSV text, HTML tables from Excel / Google Sheets /
//! LibreOffice), cell shifting (insert/delete cells) and the block writers
//! built on IronCalc's clipboard paste (one undo entry, formulas shifted,
//! styles and links carried).

use std::collections::HashMap;

use ironcalc_base::types::{Link, Style};

use super::clipboard::{take_clip, Clip};
use super::history::Batch;
use super::locale_in::{parse_local, LocalValue};
use super::ops::{invalid, plain_number};
use super::styles::{color_in, h_align_in, v_align_in};
use super::{area, ic_col, ic_row, WorkbookBackend};
use crate::engine::types::*;

/// One cell for the block writers.
#[derive(Debug, Clone)]
pub(crate) struct CellData {
    /// IronCalc-ready input ("" clears).
    pub text: String,
    pub style: Style,
    pub link: Option<Link>,
    pub is_spill: bool,
}

/// 1-based inclusive rectangle `(r0, c0, r1, c1)`.
type Rect1 = (i32, i32, i32, i32);

fn clipboard_value(cells: &HashMap<(i32, i32), CellData>) -> EngineResult<ironcalc_base::ClipboardData> {
    let mut rows = serde_json::Map::new();
    for ((row, col), cell) in cells {
        let entry = rows
            .entry(row.to_string())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let serde_json::Value::Object(map) = entry {
            map.insert(
                col.to_string(),
                serde_json::json!({
                    "text": cell.text,
                    "is_spill": cell.is_spill,
                    "style": cell.style,
                    "link": cell.link,
                }),
            );
        }
    }
    serde_json::from_value(serde_json::Value::Object(rows))
        .map_err(|e| EngineError::internal(format!("Portapapeles no válido: {e}")))
}

impl WorkbookBackend {
    /// IronCalc paste of `cells` (keyed by 1-based *source* position inside
    /// `source`) anchored at `anchor` on `target_sheet`. Relative references
    /// shift by `anchor - source origin`; `cut` moves instead (and updates
    /// references to the moved cells).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn paste_cells(
        &mut self,
        b: &mut Batch,
        target_sheet: u32,
        anchor: (i32, i32),
        source_sheet: u32,
        source: Rect1,
        cells: &HashMap<(i32, i32), CellData>,
        cut: bool,
    ) -> EngineResult<()> {
        let data = clipboard_value(cells)?;
        let one = CellRange { r0: (anchor.0 - 1) as u32, c0: (anchor.1 - 1) as u32, r1: (anchor.0 - 1) as u32, c1: (anchor.1 - 1) as u32 };
        self.select(target_sheet, one)?;
        self.ic(b, |um| um.paste_from_clipboard(source_sheet, source, &data, cut))
    }

    /// Rewrites a block in place (no shifting): a zero-distance cut, which
    /// avoids duplicating conditional formats. Every cell of `rect` must be
    /// in `cells` (missing ones are cleared).
    pub(crate) fn write_block_in_place(
        &mut self,
        b: &mut Batch,
        sheet: u32,
        rect: Rect1,
        cells: &HashMap<(i32, i32), CellData>,
    ) -> EngineResult<()> {
        self.paste_cells(b, sheet, (rect.0, rect.1), sheet, rect, cells, true)
    }

    /// Current content of a rectangle as `CellData` (inputs re-enterable).
    pub(crate) fn read_cells(&self, sheet_index: u32, rect: Rect1) -> EngineResult<HashMap<(i32, i32), CellData>> {
        let model = self.model();
        let ws = &model.workbook.worksheets[sheet_index as usize];
        let mut out = HashMap::new();
        for row in rect.0..=rect.2 {
            for col in rect.1..=rect.3 {
                let style = model.get_style_for_cell(sheet_index, row, col).map_err(super::ic_error)?;
                let cell = ws.cell(row, col);
                let is_spill = matches!(cell.as_deref(), Some(ironcalc_base::types::Cell::SpillCell { .. }));
                let text = if is_spill { String::new() } else { self.ic_input(&self.cell_input(sheet_index, ws, row, col)) };
                let text = if text.starts_with('=') || cell.as_ref().is_some_and(|c| c.has_formula()) {
                    model.get_localized_cell_content(sheet_index, row, col).unwrap_or_default()
                } else {
                    text
                };
                out.insert((row, col), CellData { text, style, link: ws.links.get(&(row, col)).cloned(), is_spill });
            }
        }
        Ok(out)
    }

    pub(crate) fn op_paste(&mut self, b: &mut Batch, sheet: SheetId, target: CellRange, source: &PasteSource, mode: PasteMode) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        match source {
            PasteSource::Internal { clip_id, cut } => {
                let clip = take_clip(*clip_id).ok_or_else(|| invalid("El contenido copiado ya no está disponible."))?;
                self.paste_internal(b, sheet, index, target, &clip, *cut, mode)
            }
            PasteSource::Text { text } => {
                let grid = parse_tsv(text);
                let cells = grid.into_iter().map(|row| row.into_iter().map(ExtCell::from_text).collect()).collect();
                self.paste_external(b, sheet, index, target, cells, Vec::new(), mode)
            }
            PasteSource::Html { html } => {
                let table = parse_html_table(html);
                if table.cells.is_empty() {
                    return Err(invalid("El portapapeles no contiene una tabla."));
                }
                self.paste_external(b, sheet, index, target, table.cells, table.merges, mode)
            }
        }
    }

    /// Tile anchors for a paste of `h`×`w` into `target` (Excel: tile when
    /// the target is a multiple of the source, else paste once).
    fn anchors(target: CellRange, h: u32, w: u32) -> Vec<(u32, u32)> {
        let (th, tw) = (target.r1 - target.r0 + 1, target.c1 - target.c0 + 1);
        if (th > h || tw > w) && th % h == 0 && tw % w == 0 && u64::from(th / h) * u64::from(tw / w) <= 10_000 {
            let mut out = Vec::new();
            for i in 0..th / h {
                for j in 0..tw / w {
                    out.push((target.r0 + i * h, target.c0 + j * w));
                }
            }
            out
        } else {
            vec![(target.r0, target.c0)]
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn paste_internal(
        &mut self,
        b: &mut Batch,
        sheet: SheetId,
        index: u32,
        target: CellRange,
        clip: &Clip,
        cut: bool,
        mode: PasteMode,
    ) -> EngineResult<()> {
        let (h, w) = (clip.height(), clip.width());
        let same_doc = clip.owner == self.token();
        let source_index = if same_doc { self.sheet_index(clip.sheet).ok() } else { None };
        let src_rect: Rect1 = (ic_row(clip.range.r0), ic_col(clip.range.c0), ic_row(clip.range.r1), ic_col(clip.range.c1));
        let fits = |r: u32, c: u32, hh: u32, ww: u32| r + hh <= MAX_ROWS && c + ww <= MAX_COLS;
        let mut pasted = Vec::new();

        if cut && mode == PasteMode::All {
            let Some(source_index) = source_index else {
                return Err(invalid("No se puede mover entre libros: copie y pegue en su lugar."));
            };
            if !fits(target.r0, target.c0, h, w) {
                return Err(invalid("El área de pegado no cabe en la hoja."));
            }
            let live = self.read_cells(source_index, src_rect)?;
            let anchor = (ic_row(target.r0), ic_col(target.c0));
            self.paste_cells(b, index, anchor, source_index, src_rect, &live, true)?;
            // Notes move with the cells.
            let moved: Vec<((u32, u32), String)> = self
                .extra(clip.sheet)
                .map(|e| e.comments.iter().filter(|(k, _)| clip.range.contains(k.0, k.1)).map(|(k, v)| (*k, v.clone())).collect())
                .unwrap_or_default();
            for ((r, c), _) in &moved {
                self.extra_mut(clip.sheet).comments.remove(&(*r, *c));
            }
            for ((r, c), text) in moved {
                let key = (r - clip.range.r0 + target.r0, c - clip.range.c0 + target.c0);
                self.extra_mut(sheet).comments.insert(key, text);
            }
            let dest = CellRange { r0: target.r0, c0: target.c0, r1: target.r0 + h - 1, c1: target.c0 + w - 1 };
            b.data(sheet);
            b.data(clip.sheet);
            b.scope.info.insert(sheet);
            b.affected += u64::from(h * w);
            b.select(sheet, vec![dest]);
            return Ok(());
        }

        if mode == PasteMode::Transpose {
            if !fits(target.r0, target.c0, w, h) {
                return Err(invalid("El área de pegado no cabe en la hoja."));
            }
            // Formula cells one by one (each shifted to its new place); the rest in one block.
            let rect: Rect1 = (ic_row(target.r0), ic_col(target.c0), ic_row(target.r0 + w - 1), ic_col(target.c0 + h - 1));
            let mut block = HashMap::new();
            let mut formulas = Vec::new();
            for (i, line) in clip.cells.iter().enumerate() {
                for (j, cell) in line.iter().enumerate() {
                    let pos = (rect.0 + j as i32, rect.1 + i as i32);
                    let is_formula = cell.input.starts_with('=');
                    let text = if is_formula && source_index.is_none() { cell.value_input.clone() } else { cell.input.clone() };
                    if is_formula && source_index.is_some() {
                        formulas.push((pos, (src_rect.0 + i as i32, src_rect.1 + j as i32), cell.clone()));
                    }
                    block.insert(pos, CellData { text, style: cell.style.clone(), link: cell.link.clone(), is_spill: cell.is_spill });
                }
            }
            for (pos, _, _) in &formulas {
                if let Some(c) = block.get_mut(pos) {
                    c.text = String::new();
                }
            }
            self.write_block_in_place(b, index, rect, &block)?;
            if let Some(source_index) = source_index {
                for (pos, src, cell) in formulas {
                    let mut one = HashMap::new();
                    one.insert(src, CellData { text: cell.input, style: cell.style, link: cell.link, is_spill: false });
                    self.paste_cells(b, index, pos, source_index, (src.0, src.1, src.0, src.1), &one, false)?;
                }
            }
            let dest = CellRange { r0: target.r0, c0: target.c0, r1: target.r0 + w - 1, c1: target.c0 + h - 1 };
            b.cells(sheet, dest);
            b.affected += u64::from(h * w);
            b.select(sheet, vec![dest]);
            return Ok(());
        }

        for (r0, c0) in Self::anchors(target, h, w) {
            if !fits(r0, c0, h, w) {
                return Err(invalid("El área de pegado no cabe en la hoja."));
            }
            let dest = CellRange { r0, c0, r1: r0 + h - 1, c1: c0 + w - 1 };
            let rect: Rect1 = (ic_row(dest.r0), ic_col(dest.c0), ic_row(dest.r1), ic_col(dest.c1));
            match mode {
                PasteMode::Values => {
                    let current = self.read_cells(index, rect)?;
                    let mut block = HashMap::new();
                    for (i, line) in clip.cells.iter().enumerate() {
                        for (j, cell) in line.iter().enumerate() {
                            let pos = (rect.0 + i as i32, rect.1 + j as i32);
                            let mut data = current.get(&pos).cloned().ok_or_else(|| EngineError::internal("celda"))?;
                            data.text = if cell.is_spill { String::new() } else { cell.value_input.clone() };
                            data.is_spill = false;
                            // Values keep the destination format except where it was General
                            // and the source shows a date/number format.
                            if data.style.num_fmt.eq_ignore_ascii_case("general") {
                                data.style.num_fmt = cell.style.num_fmt.clone();
                            }
                            block.insert(pos, data);
                        }
                    }
                    self.write_block_in_place(b, index, rect, &block)?;
                }
                PasteMode::Formats => {
                    let (t0, tc0) = (dest.r0, dest.c0);
                    self.write_styles(b, index, dest, |row, col, style| {
                        if let Some(cell) = clip.cells.get((row - t0) as usize).and_then(|l| l.get((col - tc0) as usize)) {
                            *style = cell.style.clone();
                        }
                        Ok(())
                    })?;
                }
                PasteMode::All | PasteMode::Formulas | PasteMode::Transpose => {
                    let keep_styles = mode == PasteMode::Formulas;
                    let current = if keep_styles { Some(self.read_cells(index, rect)?) } else { None };
                    let mut cells = HashMap::new();
                    for (i, line) in clip.cells.iter().enumerate() {
                        for (j, cell) in line.iter().enumerate() {
                            let dst = (rect.0 + i as i32, rect.1 + j as i32);
                            let style = match &current {
                                Some(cur) => cur.get(&dst).map(|c| c.style.clone()).unwrap_or_default(),
                                None => cell.style.clone(),
                            };
                            let (key, text) = match source_index {
                                Some(_) => ((src_rect.0 + i as i32, src_rect.1 + j as i32), cell.input.clone()),
                                None => (dst, if cell.input.starts_with('=') { cell.value_input.clone() } else { cell.input.clone() }),
                            };
                            cells.insert(key, CellData { text, style, link: cell.link.clone(), is_spill: cell.is_spill });
                        }
                    }
                    match source_index {
                        Some(source_index) => {
                            self.paste_cells(b, index, (rect.0, rect.1), source_index, src_rect, &cells, false)?;
                        }
                        None => self.write_block_in_place(b, index, rect, &cells)?,
                    }
                }
            }
            pasted.push(dest);
            b.affected += u64::from(h * w);
        }
        let union = pasted.iter().fold(None::<CellRange>, |acc, r| {
            Some(match acc {
                None => *r,
                Some(a) => CellRange { r0: a.r0.min(r.r0), c0: a.c0.min(r.c0), r1: a.r1.max(r.r1), c1: a.c1.max(r.c1) },
            })
        });
        if let Some(union) = union {
            if mode == PasteMode::Formats {
                b.style(sheet, union);
            } else {
                b.cells(sheet, union);
            }
            b.scope.info.insert(sheet);
            b.select(sheet, vec![union]);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn paste_external(
        &mut self,
        b: &mut Batch,
        sheet: SheetId,
        index: u32,
        target: CellRange,
        cells: Vec<Vec<ExtCell>>,
        merges: Vec<CellRange>,
        mode: PasteMode,
    ) -> EngineResult<()> {
        let h = cells.len() as u32;
        let w = cells.iter().map(Vec::len).max().unwrap_or(0) as u32;
        if h == 0 || w == 0 {
            return Ok(());
        }
        let transpose = mode == PasteMode::Transpose;
        let (dh, dw) = if transpose { (w, h) } else { (h, w) };
        let anchors = if transpose { vec![(target.r0, target.c0)] } else { Self::anchors(target, h, w) };
        let base = self.base_style.clone();
        let mut pasted = Vec::new();
        for (r0, c0) in anchors {
            if r0 + dh > MAX_ROWS || c0 + dw > MAX_COLS {
                return Err(invalid("El área de pegado no cabe en la hoja."));
            }
            let dest = CellRange { r0, c0, r1: r0 + dh - 1, c1: c0 + dw - 1 };
            let rect: Rect1 = (ic_row(dest.r0), ic_col(dest.c0), ic_row(dest.r1), ic_col(dest.c1));
            let mut block = self.read_cells(index, rect)?;
            for (i, line) in cells.iter().enumerate() {
                for j in 0..w as usize {
                    let (di, dj) = if transpose { (j, i) } else { (i, j) };
                    let pos = (rect.0 + di as i32, rect.1 + dj as i32);
                    let Some(data) = block.get_mut(&pos) else { continue };
                    let cell = line.get(j);
                    if mode != PasteMode::Formats {
                        data.text = match cell {
                            Some(cell) => self.ext_input(cell, mode == PasteMode::Values),
                            None => String::new(),
                        };
                        data.link = None;
                        data.is_spill = false;
                    }
                    if let Some(cell) = cell {
                        if let Some(fmt) = &cell.num_fmt {
                            if mode != PasteMode::Values || data.style.num_fmt.eq_ignore_ascii_case("general") {
                                data.style.num_fmt = fmt.clone();
                            }
                        }
                        if matches!(mode, PasteMode::All | PasteMode::Formats | PasteMode::Transpose) {
                            cell.style.apply(&mut data.style, &base);
                        }
                    }
                }
            }
            self.write_block_in_place(b, index, rect, &block)?;
            if matches!(mode, PasteMode::All) {
                for m in &merges {
                    let m = CellRange { r0: m.r0 + r0, c0: m.c0 + c0, r1: m.r1 + r0, c1: m.c1 + c0 };
                    if m.r1 < MAX_ROWS && m.c1 < MAX_COLS {
                        let _ = self.ic(b, |um| um.merge_cells(&area(index, &m)));
                    }
                }
            }
            pasted.push(dest);
            b.affected += u64::from(dh * dw);
        }
        if let Some(first) = pasted.first().copied() {
            let union = pasted.iter().fold(first, |a, r| CellRange {
                r0: a.r0.min(r.r0),
                c0: a.c0.min(r.c0),
                r1: a.r1.max(r.r1),
                c1: a.c1.max(r.c1),
            });
            if mode == PasteMode::Formats {
                b.style(sheet, union);
            } else {
                b.cells(sheet, union);
            }
            if !merges.is_empty() {
                b.scope.info.insert(sheet);
            }
            b.select(sheet, vec![union]);
        }
        Ok(())
    }

    /// IronCalc input of a pasted external cell.
    fn ext_input(&self, cell: &ExtCell, values_only: bool) -> String {
        if let Some(formula) = &cell.formula {
            if !values_only {
                return formula.clone();
            }
        }
        match &cell.value {
            LocalValue::Empty => String::new(),
            LocalValue::Number(n) => plain_number(*n),
            LocalValue::Bool(v) => if *v { "TRUE" } else { "FALSE" }.to_string(),
            LocalValue::Error(e) => e.clone(),
            LocalValue::Text(t) => {
                if self.text_needs_quote(t) {
                    format!("'{t}")
                } else {
                    t.clone()
                }
            }
        }
    }

    /// Insert cells (shift right/down) or delete cells (shift left/up) by
    /// moving the cells beyond the range (IronCalc cut, so references follow).
    pub(crate) fn op_shift_cells(&mut self, b: &mut Batch, sheet: SheetId, range: CellRange, shift: ShiftDir, insert: bool) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let vertical = matches!(shift, ShiftDir::Down | ShiftDir::Up);
        let whole = if vertical { super::full_cols(&range) } else { super::full_rows(&range) };
        if whole {
            // Shifting whole rows/columns is a row/column insert or delete.
            let (axis, start, count) = if vertical {
                (Axis::Row, range.r0, range.r1 - range.r0 + 1)
            } else {
                (Axis::Col, range.c0, range.c1 - range.c0 + 1)
            };
            let _ = axis;
            let op = match (vertical, insert) {
                (true, true) => EngineOp::InsertRows { sheet, index: start, count },
                (true, false) => EngineOp::DeleteRows { sheet, index: start, count },
                (false, true) => EngineOp::InsertCols { sheet, index: start, count },
                (false, false) => EngineOp::DeleteCols { sheet, index: start, count },
            };
            return self.apply_op(&op, b);
        }
        let bounds = super::queries::used_bounds(self.worksheet(sheet)?);
        let (h, w) = (range.r1 - range.r0 + 1, range.c1 - range.c0 + 1);
        // The band of cells that moves.
        let (last_row, last_col) = match bounds {
            Some(bd) => ((bd.r1 - 1) as u32, (bd.c1 - 1) as u32),
            None => (range.r1, range.c1),
        };
        if !insert {
            self.ic(b, |um| um.range_clear_all(&area(index, &range)))?;
        }
        let band = match (vertical, insert) {
            (true, true) => (range.r0 <= last_row).then_some(CellRange { r0: range.r0, c0: range.c0, r1: last_row, c1: range.c1 }),
            (true, false) => (range.r1 < last_row).then(|| CellRange { r0: range.r1 + 1, c0: range.c0, r1: last_row, c1: range.c1 }),
            (false, true) => (range.c0 <= last_col).then_some(CellRange { r0: range.r0, c0: range.c0, r1: range.r1, c1: last_col }),
            (false, false) => (range.c1 < last_col).then(|| CellRange { r0: range.r0, c0: range.c1 + 1, r1: range.r1, c1: last_col }),
        };
        if let Some(band) = band {
            let (dr, dc): (i64, i64) = match (vertical, insert) {
                (true, true) => (i64::from(h), 0),
                (true, false) => (-i64::from(h), 0),
                (false, true) => (0, i64::from(w)),
                (false, false) => (0, -i64::from(w)),
            };
            if band.r1 as i64 + dr >= i64::from(MAX_ROWS) || band.c1 as i64 + dc >= i64::from(MAX_COLS) {
                return Err(invalid("No se pueden insertar celdas porque se perderían datos al final de la hoja."));
            }
            let rect: Rect1 = (ic_row(band.r0), ic_col(band.c0), ic_row(band.r1), ic_col(band.c1));
            let live = self.read_cells(index, rect)?;
            let anchor = ((rect.0 as i64 + dr) as i32, (rect.1 as i64 + dc) as i32);
            self.paste_cells(b, index, anchor, index, rect, &live, true)?;
            // Notes in the band move too.
            let extra = self.extra_mut(sheet);
            let moved: Vec<((u32, u32), String)> =
                extra.comments.iter().filter(|(k, _)| band.contains(k.0, k.1)).map(|(k, v)| (*k, v.clone())).collect();
            if !insert {
                extra.comments.retain(|k, _| !range.contains(k.0, k.1));
            }
            for (k, _) in &moved {
                extra.comments.remove(k);
            }
            for ((r, c), text) in moved {
                extra.comments.insert(((r as i64 + dr) as u32, (c as i64 + dc) as u32), text);
            }
        }
        b.data(sheet);
        b.scope.info.insert(sheet);
        b.select(sheet, vec![range]);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// External clipboard formats
// ---------------------------------------------------------------------------

/// Style bits read from HTML.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct HtmlStyle {
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strike: Option<bool>,
    pub color: Option<String>,
    pub fill: Option<String>,
    pub h_align: Option<HAlign>,
    pub v_align: Option<VAlign>,
    pub wrap: Option<bool>,
    pub font_size: Option<f64>,
    pub font_family: Option<String>,
}

impl HtmlStyle {
    fn merge(&mut self, other: &HtmlStyle) {
        macro_rules! take {
            ($($f:ident),*) => { $( if other.$f.is_some() { self.$f = other.$f.clone(); } )* };
        }
        take!(bold, italic, underline, strike, color, fill, h_align, v_align, wrap, font_size, font_family);
    }

    fn apply(&self, style: &mut Style, base: &Style) {
        if let Some(v) = self.bold {
            style.font.b = v;
        }
        if let Some(v) = self.italic {
            style.font.i = v;
        }
        if let Some(v) = self.underline {
            style.font.u = v;
        }
        if let Some(v) = self.strike {
            style.font.strike = v;
        }
        if let Some(c) = self.color.as_deref().and_then(|c| color_in(c).ok()) {
            style.font.color = c;
        }
        if let Some(c) = self.fill.as_deref().and_then(|c| color_in(c).ok()) {
            style.fill.color = c;
        }
        if self.h_align.is_some() || self.v_align.is_some() || self.wrap.is_some() {
            let alignment = style.alignment.get_or_insert_with(Default::default);
            if let Some(h) = self.h_align {
                alignment.horizontal = h_align_in(h);
            }
            if let Some(v) = self.v_align {
                alignment.vertical = v_align_in(v);
            }
            if let Some(w) = self.wrap {
                alignment.wrap_text = w;
            }
        }
        if let Some(size) = self.font_size {
            style.font.sz = (size.round() as i32).clamp(1, 409);
        }
        if let Some(family) = &self.font_family {
            style.font.name = family.clone();
        }
        let _ = base;
    }
}

/// A cell pasted from another application.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExtCell {
    pub value: LocalValue,
    pub num_fmt: Option<String>,
    pub formula: Option<String>,
    pub style: HtmlStyle,
}

impl ExtCell {
    fn from_text(text: String) -> Self {
        let local = parse_local(&text);
        let value = match local.value {
            LocalValue::Text(_) => LocalValue::Text(text),
            other => other,
        };
        Self { value, num_fmt: local.num_fmt, formula: None, style: HtmlStyle::default() }
    }
}

/// Tab-separated text (Excel / Google Sheets / LibreOffice), with quoted
/// fields for embedded tabs, newlines and quotes.
pub(crate) fn parse_tsv(text: &str) -> Vec<Vec<String>> {
    let text = text.strip_suffix("\r\n").or_else(|| text.strip_suffix('\n')).unwrap_or(text);
    if text.is_empty() {
        return Vec::new();
    }
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(b'\t')
        .has_headers(false)
        .flexible(true)
        .quoting(true)
        .from_reader(text.as_bytes());
    let mut rows = Vec::new();
    for record in reader.records() {
        match record {
            Ok(record) => rows.push(record.iter().map(str::to_string).collect()),
            Err(_) => {
                // Malformed quoting: fall back to a plain split.
                return text.lines().map(|l| l.split('\t').map(str::to_string).collect()).collect();
            }
        }
    }
    rows
}

pub(crate) struct HtmlTable {
    pub cells: Vec<Vec<ExtCell>>,
    /// Merges (from colspan/rowspan) relative to the table origin.
    pub merges: Vec<CellRange>,
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "euro" => Some('€'),
            _ => {
                if let Some(hex) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                } else if let Some(dec) = entity.strip_prefix('#') {
                    dec.parse::<u32>().ok().and_then(char::from_u32)
                } else {
                    None
                }
            }
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Attributes of a start tag (`name="v"`, `name='v'`, `name=v`, `name`).
fn parse_attrs(tag: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    let bytes: Vec<char> = tag.chars().collect();
    let mut i = 0;
    // Skip tag name.
    while i < bytes.len() && !bytes[i].is_whitespace() {
        i += 1;
    }
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i].is_whitespace() || bytes[i] == '/') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && !bytes[i].is_whitespace() && bytes[i] != '=' && bytes[i] != '/' {
            i += 1;
        }
        if start == i {
            i += 1;
            continue;
        }
        let name: String = bytes[start..i].iter().collect::<String>().to_lowercase();
        while i < bytes.len() && bytes[i].is_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < bytes.len() && bytes[i] == '=' {
            i += 1;
            while i < bytes.len() && bytes[i].is_whitespace() {
                i += 1;
            }
            if i < bytes.len() && (bytes[i] == '"' || bytes[i] == '\'') {
                let quote = bytes[i];
                i += 1;
                let vs = i;
                while i < bytes.len() && bytes[i] != quote {
                    i += 1;
                }
                value = bytes[vs..i].iter().collect();
                i += 1;
            } else {
                let vs = i;
                while i < bytes.len() && !bytes[i].is_whitespace() {
                    i += 1;
                }
                value = bytes[vs..i].iter().collect();
            }
        }
        attrs.insert(name, decode_entities(&value));
    }
    attrs
}

fn css_color(value: &str) -> Option<String> {
    let v = value.trim().to_lowercase();
    if let Some(hex) = v.strip_prefix('#') {
        if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(format!("#{hex}"));
        }
        if hex.len() == 3 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
            let full: String = hex.chars().flat_map(|c| [c, c]).collect();
            return Some(format!("#{full}"));
        }
        return None;
    }
    if let Some(inner) = v.strip_prefix("rgb(").or_else(|| v.strip_prefix("rgba(")).and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<u8> = inner.split(',').take(3).filter_map(|p| p.trim().parse::<f64>().ok().map(|f| f as u8)).collect();
        if parts.len() == 3 {
            return Some(format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]));
        }
        return None;
    }
    let named = match v.as_str() {
        "black" | "windowtext" => "#000000",
        "white" => "#ffffff",
        "red" => "#ff0000",
        "green" => "#008000",
        "blue" => "#0000ff",
        "yellow" => "#ffff00",
        "gray" | "grey" => "#808080",
        "silver" => "#c0c0c0",
        "orange" => "#ffa500",
        "purple" => "#800080",
        "navy" => "#000080",
        "maroon" => "#800000",
        _ => return None,
    };
    Some(named.to_string())
}

fn parse_css(css: &str) -> HtmlStyle {
    let mut style = HtmlStyle::default();
    for decl in css.split(';') {
        let Some((prop, value)) = decl.split_once(':') else { continue };
        let prop = prop.trim().to_lowercase();
        let value = value.trim().trim_end_matches("!important").trim();
        let lower = value.to_lowercase();
        match prop.as_str() {
            "font-weight" => style.bold = Some(lower == "bold" || lower == "bolder" || lower.parse::<u32>().is_ok_and(|w| w >= 600)),
            "font-style" => style.italic = Some(lower == "italic" || lower == "oblique"),
            "text-decoration" | "text-decoration-line" => {
                style.underline = Some(lower.contains("underline"));
                style.strike = Some(lower.contains("line-through"));
            }
            "color" => style.color = css_color(value),
            "background" | "background-color" => {
                if !lower.contains("transparent") && lower != "none" {
                    style.fill = css_color(value.split_whitespace().next().unwrap_or(value));
                }
            }
            "text-align" => {
                style.h_align = match lower.as_str() {
                    "left" | "start" => Some(HAlign::Left),
                    "center" => Some(HAlign::Center),
                    "right" | "end" => Some(HAlign::Right),
                    "justify" => Some(HAlign::Justify),
                    _ => None,
                }
            }
            "vertical-align" => {
                style.v_align = match lower.as_str() {
                    "top" => Some(VAlign::Top),
                    "middle" => Some(VAlign::Middle),
                    "bottom" => Some(VAlign::Bottom),
                    _ => None,
                }
            }
            "white-space" => style.wrap = Some(lower == "normal" || lower == "pre-wrap"),
            "font-size" => {
                let number: String = lower.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                if let Ok(size) = number.parse::<f64>() {
                    style.font_size = Some(if lower.ends_with("px") { size * 0.75 } else { size });
                }
            }
            "font-family" => {
                let first = value.split(',').next().unwrap_or("").trim().trim_matches(['"', '\'']).to_string();
                if !first.is_empty() {
                    style.font_family = Some(first);
                }
            }
            _ => {}
        }
    }
    style
}

/// `.xl65 { ... }` rules from `<style>` blocks (Excel writes its formats there).
fn parse_style_rules(css: &str) -> HashMap<String, HtmlStyle> {
    let mut rules = HashMap::new();
    let mut rest = css;
    while let Some(open) = rest.find('{') {
        let selectors = &rest[..open];
        let Some(close) = rest[open..].find('}') else { break };
        let body = &rest[open + 1..open + close];
        let style = parse_css(body);
        for selector in selectors.split(',') {
            let selector = selector.trim();
            if let Some(class) = selector.rsplit('.').next().filter(|_| selector.contains('.')) {
                rules.insert(class.trim().to_lowercase(), style.clone());
            }
        }
        rest = &rest[open + close + 1..];
    }
    rules
}

/// Parses the first `<table>` of an HTML fragment into cells.
pub(crate) fn parse_html_table(html: &str) -> HtmlTable {
    let lower = html.to_lowercase();
    let mut class_rules = HashMap::new();
    let mut search = 0;
    while let Some(start) = lower[search..].find("<style") {
        let start = search + start;
        let Some(body_start) = lower[start..].find('>').map(|p| start + p + 1) else { break };
        let end = lower[body_start..].find("</style").map(|p| body_start + p).unwrap_or(lower.len());
        class_rules.extend(parse_style_rules(&html[body_start..end]));
        search = end;
    }
    let table_start = lower.find("<table").unwrap_or(0);
    let table_end = lower[table_start..].find("</table").map(|p| table_start + p).unwrap_or(lower.len());
    let body = &html[table_start..table_end];

    let mut grid: Vec<Vec<Option<ExtCell>>> = Vec::new();
    let mut merges = Vec::new();
    let mut occupied: HashMap<(usize, usize), bool> = HashMap::new();
    let mut row: Option<usize> = None;
    let mut col = 0usize;
    // Current cell being read.
    let mut cell: Option<(HashMap<String, String>, String, HtmlStyle)> = None;
    let mut inline_stack: Vec<HtmlStyle> = Vec::new();
    let mut i = 0;
    let chars: Vec<char> = body.chars().collect();
    let flush_cell = |cell: (HashMap<String, String>, String, HtmlStyle),
                      row: usize,
                      col: &mut usize,
                      grid: &mut Vec<Vec<Option<ExtCell>>>,
                      merges: &mut Vec<CellRange>,
                      occupied: &mut HashMap<(usize, usize), bool>,
                      class_rules: &HashMap<String, HtmlStyle>| {
        let (attrs, text, inner_style) = cell;
        while occupied.contains_key(&(row, *col)) {
            *col += 1;
        }
        let mut style = HtmlStyle::default();
        if let Some(class) = attrs.get("class") {
            for name in class.split_whitespace() {
                if let Some(rule) = class_rules.get(&name.to_lowercase()) {
                    style.merge(rule);
                }
            }
        }
        if let Some(align) = attrs.get("align") {
            style.merge(&parse_css(&format!("text-align:{align}")));
        }
        if let Some(bg) = attrs.get("bgcolor") {
            style.fill = css_color(bg);
        }
        if let Some(css) = attrs.get("style") {
            style.merge(&parse_css(css));
        }
        style.merge(&inner_style);
        let text = text.trim_matches(|c| c == '\n' || c == '\r').to_string();
        let mut ext = ExtCell::from_text(text.clone());
        // Raw values written by spreadsheet apps win over the display text.
        if let Some(num) = attrs.get("x:num").filter(|v| !v.is_empty()).or_else(|| attrs.get("sdval")) {
            if let Ok(n) = num.trim().parse::<f64>() {
                ext.value = LocalValue::Number(n);
            }
        }
        if let Some(json) = attrs.get("data-sheets-value") {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                match v.get("1").and_then(|t| t.as_i64()) {
                    Some(3) => {
                        if let Some(n) = v.get("3").and_then(|n| n.as_f64()) {
                            ext.value = LocalValue::Number(n);
                        }
                    }
                    Some(4) => {
                        if let Some(b) = v.get("4").and_then(|b| b.as_bool().or_else(|| b.as_i64().map(|i| i != 0))) {
                            ext.value = LocalValue::Bool(b);
                        }
                    }
                    Some(2) => {
                        if let Some(s) = v.get("2").and_then(|s| s.as_str()) {
                            ext.value = LocalValue::Text(s.to_string());
                            ext.num_fmt = None;
                        }
                    }
                    _ => {}
                }
            }
        }
        if attrs.contains_key("x:str") {
            ext.value = if text.is_empty() { LocalValue::Empty } else { LocalValue::Text(text.clone()) };
            ext.num_fmt = None;
        }
        if let Some(formula) = attrs.get("x:fmla").or_else(|| attrs.get("data-sheets-formula")) {
            if formula.starts_with('=') && !formula.contains("R[") {
                ext.formula = Some(formula.clone());
            }
        }
        ext.style = style;
        let rowspan: usize = attrs.get("rowspan").and_then(|v| v.parse().ok()).unwrap_or(1).clamp(1, 1000);
        let colspan: usize = attrs.get("colspan").and_then(|v| v.parse().ok()).unwrap_or(1).clamp(1, 1000);
        for r in row..row + rowspan {
            for c in *col..*col + colspan {
                occupied.insert((r, c), true);
            }
        }
        if rowspan > 1 || colspan > 1 {
            merges.push(CellRange {
                r0: row as u32,
                c0: *col as u32,
                r1: (row + rowspan - 1) as u32,
                c1: (*col + colspan - 1) as u32,
            });
        }
        while grid.len() <= row {
            grid.push(Vec::new());
        }
        let line = &mut grid[row];
        while line.len() <= *col {
            line.push(None);
        }
        line[*col] = Some(ext);
        *col += colspan;
    };

    while i < chars.len() {
        if chars[i] == '<' {
            let end = match chars[i..].iter().position(|c| *c == '>') {
                Some(p) => i + p,
                None => break,
            };
            let tag: String = chars[i + 1..end].iter().collect();
            i = end + 1;
            let tag_lower = tag.trim().to_lowercase();
            if tag_lower.starts_with("!--") {
                // Skip comments (Excel's <!--StartFragment-->).
                continue;
            }
            let closing = tag_lower.starts_with('/');
            let name: String = tag_lower.trim_start_matches('/').chars().take_while(|c| c.is_alphanumeric()).collect();
            match (name.as_str(), closing) {
                ("tr", false) => {
                    if let (Some(c), Some(r)) = (cell.take(), row) {
                        flush_cell(c, r, &mut col, &mut grid, &mut merges, &mut occupied, &class_rules);
                    }
                    row = Some(row.map_or(0, |r| r + 1));
                    col = 0;
                }
                ("td" | "th", false) => {
                    if let (Some(c), Some(r)) = (cell.take(), row) {
                        flush_cell(c, r, &mut col, &mut grid, &mut merges, &mut occupied, &class_rules);
                    }
                    if row.is_none() {
                        row = Some(0);
                    }
                    let mut style = HtmlStyle::default();
                    if name == "th" {
                        style.bold = Some(true);
                    }
                    cell = Some((parse_attrs(&tag), String::new(), style));
                    inline_stack.clear();
                }
                ("td" | "th", true) => {
                    if let (Some(c), Some(r)) = (cell.take(), row) {
                        flush_cell(c, r, &mut col, &mut grid, &mut merges, &mut occupied, &class_rules);
                    }
                }
                ("br", _) => {
                    if let Some(c) = cell.as_mut() {
                        c.1.push('\n');
                    }
                }
                ("p" | "div", true) => {
                    if let Some(c) = cell.as_mut() {
                        if !c.1.is_empty() && !c.1.ends_with('\n') {
                            c.1.push('\n');
                        }
                    }
                }
                ("b" | "strong" | "i" | "em" | "u" | "s" | "strike" | "font" | "span", false) => {
                    if let Some(c) = cell.as_mut() {
                        let mut s = HtmlStyle::default();
                        match name.as_str() {
                            "b" | "strong" => s.bold = Some(true),
                            "i" | "em" => s.italic = Some(true),
                            "u" => s.underline = Some(true),
                            "s" | "strike" => s.strike = Some(true),
                            _ => {}
                        }
                        let attrs = parse_attrs(&tag);
                        if let Some(color) = attrs.get("color") {
                            s.color = css_color(color);
                        }
                        if let Some(css) = attrs.get("style") {
                            s.merge(&parse_css(css));
                        }
                        // Inline formatting applies to the whole cell (cells have one style).
                        c.2.merge(&s);
                        inline_stack.push(s);
                    }
                }
                _ => {}
            }
        } else {
            let next = chars[i..].iter().position(|c| *c == '<').map(|p| i + p).unwrap_or(chars.len());
            if let Some(c) = cell.as_mut() {
                let raw: String = chars[i..next].iter().collect();
                // HTML collapses whitespace; newlines in source are not line breaks.
                let collapsed = raw.replace(['\r', '\n'], " ");
                c.1.push_str(&decode_entities(&collapsed));
            }
            i = next;
        }
    }
    if let (Some(c), Some(r)) = (cell.take(), row) {
        flush_cell(c, r, &mut col, &mut grid, &mut merges, &mut occupied, &class_rules);
    }
    let width = grid.iter().map(Vec::len).max().unwrap_or(0);
    let empty = ExtCell { value: LocalValue::Empty, num_fmt: None, formula: None, style: HtmlStyle::default() };
    let cells = grid
        .into_iter()
        .map(|line| {
            let mut out: Vec<ExtCell> = line.into_iter().map(|c| c.unwrap_or_else(|| empty.clone())).collect();
            out.resize(width, empty.clone());
            out
        })
        .collect();
    HtmlTable { cells, merges }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsv_with_quotes_and_newlines() {
        let rows = parse_tsv("a\tb\r\n\"multi\nline\"\t\"x\"\"y\"\r\n");
        assert_eq!(rows, vec![vec!["a", "b"], vec!["multi\nline", "x\"y"]]);
        assert_eq!(parse_tsv("1\t\t3"), vec![vec!["1", "", "3"]]);
        assert!(parse_tsv("").is_empty());
    }

    #[test]
    fn excel_html() {
        let html = r#"<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><style>
            .xl65 {mso-style-parent:style0; font-weight:700; color:red;}
            .xl66 {mso-number-format:"0%"; background:#FFFF00;}
            </style></head><body><table>
            <!--StartFragment-->
            <tr><td class=xl65>Nombre</td><td class=xl65 align=right>Importe</td></tr>
            <tr><td>Ana</td><td align=right x:num="1234.56">1.234,56 €</td></tr>
            <tr><td colspan=2 class=xl66 x:num="0.25">25%</td></tr>
            <!--EndFragment--></table></body></html>"#;
        let table = parse_html_table(html);
        assert_eq!(table.cells.len(), 3);
        assert_eq!(table.cells[0][0].value, LocalValue::Text("Nombre".into()));
        assert_eq!(table.cells[0][0].style.bold, Some(true));
        assert_eq!(table.cells[0][0].style.color.as_deref(), Some("#ff0000"));
        assert_eq!(table.cells[1][1].value, LocalValue::Number(1234.56));
        assert_eq!(table.cells[1][1].num_fmt.as_deref(), Some("#,##0.00 \"€\""));
        assert_eq!(table.cells[2][0].value, LocalValue::Number(0.25));
        assert_eq!(table.cells[2][0].style.fill.as_deref(), Some("#ffff00"));
        assert_eq!(table.merges, vec![CellRange { r0: 2, c0: 0, r1: 2, c1: 1 }]);
    }

    #[test]
    fn google_sheets_html() {
        let html = r##"<meta charset="utf-8"><google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Total&quot;}">Total</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:42.5}">42,50</td></tr></tbody></table>"##;
        let table = parse_html_table(html);
        assert_eq!(table.cells[0][0].value, LocalValue::Text("Total".into()));
        assert_eq!(table.cells[0][0].style.bold, Some(true));
        assert_eq!(table.cells[0][1].value, LocalValue::Number(42.5));
        assert_eq!(table.cells[0][1].style.h_align, Some(HAlign::Right));
    }

    #[test]
    fn libreoffice_html() {
        let html = r##"<table cellspacing="0" border="0"><tr><td height="17" align="left"><b><i>Mes</i></b></td><td align="right" sdval="3" sdnum="3082;">3</td></tr><tr><td>a &amp; b<br>c</td><td bgcolor="#C5E0B4">x</td></tr></table>"##;
        let table = parse_html_table(html);
        assert_eq!(table.cells[0][0].style.bold, Some(true));
        assert_eq!(table.cells[0][0].style.italic, Some(true));
        assert_eq!(table.cells[0][1].value, LocalValue::Number(3.0));
        assert_eq!(table.cells[1][0].value, LocalValue::Text("a & b\nc".into()));
        assert_eq!(table.cells[1][1].style.fill.as_deref(), Some("#c5e0b4"));
    }
}
