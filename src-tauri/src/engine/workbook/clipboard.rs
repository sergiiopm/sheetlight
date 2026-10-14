//! Internal clipboard (`engine.copy`) and the text/HTML handed to the system
//! clipboard. Clips are global to the engine so they can be pasted into
//! another document; only the last few are kept.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use ironcalc_base::types::{Cell, Link, Style};

use super::display::{self, raw_value, RawValue};
use super::styles::to_cell_style;
use super::{ic_col, ic_row, norm, WorkbookBackend};
use crate::engine::types::*;

#[derive(Debug, Clone)]
pub struct ClipCell {
    /// IronCalc-ready input (formula or quoted value) as it was in the source cell.
    pub input: String,
    /// IronCalc-ready input of the computed value ("paste values").
    pub value_input: String,
    pub style: Style,
    pub link: Option<Link>,
    pub is_spill: bool,
}

#[derive(Debug)]
pub struct Clip {
    pub id: u32,
    /// `WorkbookBackend::token` of the source document.
    pub owner: u64,
    pub sheet: SheetId,
    pub range: CellRange,
    /// Row-major, `range` sized.
    pub cells: Vec<Vec<ClipCell>>,
}

impl Clip {
    pub fn height(&self) -> u32 {
        self.range.r1 - self.range.r0 + 1
    }

    pub fn width(&self) -> u32 {
        self.range.c1 - self.range.c0 + 1
    }
}

static CLIPS: Mutex<VecDeque<Arc<Clip>>> = Mutex::new(VecDeque::new());
static NEXT_CLIP: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
const KEEP_CLIPS: usize = 4;

fn store(clip: Clip) {
    if let Ok(mut clips) = CLIPS.lock() {
        clips.push_back(Arc::new(clip));
        while clips.len() > KEEP_CLIPS {
            clips.pop_front();
        }
    }
}

pub fn take_clip(id: u32) -> Option<Arc<Clip>> {
    CLIPS.lock().ok()?.iter().find(|c| c.id == id).cloned()
}

fn escape_html(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\n' => out.push_str("<br>"),
            _ => out.push(c),
        }
    }
    out
}

