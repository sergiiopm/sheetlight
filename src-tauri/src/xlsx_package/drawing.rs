//! SpreadsheetML drawing parts (`xl/drawings/drawingN.xml`): anchor
//! classification on open, anchor editing and new chart anchors on save.

use crate::engine::types::{AnchorPoint, ChartAnchor, ChartId};

use super::xml;

/// EMU per CSS pixel at 96 dpi.
pub const EMU_PER_PX: f64 = 9525.0;
/// Default sizes used to approximate one-cell / absolute anchors.
const DEFAULT_COL_PX: f64 = 64.0;
const DEFAULT_ROW_PX: f64 = 20.0;

pub const NS_XDR: &str = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
pub const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorKind {
    Chart,
    Image,
    Shape,
    Slicer,
    Other,
}

#[derive(Debug, Clone)]
pub struct ChartRef {
    pub rel_id: String,
    /// Chart part path, resolved.
    pub path: String,
    /// Id in `OriginalPackage::charts` when the chart writer models it.
    pub model: Option<ChartId>,
}

#[derive(Debug, Clone)]
pub struct Anchor {
    /// Byte span of the anchor element in the drawing XML.
    pub start: usize,
    pub end: usize,
    pub kind: AnchorKind,
    pub chart: Option<ChartRef>,
}

/// A drawing part linked from a sheet.
#[derive(Debug, Clone)]
pub struct Drawing {
    /// Part path of the drawing.
    pub path: String,
    pub xml: String,
    pub anchors: Vec<Anchor>,
}

/// Classifies the top-level anchors of a drawing part. `chart_path` maps a
/// `c:chart` relationship id to its part path.
pub fn parse(xml_text: &str, chart_path: impl Fn(&str) -> Option<String>) -> Vec<Anchor> {
    let elems = xml::elements(xml_text);
    let Some(root) = xml::root(&elems) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for anchor in xml::children(&elems, &root) {
        let inside = |name: &str| xml::descendants(&elems, anchor, name).next().is_some();
        // `c:chart` (not `cx:chart`, which is the chartex extension).
        let chart = xml::descendants(&elems, anchor, "chart").find(|e| e.prefix().is_none_or(|p| p != "cx") && e.attr("r:id").is_some());
        let kind = if inside("slicer") || inside("timeslicer") {
            AnchorKind::Slicer
        } else if chart.is_some() || inside("chart") {
            AnchorKind::Chart
        } else if inside("pic") {
            AnchorKind::Image
        } else if inside("sp") || inside("cxnSp") || inside("grpSp") {
            AnchorKind::Shape
        } else {
            AnchorKind::Other
        };
        let chart = chart.and_then(|c| {
            let rel_id = c.attr("r:id")?.into_owned();
            let path = chart_path(&rel_id)?;
            Some(ChartRef { rel_id, path, model: None })
        });
        out.push(Anchor { start: anchor.start, end: anchor.end, kind, chart });
    }
    out
}

