//! Render style table and conversions between IronCalc styles and the
//! contract's `CellStyle` / `StylePatch`.
//!
//! Render `StyleId`s are per document and stable for its lifetime: 0 is the
//! workbook default style; every other id maps to one resolved `CellStyle`
//! (theme colors resolved, number-format color and conditional formatting
//! applied). Equal visual styles share one id.

use std::collections::HashMap;

use ironcalc_base::types::{
    Alignment, BorderItem, BorderStyle as IcBorderStyle, Color, HorizontalAlignment, Style, Theme, VerticalAlignment,
};

use crate::engine::types::{
    BorderSpec, BorderStyle, CellStyle, DoubleTag, HAlign, StyleId, StylePatch, Underline, VAlign,
};

/// Interns resolved `CellStyle`s into render ids.
#[derive(Debug)]
pub struct StyleTable {
    styles: Vec<CellStyle>,
    by_value: HashMap<String, StyleId>,
    /// Fast path: (IronCalc style index, number-format color) → id.
    by_xf: HashMap<(i32, Option<&'static str>), StyleId>,
}

impl Default for StyleTable {
    fn default() -> Self {
        let mut by_value = HashMap::new();
        by_value.insert(style_key(&CellStyle::default()), 0);
        Self { styles: vec![CellStyle::default()], by_value, by_xf: HashMap::new() }
    }
}

fn style_key(style: &CellStyle) -> String {
    serde_json::to_string(style).unwrap_or_default()
}

impl StyleTable {
    pub fn intern(&mut self, style: CellStyle) -> StyleId {
        let key = style_key(&style);
        if let Some(id) = self.by_value.get(&key) {
            return *id;
        }
        let id = self.styles.len() as StyleId;
        self.styles.push(style);
        self.by_value.insert(key, id);
        id
    }

    pub fn cached_xf(&self, xf: i32, color: Option<&'static str>) -> Option<StyleId> {
        self.by_xf.get(&(xf, color)).copied()
    }

    pub fn cache_xf(&mut self, xf: i32, color: Option<&'static str>, id: StyleId) {
        self.by_xf.insert((xf, color), id);
    }

    pub fn get(&self, id: StyleId) -> Option<&CellStyle> {
        self.styles.get(id as usize)
    }