fn tsv_field(text: &str) -> String {
    if text.contains(['\t', '\n', '\r', '"']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

fn css_border(spec: &Option<BorderSpec>) -> Option<String> {
    spec.as_ref().map(|b| {
        let (width, kind) = match b.style {
            BorderStyle::Thin | BorderStyle::Hair => ("1px", "solid"),
            BorderStyle::Medium => ("2px", "solid"),
            BorderStyle::Thick => ("3px", "solid"),
            BorderStyle::Dashed => ("1px", "dashed"),
            BorderStyle::Dotted => ("1px", "dotted"),
            BorderStyle::Double => ("3px", "double"),
        };
        format!("{width} {kind} {}", b.color)
    })
}

fn css_of(style: &CellStyle, is_number: bool) -> String {
    let mut css = Vec::new();
    if let Some(f) = &style.font_family {
        css.push(format!("font-family:'{}'", f.replace('\'', "")));
    }
    if let Some(s) = style.font_size {
        css.push(format!("font-size:{s}pt"));
    }
    if style.bold == Some(true) {
        css.push("font-weight:bold".to_string());
    }
    if style.italic == Some(true) {
        css.push("font-style:italic".to_string());
    }
    let underline = super::styles::has_underline(style);
    let strike = style.strike == Some(true);
    if underline || strike {
        let mut parts = Vec::new();
        if underline {
            parts.push("underline");
        }
        if strike {
            parts.push("line-through");
        }
        css.push(format!("text-decoration:{}", parts.join(" ")));
    }
    if let Some(c) = &style.color {
        css.push(format!("color:{c}"));
    }
    if let Some(f) = &style.fill {
        css.push(format!("background-color:{f}"));
    }
    let align = match style.h_align {
        Some(HAlign::Left) => Some("left"),
        Some(HAlign::Center) | Some(HAlign::CenterContinuous) => Some("center"),
        Some(HAlign::Right) => Some("right"),
        Some(HAlign::Justify) => Some("justify"),
        _ if is_number => Some("right"),
        _ => None,
    };
    if let Some(a) = align {
        css.push(format!("text-align:{a}"));
    }
    match style.v_align {
        Some(VAlign::Top) => css.push("vertical-align:top".to_string()),
        Some(VAlign::Middle) => css.push("vertical-align:middle".to_string()),
        _ => css.push("vertical-align:bottom".to_string()),
    }
    if style.wrap == Some(true) {
        css.push("white-space:normal".to_string());
    } else {
        css.push("white-space:nowrap".to_string());
    }
    for (side, spec) in [
        ("top", &style.border_top),
        ("right", &style.border_right),
        ("bottom", &style.border_bottom),
        ("left", &style.border_left),
    ] {
        if let Some(b) = css_border(spec) {
            css.push(format!("border-{side}:{b}"));
        }
    }
    css.join(";")
}

impl WorkbookBackend {
    /// `engine.copy`: stores an internal clip and returns TSV + HTML.
    pub fn copy(&self, sheet: SheetId, range: CellRange) -> EngineResult<ClipboardData> {
        let sheet_index = self.sheet_index(sheet)?;
        let mut range = norm(range);
        if super::full_cols(&range) || super::full_rows(&range) {
            range = self.clamp_to_used(sheet, range)?.unwrap_or(CellRange { r1: range.r0, c1: range.c0, ..range });
        }
        let cells_count = u64::from(range.r1 - range.r0 + 1) * u64::from(range.c1 - range.c0 + 1);
        if cells_count > 5_000_000 {
            return Err(EngineError::new(EngineErrorCode::TooLarge, "El rango es demasiado grande para copiarlo."));
        }
        let model = self.model();
        let ws = &model.workbook.worksheets[sheet_index as usize];
        let theme = &model.workbook.theme;
        let mut cells = Vec::new();
        let mut text = String::new();
        let mut html = String::from(
            "<html><head><meta charset=\"utf-8\"></head><body><table border=\"0\" cellspacing=\"0\" cellpadding=\"0\" style=\"border-collapse:collapse\">",
        );
        let hidden = super::queries::hidden_rows(ws);
        for row in range.r0..=range.r1 {
            let mut line = Vec::new();
            let (r, visible) = (ic_row(row), !hidden.contains(&ic_row(row)));
            if visible {
                html.push_str("<tr>");
            }
            let mut fields = Vec::new();
            for col in range.c0..=range.c1 {
                let c = ic_col(col);
                // Covered cells of a merge are emitted through colspan/rowspan.
                let merge = ws.merged_cell_containing(r, c);
                let covered = merge.is_some_and(|m| (m.row, m.column) != (r, c));
                let style = model.get_style_for_cell(sheet_index, r, c).unwrap_or_default();
                let (input, value_input, shown, is_number, is_spill) = match ws.cell(r, c) {
                    None => (String::new(), String::new(), String::new(), false, false),
                    Some(cell) => {
                        let raw = raw_value(&cell, &model.workbook.shared_strings);
                        let shown = display::display(&raw, &style.num_fmt).text.into_owned();
                        let value_input = self.ic_input(&display::canonical_value_input(&raw, style.quote_prefix));
                        let input = if cell.has_formula() {
                            model.get_localized_cell_content(sheet_index, r, c).unwrap_or_default()
                        } else {
                            value_input.clone()
                        };
                        let is_spill = matches!(&*cell, Cell::SpillCell { .. });
                        (input, value_input, shown, matches!(raw, RawValue::Number(_)), is_spill)
                    }
                };
                fields.push(tsv_field(&shown));
                if visible && !covered {
                    let css = css_of(&to_cell_style(&style, &self.base_style, theme, None), is_number);
                    let mut span = String::new();
                    if let Some(m) = merge {
                        let rows = m.last_row().min(ic_row(range.r1)) - r + 1;
                        let cols = m.last_column().min(ic_col(range.c1)) - c + 1;
                        if rows > 1 {
                            span.push_str(&format!(" rowspan=\"{rows}\""));
                        }
                        if cols > 1 {
                            span.push_str(&format!(" colspan=\"{cols}\""));
                        }
                    }
                    html.push_str(&format!("<td{span} style=\"{css}\">{}</td>", escape_html(&shown)));
                }
                line.push(ClipCell { input, value_input, style, link: ws.links.get(&(r, c)).cloned(), is_spill });
            }
            if visible {
                html.push_str("</tr>");
                text.push_str(&fields.join("\t"));
                text.push_str("\r\n");
            }
            cells.push(line);
        }
        html.push_str("</table></body></html>");
        let id = NEXT_CLIP.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        store(Clip { id, owner: self.token(), sheet, range, cells });
        Ok(ClipboardData { clip_id: id, text, html })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tsv_quoting() {
        assert_eq!(tsv_field("a"), "a");
        assert_eq!(tsv_field("a\tb"), "\"a\tb\"");
        assert_eq!(tsv_field("di \"hola\""), "\"di \"\"hola\"\"\"");
        assert_eq!(escape_html("<b>&"), "&lt;b&gt;&amp;");
    }
}