/// Position of an anchor element in CSS px offsets (contract `ChartAnchor`).
pub fn chart_anchor(xml_text: &str, anchor: &Anchor) -> ChartAnchor {
    let text = &xml_text[anchor.start..anchor.end];
    let elems = xml::elements(text);
    let Some(root) = xml::root(&elems) else {
        return default_anchor();
    };
    let point = |name: &str| -> Option<AnchorPoint> {
        let e = xml::descendants(&elems, &root, name).next()?;
        let num = |n: &str| xml::child_text(text, &elems, e, n).and_then(|t| t.parse::<f64>().ok());
        Some(AnchorPoint { row: num("row")? as u32, col: num("col")? as u32, dx: num("colOff").unwrap_or(0.0) / EMU_PER_PX, dy: num("rowOff").unwrap_or(0.0) / EMU_PER_PX })
    };
    let ext = || -> Option<(f64, f64)> {
        let e = xml::children(&elems, &root).find(|e| e.local() == "ext")?;
        Some((e.attr("cx")?.parse::<f64>().ok()? / EMU_PER_PX, e.attr("cy")?.parse::<f64>().ok()? / EMU_PER_PX))
    };
    let advance = |from: AnchorPoint, (w, h): (f64, f64)| {
        let x = from.col as f64 * DEFAULT_COL_PX + from.dx + w;
        let y = from.row as f64 * DEFAULT_ROW_PX + from.dy + h;
        AnchorPoint { col: (x / DEFAULT_COL_PX) as u32, dx: x % DEFAULT_COL_PX, row: (y / DEFAULT_ROW_PX) as u32, dy: y % DEFAULT_ROW_PX }
    };
    match root.local() {
        "twoCellAnchor" => match (point("from"), point("to")) {
            (Some(from), Some(to)) => ChartAnchor { from, to },
            _ => default_anchor(),
        },
        "oneCellAnchor" => match (point("from"), ext()) {
            (Some(from), Some(size)) => ChartAnchor { from, to: advance(from, size) },
            _ => default_anchor(),
        },
        "absoluteAnchor" => {
            let pos = xml::children(&elems, &root).find(|e| e.local() == "pos");
            let x = pos.and_then(|p| p.attr("x")?.parse::<f64>().ok()).unwrap_or(0.0) / EMU_PER_PX;
            let y = pos.and_then(|p| p.attr("y")?.parse::<f64>().ok()).unwrap_or(0.0) / EMU_PER_PX;
            let origin = AnchorPoint { row: 0, col: 0, dx: 0.0, dy: 0.0 };
            let from = advance(origin, (x, y));
            match ext() {
                Some(size) => ChartAnchor { from, to: advance(from, size) },
                None => default_anchor(),
            }
        }
        _ => default_anchor(),
    }
}

/// Excel's default chart size: 8 columns x 15 rows starting at E2.
fn default_anchor() -> ChartAnchor {
    ChartAnchor { from: AnchorPoint { row: 1, col: 4, dx: 0.0, dy: 0.0 }, to: AnchorPoint { row: 16, col: 12, dx: 0.0, dy: 0.0 } }
}

fn emu(px: f64) -> i64 {
    (px.max(0.0) * EMU_PER_PX).round() as i64
}

/// A complete two-cell anchor holding a chart graphic frame. Namespaces are
/// declared on the anchor itself so it fits any drawing part.
pub fn chart_anchor_xml(anchor: &ChartAnchor, rel_id: &str, shape_id: u32, name: &str) -> String {
    let point = |tag: &str, p: &AnchorPoint| {
        format!(
            "<xdr:{tag}><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:{tag}>",
            p.col,
            emu(p.dx),
            p.row,
            emu(p.dy)
        )
    };
    format!(
        "<xdr:twoCellAnchor xmlns:xdr=\"{NS_XDR}\" xmlns:a=\"{NS_A}\" xmlns:r=\"{}\" editAs=\"oneCell\">{}{}<xdr:graphicFrame macro=\"\"><xdr:nvGraphicFramePr><xdr:cNvPr id=\"{shape_id}\" name=\"{}\"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/></xdr:xfrm><a:graphic><a:graphicData uri=\"{NS_C}\"><c:chart xmlns:c=\"{NS_C}\" r:id=\"{}\"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>",
        super::package::NS_RELATIONSHIPS,
        point("from", &anchor.from),
        point("to", &anchor.to),
        xml::escape(name),
        xml::escape(rel_id)
    )
}

pub fn empty_drawing_xml() -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<xdr:wsDr xmlns:xdr=\"{NS_XDR}\" xmlns:a=\"{NS_A}\" xmlns:r=\"{}\"></xdr:wsDr>",
        super::package::NS_RELATIONSHIPS
    )
}