    pub fn len(&self) -> usize {
        self.styles.len()
    }
}

/// Lower-case `#rrggbb` of an IronCalc color (theme colors resolved).
pub fn resolve_color(color: &Color, theme: &Theme) -> Option<String> {
    match color {
        Color::None => None,
        other => {
            let rgb = other.to_rgb(theme);
            if rgb.len() == 7 && rgb.starts_with('#') {
                Some(rgb.to_ascii_lowercase())
            } else {
                None
            }
        }
    }
}

fn border_style_out(style: &IcBorderStyle) -> BorderStyle {
    match style {
        IcBorderStyle::Thin => BorderStyle::Thin,
        IcBorderStyle::Medium => BorderStyle::Medium,
        IcBorderStyle::Thick => BorderStyle::Thick,
        IcBorderStyle::Double => BorderStyle::Double,
        IcBorderStyle::Dotted => BorderStyle::Dotted,
        IcBorderStyle::MediumDashed
        | IcBorderStyle::MediumDashDot
        | IcBorderStyle::MediumDashDotDot
        | IcBorderStyle::SlantDashDot => BorderStyle::Dashed,
    }
}

/// IronCalc has no thin `dashed` nor `hair`: they map to the closest styles.
pub fn border_style_in(style: BorderStyle) -> IcBorderStyle {
    match style {
        BorderStyle::Thin | BorderStyle::Hair => IcBorderStyle::Thin,
        BorderStyle::Medium => IcBorderStyle::Medium,
        BorderStyle::Thick => IcBorderStyle::Thick,
        BorderStyle::Dashed => IcBorderStyle::MediumDashed,
        BorderStyle::Dotted => IcBorderStyle::Dotted,
        BorderStyle::Double => IcBorderStyle::Double,
    }
}

fn border_out(item: &Option<BorderItem>, theme: &Theme) -> Option<BorderSpec> {
    item.as_ref().map(|b| BorderSpec {
        style: border_style_out(&b.style),
        color: resolve_color(&b.color, theme).unwrap_or_else(|| "#000000".to_string()),
    })
}

/// Resolves an IronCalc style into the contract's render style. Fields equal
/// to the workbook default (`base`, style index 0) are left out.
pub fn to_cell_style(style: &Style, base: &Style, theme: &Theme, nf_color: Option<&str>) -> CellStyle {
    let font = &style.font;
    let mut out = CellStyle {
        font_family: (font.name != base.font.name && !font.name.is_empty()).then(|| font.name.clone()),
        font_size: (font.sz != base.font.sz && font.sz > 0).then_some(f64::from(font.sz)),
        bold: font.b.then_some(true),
        italic: font.i.then_some(true),
        underline: font.u.then_some(Underline::Single(true)),
        strike: font.strike.then_some(true),
        color: resolve_color(&font.color, theme),
        fill: resolve_color(&style.fill.color, theme),
        ..CellStyle::default()
    };
    if out.color.is_some() && font.color == base.font.color {
        out.color = None;
    }
    if let Some(color) = nf_color {
        out.color = Some(color.to_string());
    }
    if let Some(alignment) = &style.alignment {
        out.h_align = match alignment.horizontal {
            HorizontalAlignment::General => None,
            HorizontalAlignment::Left => Some(HAlign::Left),
            HorizontalAlignment::Center => Some(HAlign::Center),
            HorizontalAlignment::Right => Some(HAlign::Right),
            HorizontalAlignment::Fill => Some(HAlign::Fill),
            HorizontalAlignment::Justify | HorizontalAlignment::Distributed => Some(HAlign::Justify),
            HorizontalAlignment::CenterContinuous => Some(HAlign::CenterContinuous),
        };
        out.v_align = match alignment.vertical {
            VerticalAlignment::Bottom => None,
            VerticalAlignment::Top => Some(VAlign::Top),
            VerticalAlignment::Center | VerticalAlignment::Justify | VerticalAlignment::Distributed => {
                Some(VAlign::Middle)
            }
        };
        out.wrap = alignment.wrap_text.then_some(true);
    }
    out.border_top = border_out(&style.border.top, theme);
    out.border_right = border_out(&style.border.right, theme);
    out.border_bottom = border_out(&style.border.bottom, theme);
    out.border_left = border_out(&style.border.left, theme);
    out
}

/// Normalizes a number format code coming from the UI (`General` → IronCalc's `general`).
pub fn normalize_num_fmt(code: &str) -> String {
    if code.eq_ignore_ascii_case("general") || code.is_empty() {
        "general".to_string()
    } else {
        code.to_string()
    }
}

/// Number format code for the UI (`general` → `General`).
pub fn display_num_fmt(code: &str) -> String {
    if code.eq_ignore_ascii_case("general") {
        "General".to_string()
    } else {
        code.to_string()
    }
}

/// `#rrggbb` (any case) → IronCalc color; invalid input is an error message.
pub fn color_in(value: &str) -> Result<Color, String> {
    let upper = value.trim().to_ascii_uppercase();
    Color::from_rgb(&upper).map_err(|_| format!("Color no válido: {value}"))
}

/// Applies a patch to a full style. `base` provides the defaults for `null`s.
pub fn apply_patch(style: &mut Style, patch: &StylePatch, base: &Style) -> Result<(), String> {
    if let Some(family) = &patch.font_family {
        style.font.name = family.clone().unwrap_or_else(|| base.font.name.clone());
    }
    if let Some(size) = &patch.font_size {
        style.font.sz = match size {
            Some(size) => (size.round() as i32).clamp(1, 409),
            None => base.font.sz,
        };
    }
    if let Some(b) = patch.bold {
        style.font.b = b;
    }
    if let Some(i) = patch.italic {
        style.font.i = i;
    }
    if let Some(u) = patch.underline {
        style.font.u = !matches!(u, Underline::Single(false));
    }
    if let Some(s) = patch.strike {
        style.font.strike = s;
    }
    if let Some(color) = &patch.color {
        style.font.color = match color {
            Some(c) => color_in(c)?,
            None => base.font.color.clone(),
        };
    }
    if let Some(fill) = &patch.fill {
        style.fill.color = match fill {
            Some(c) => color_in(c)?,
            None => Color::None,
        };
    }
    if patch.h_align.is_some() || patch.v_align.is_some() || patch.wrap.is_some() {
        let alignment = style.alignment.get_or_insert_with(Alignment::default);
        if let Some(h) = &patch.h_align {
            alignment.horizontal = h.map(h_align_in).unwrap_or_default();
        }
        if let Some(v) = &patch.v_align {
            alignment.vertical = v.map(v_align_in).unwrap_or_default();
        }
        if let Some(w) = patch.wrap {
            alignment.wrap_text = w;
        }
        if *alignment == Alignment::default() {
            style.alignment = None;
        }
    }
    if let Some(fmt) = &patch.num_fmt {
        style.num_fmt = normalize_num_fmt(fmt);
    }
    Ok(())
}

pub fn h_align_in(h: HAlign) -> HorizontalAlignment {
    match h {
        HAlign::General => HorizontalAlignment::General,
        HAlign::Left => HorizontalAlignment::Left,
        HAlign::Center => HorizontalAlignment::Center,
        HAlign::Right => HorizontalAlignment::Right,
        HAlign::Fill => HorizontalAlignment::Fill,
        HAlign::Justify => HorizontalAlignment::Justify,
        HAlign::CenterContinuous => HorizontalAlignment::CenterContinuous,
    }
}

pub fn v_align_in(v: VAlign) -> VerticalAlignment {
    match v {
        VAlign::Top => VerticalAlignment::Top,
        VAlign::Middle => VerticalAlignment::Center,
        VAlign::Bottom => VerticalAlignment::Bottom,
    }
}

/// `(style path, value)` pairs for `UserModel::update_range_style`, used for
/// whole rows/columns (IronCalc stores row/column styles there). `None` when
/// the patch needs something that path API cannot express (font family).
pub fn patch_to_paths(patch: &StylePatch, base: &Style) -> Option<Vec<(&'static str, String)>> {
    if patch.font_family.is_some() {
        return None;
    }
    let mut paths = Vec::new();
    if let Some(size) = &patch.font_size {
        let sz = size.map(|s| (s.round() as i32).clamp(1, 409)).unwrap_or(base.font.sz);
        paths.push(("font.size", sz.to_string()));
    }
    let flag = |v: bool| if v { "true".to_string() } else { "false".to_string() };
    if let Some(b) = patch.bold {
        paths.push(("font.b", flag(b)));
    }
    if let Some(i) = patch.italic {
        paths.push(("font.i", flag(i)));
    }
    if let Some(u) = patch.underline {
        paths.push(("font.u", flag(!matches!(u, Underline::Single(false)))));
    }
    if let Some(s) = patch.strike {
        paths.push(("font.strike", flag(s)));
    }
    if let Some(color) = &patch.color {
        paths.push(("font.color", color.clone().map(|c| c.to_ascii_uppercase()).unwrap_or_default()));
    }
    if let Some(fill) = &patch.fill {
        paths.push(("fill.color", fill.clone().map(|c| c.to_ascii_uppercase()).unwrap_or_default()));
    }
    if let Some(h) = &patch.h_align {
        paths.push(("alignment.horizontal", h_align_in(h.unwrap_or(HAlign::General)).to_string()));
    }
    if let Some(v) = &patch.v_align {
        paths.push(("alignment.vertical", v_align_in(v.unwrap_or(VAlign::Bottom)).to_string()));
    }
    if let Some(w) = patch.wrap {
        paths.push(("alignment.wrap_text", flag(w)));
    }
    if let Some(fmt) = &patch.num_fmt {
        paths.push(("num_fmt", normalize_num_fmt(fmt)));
    }
    Some(paths)
}

/// For tests and HTML export: whether an underline is set.
pub fn has_underline(style: &CellStyle) -> bool {
    matches!(style.underline, Some(Underline::Single(true)) | Some(Underline::Double(DoubleTag::Double)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_style_maps_to_empty_cell_style() {
        let base = Style::default();
        let theme = Theme::default();
        assert_eq!(to_cell_style(&base, &base, &theme, None), CellStyle::default());
    }

    #[test]
    fn patch_and_resolve_round_trip() {
        let base = Style::default();
        let mut style = base.clone();
        let patch: StylePatch = serde_json::from_str(
            r##"{"bold":true,"color":"#ff0000","fill":"#00ff00","hAlign":"center","vAlign":"middle","wrap":true,"fontSize":14,"numFmt":"0.00"}"##,
        )
        .unwrap();
        apply_patch(&mut style, &patch, &base).unwrap();
        let out = to_cell_style(&style, &base, &Theme::default(), None);
        assert_eq!(out.bold, Some(true));
        assert_eq!(out.color.as_deref(), Some("#ff0000"));
        assert_eq!(out.fill.as_deref(), Some("#00ff00"));
        assert_eq!(out.h_align, Some(HAlign::Center));
        assert_eq!(out.v_align, Some(VAlign::Middle));
        assert_eq!(out.wrap, Some(true));
        assert_eq!(out.font_size, Some(14.0));
        assert_eq!(style.num_fmt, "0.00");

        let reset: StylePatch = serde_json::from_str(r#"{"fill":null,"hAlign":null,"vAlign":null,"wrap":false}"#).unwrap();
        apply_patch(&mut style, &reset, &base).unwrap();
        assert!(style.alignment.is_none());
        assert_eq!(to_cell_style(&style, &base, &Theme::default(), None).fill, None);
    }

    #[test]
    fn theme_colors_resolve_to_hex() {
        let theme = Theme::default();
        assert_eq!(resolve_color(&Color::Theme(4, 0.0), &theme).as_deref(), Some("#4472c4"));
        assert_eq!(resolve_color(&Color::None, &theme), None);
    }

    #[test]
    fn table_interns_equal_styles_once() {
        let mut table = StyleTable::default();
        let bold = CellStyle { bold: Some(true), ..CellStyle::default() };
        let a = table.intern(bold.clone());
        let b = table.intern(bold);
        assert_eq!(a, b);
        assert_eq!(a, 1);
        assert_eq!(table.intern(CellStyle::default()), 0);
    }
}