/// Largest `cNvPr id` in a drawing (new shapes need unique ids).
pub fn max_shape_id(xml_text: &str) -> u32 {
    xml::elements(xml_text).iter().filter(|e| e.local() == "cNvPr").filter_map(|e| e.attr("id")?.parse::<u32>().ok()).max().unwrap_or(0)
}

/// Offset where new anchors go: just before the root's end tag.
pub fn insertion_point(xml_text: &str) -> usize {
    let elems = xml::elements(xml_text);
    match xml::root(&elems) {
        Some(root) if root.close_start != root.end => root.close_start,
        _ => xml_text.len(),
    }
}

/// Expands a self-closed root (`<xdr:wsDr .../>`) so anchors can be appended.
pub fn open_root(xml_text: &str) -> String {
    let elems = xml::elements(xml_text);
    if let Some(root) = xml::root(&elems) {
        if root.open_end == root.end && root.close_start == root.end {
            let tag = &xml_text[root.start..root.end];
            let opened = format!("{}></{}>", tag.trim_end_matches("/>").trim_end(), root.name);
            return format!("{}{}{}", &xml_text[..root.start], opened, &xml_text[root.end..]);
        }
    }
    xml_text.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DRAWING: &str = r#"<?xml version="1.0"?><xdr:wsDr xmlns:xdr="x" xmlns:a="a" xmlns:c="c" xmlns:r="r">
<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>95250</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>11</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Gráfico 1"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="1219200" cy="381000"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="7" name="Imagen"/></xdr:nvPicPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>
<xdr:twoCellAnchor><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="Rect"/></xdr:nvSpPr></xdr:sp></xdr:twoCellAnchor>
<mc:AlternateContent xmlns:mc="mc"><mc:Choice Requires="a14"><xdr:twoCellAnchor><xdr:graphicFrame><a:graphic><a:graphicData><sle:slicer xmlns:sle="s" name="Region"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor></mc:Choice></mc:AlternateContent>
</xdr:wsDr>"#;

    #[test]
    fn classifies_and_positions_anchors() {
        let anchors = parse(DRAWING, |id| (id == "rId1").then(|| "xl/charts/chart1.xml".to_string()));
        let kinds: Vec<_> = anchors.iter().map(|a| a.kind).collect();
        assert_eq!(kinds, [AnchorKind::Chart, AnchorKind::Image, AnchorKind::Shape, AnchorKind::Slicer]);
        assert_eq!(anchors[0].chart.as_ref().unwrap().path, "xl/charts/chart1.xml");
        let pos = chart_anchor(DRAWING, &anchors[0]);
        assert_eq!((pos.from.col, pos.from.row, pos.from.dx), (4, 1, 10.0));
        assert_eq!((pos.to.col, pos.to.row, pos.to.dy), (11, 16, 2.0));
        let pic = chart_anchor(DRAWING, &anchors[1]);
        assert_eq!((pic.to.col, pic.to.row), (2, 22), "128x40 px from A21");
        assert_eq!(max_shape_id(DRAWING), 7);
    }

    #[test]
    fn new_anchor_is_well_formed_and_reparses() {
        let pos = ChartAnchor { from: AnchorPoint { row: 2, col: 1, dx: 5.0, dy: 0.0 }, to: AnchorPoint { row: 10, col: 6, dx: 0.0, dy: 3.0 } };
        let anchor = chart_anchor_xml(&pos, "rId5", 9, "Gráfico <1>");
        let mut drawing = open_root(&empty_drawing_xml().replace("></xdr:wsDr>", "/>"));
        let at = insertion_point(&drawing);
        drawing.insert_str(at, &anchor);
        let anchors = parse(&drawing, |_| Some("c.xml".into()));
        assert_eq!(anchors.len(), 1);
        assert_eq!(anchors[0].chart.as_ref().unwrap().rel_id, "rId5");
        let back = chart_anchor(&drawing, &anchors[0]);
        assert_eq!(back, pos);
    }
}
