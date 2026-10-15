//! `ChartSpec` -> DrawingML `c:chartSpace` part. Follows the element order of
//! the ECMA-376 schema and what Excel/xlsxwriter emit, so Excel opens the file
//! without repairs. Number caches are omitted: Excel reads the referenced
//! cells on load.

use std::fmt::Write as _;

use quick_xml::escape::escape;

use crate::engine::types::{
    ChartGrouping, ChartSeries, ChartSpec, ChartType, EngineError, EngineErrorCode, EngineResult,
    LegendPosition,
};

const NS: &str = r#"xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships""#;
const AX_CAT: u32 = 50_010_001;
const AX_VAL: u32 = 50_010_002;
/// Light gray used by Excel 2013+ for gridlines and axis lines (tx1 15%/85%).
const LINE_GRAY: &str = "D9D9D9";
/// Text gray used by Excel 2013+ for chart text (tx1 65%/35%).
const TEXT_GRAY: &str = "595959";

pub fn write(chart: &ChartSpec, sheet_name: &str) -> EngineResult<String> {
    let d = &chart.draft;
    if d.series.is_empty() {
        return Err(EngineError::new(
            EngineErrorCode::InvalidOp,
            "El gráfico no tiene series.",
        ));
    }
    let mut x = String::with_capacity(4096);
    x.push_str(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    x.push('\n');
    let _ = write!(x, "<c:chartSpace {NS}>");
    x.push_str(r#"<c:date1904 val="0"/><c:lang val="es-ES"/><c:roundedCorners val="0"/>"#);
    x.push_str("<c:chart>");
    match &d.title {
        Some(title) if !title.trim().is_empty() => {
            write_title(&mut x, title, 1400, false);
            x.push_str(r#"<c:autoTitleDeleted val="0"/>"#);
        }
        _ => x.push_str(r#"<c:autoTitleDeleted val="1"/>"#),
    }
    x.push_str("<c:plotArea><c:layout/>");

    let mut idx = 0u32;
    match d.chart_type {
        ChartType::Pie | ChartType::Doughnut => {
            write_pie(&mut x, d.chart_type, &d.series, sheet_name, &mut idx);
        }
        ChartType::Scatter => {
            write_scatter(&mut x, &d.series, sheet_name, &mut idx);
            write_val_axis(
                &mut x,
                AX_CAT,
                AX_VAL,
                "b",
                false,
                d.x_axis_title.as_deref(),
                "General",
                "midCat",
            );
            write_val_axis(
                &mut x,
                AX_VAL,
                AX_CAT,
                "l",
                true,
                d.y_axis_title.as_deref(),
                "General",
                "midCat",
            );
        }
        primary => {
            let horizontal = primary == ChartType::Bar;
            // Combo: one plot element per effective type, primary first.
            let mut types: Vec<ChartType> = vec![primary];
            for s in &d.series {
                let t = effective_type(primary, s);
                if !types.contains(&t) {
                    types.push(t);
                }
            }
            for (i, t) in types.iter().enumerate() {
                let series: Vec<&ChartSeries> = d
                    .series
                    .iter()
                    .filter(|s| effective_type(primary, s) == *t)
                    .collect();
                let grouping = if i == 0 {
                    d.grouping
                } else {
                    ChartGrouping::Standard
                };
                write_category_plot(&mut x, *t, grouping, &series, sheet_name, &mut idx);
            }
            let percent = d.grouping == ChartGrouping::PercentStacked;
            let (cat_pos, val_pos) = if horizontal { ("l", "b") } else { ("b", "l") };
            write_cat_axis(&mut x, cat_pos, d.x_axis_title.as_deref());
            let fmt = if percent { "0%" } else { "General" };
            write_val_axis(
                &mut x,
                AX_VAL,
                AX_CAT,
                val_pos,
                true,
                d.y_axis_title.as_deref(),
                fmt,
                "between",
            );
        }
    }
    x.push_str("</c:plotArea>");

    let legend_pos = match d.legend {
        LegendPosition::None => None,
        LegendPosition::Right => Some("r"),
        LegendPosition::Left => Some("l"),
        LegendPosition::Top => Some("t"),
        LegendPosition::Bottom => Some("b"),
    };
    if let Some(pos) = legend_pos {
        let _ = write!(
            x,
            r#"<c:legend><c:legendPos val="{pos}"/><c:overlay val="0"/>"#
        );
        write_tx_pr(&mut x, 900);
        x.push_str("</c:legend>");
    }
    x.push_str(r#"<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>"#);
    // Chart area: white fill, thin light-gray border (Excel default look).
    let _ = write!(
        x,
        r#"<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="{LINE_GRAY}"/></a:solidFill><a:round/></a:ln></c:spPr>"#
    );
    write_tx_pr(&mut x, 900);
    x.push_str(r#"<c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>"#);
    x.push_str("</c:chartSpace>");
    Ok(x)
}

fn effective_type(primary: ChartType, s: &ChartSeries) -> ChartType {
    match (primary, s.chart_type) {
        (
            ChartType::Column | ChartType::Line | ChartType::Area,
            Some(t @ (ChartType::Column | ChartType::Line | ChartType::Area)),
        ) => t,
        _ => primary,
    }
}

/// Default text properties (Calibri-like body font, Excel gray).
fn write_tx_pr(x: &mut String, size: u32) {
    write_tx_pr_color(x, size, TEXT_GRAY);
}

fn write_tx_pr_color(x: &mut String, size: u32, color: &str) {
    let _ = write!(
        x,
        r#"<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="{size}" b="0"><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="es-ES"/></a:p></c:txPr>"#
    );
}

/// `c:title` with rich text; `\n` in the text becomes separate paragraphs.
fn write_title(x: &mut String, text: &str, size: u32, rotated: bool) {
    x.push_str("<c:title><c:tx><c:rich>");
    if rotated {
        x.push_str(r#"<a:bodyPr rot="-5400000" vert="horz"/>"#);
    } else {
        x.push_str("<a:bodyPr/>");
    }
    x.push_str("<a:lstStyle/>");
    for line in text.split('\n') {
        let _ = write!(
            x,
            r#"<a:p><a:pPr><a:defRPr sz="{size}" b="0"><a:solidFill><a:srgbClr val="{TEXT_GRAY}"/></a:solidFill></a:defRPr></a:pPr><a:r><a:rPr lang="es-ES" sz="{size}" b="0"><a:solidFill><a:srgbClr val="{TEXT_GRAY}"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r></a:p>"#,
            escape(line)
        );
    }
    x.push_str(r#"</c:rich></c:tx><c:overlay val="0"/></c:title>"#);
}

fn hex(color: &str) -> Option<String> {
    let h = color.trim().trim_start_matches('#');
    (h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| h.to_ascii_uppercase())
}

fn write_series_head(x: &mut String, s: &ChartSeries, sheet_name: &str, idx: u32) {
    let _ = write!(x, r#"<c:ser><c:idx val="{idx}"/><c:order val="{idx}"/>"#);
    if let Some(name_ref) = s.name_ref.as_deref().filter(|r| !r.trim().is_empty()) {
        let _ = write!(
            x,
            "<c:tx><c:strRef><c:f>{}</c:f>",
            escape(qualify_ref(name_ref, sheet_name))
        );
        if let Some(name) = &s.name {
            let _ = write!(
                x,
                r#"<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>{}</c:v></c:pt></c:strCache>"#,
                escape(name)
            );
        }
        x.push_str("</c:strRef></c:tx>");
    } else if let Some(name) = &s.name {
        let _ = write!(x, "<c:tx><c:v>{}</c:v></c:tx>", escape(name));
    }
}

fn write_ref(x: &mut String, wrapper: &str, kind: &str, formula: &str, sheet_name: &str) {
    let _ = write!(
        x,
        "<c:{wrapper}><c:{kind}><c:f>{}</c:f></c:{kind}></c:{wrapper}>",
        escape(qualify_ref(formula, sheet_name))
    );
}

fn write_category_plot(
    x: &mut String,
    t: ChartType,
    grouping: ChartGrouping,
    series: &[&ChartSeries],
    sheet_name: &str,
    idx: &mut u32,
) {
    match t {
        ChartType::Column | ChartType::Bar => {
            let grouping = match grouping {
                ChartGrouping::Standard => ChartGrouping::Clustered,
                g => g,
            };
            let dir = if t == ChartType::Bar { "bar" } else { "col" };
            let _ = write!(
                x,
                r#"<c:barChart><c:barDir val="{dir}"/><c:grouping val="{}"/><c:varyColors val="0"/>"#,
                grouping_name(grouping)
            );
            for s in series {
                write_series_head(x, s, sheet_name, *idx);
                if let Some(c) = s.color.as_deref().and_then(hex) {
                    let _ = write!(
                        x,
                        r#"<c:spPr><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>"#
                    );
                }
                x.push_str(r#"<c:invertIfNegative val="0"/>"#);
                if let Some(cat) = &s.categories_ref {
                    write_ref(x, "cat", "strRef", cat, sheet_name);
                }
                write_ref(x, "val", "numRef", &s.values_ref, sheet_name);
                x.push_str("</c:ser>");
                *idx += 1;
            }
            let overlap = if grouping == ChartGrouping::Clustered {
                -27
            } else {
                100
            };
            let gap = if grouping == ChartGrouping::Clustered {
                219
            } else {
                150
            };
            let _ = write!(
                x,
                r#"<c:gapWidth val="{gap}"/><c:overlap val="{overlap}"/><c:axId val="{AX_CAT}"/><c:axId val="{AX_VAL}"/></c:barChart>"#
            );
        }
        ChartType::Line | ChartType::Area => {
            let grouping = match grouping {
                ChartGrouping::Clustered => ChartGrouping::Standard,
                g => g,
            };
            let tag = if t == ChartType::Line {
                "lineChart"
            } else {
                "areaChart"
            };
            let _ = write!(
                x,
                r#"<c:{tag}><c:grouping val="{}"/><c:varyColors val="0"/>"#,
                grouping_name(grouping)
            );
            for s in series {
                write_series_head(x, s, sheet_name, *idx);
                let color = s.color.as_deref().and_then(hex);
                if t == ChartType::Line {
                    match &color {
                        Some(c) => {
                            let _ = write!(x, r#"<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:ln></c:spPr></c:marker>"#);
                        }
                        None => x.push_str(r#"<c:spPr><a:ln w="28575" cap="rnd"><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>"#),
                    }
                } else if let Some(c) = &color {
                    let _ = write!(
                        x,
                        r#"<c:spPr><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>"#
                    );
                }
                if let Some(cat) = &s.categories_ref {
                    write_ref(x, "cat", "strRef", cat, sheet_name);
                }
                write_ref(x, "val", "numRef", &s.values_ref, sheet_name);
                if t == ChartType::Line {
                    x.push_str(r#"<c:smooth val="0"/>"#);
                }
                x.push_str("</c:ser>");
                *idx += 1;
            }
            if t == ChartType::Line {
                x.push_str(r#"<c:marker val="1"/>"#);
            }
            let _ = write!(
                x,
                r#"<c:axId val="{AX_CAT}"/><c:axId val="{AX_VAL}"/></c:{tag}>"#
            );
        }
        _ => {}
    }
}

fn write_pie(
    x: &mut String,
    t: ChartType,
    series: &[ChartSeries],
    sheet_name: &str,
    idx: &mut u32,
) {
    let tag = if t == ChartType::Doughnut {
        "doughnutChart"
    } else {
        "pieChart"
    };
    let _ = write!(x, r#"<c:{tag}><c:varyColors val="1"/>"#);
    // A pie shows a single series (Excel ignores the rest); doughnuts show all rings.
    let take = if t == ChartType::Pie { 1 } else { series.len() };
    for s in series.iter().take(take) {
        write_series_head(x, s, sheet_name, *idx);
        x.push_str(r#"<c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr>"#);
        if let Some(cat) = &s.categories_ref {
            write_ref(x, "cat", "strRef", cat, sheet_name);
        }
        write_ref(x, "val", "numRef", &s.values_ref, sheet_name);
        x.push_str("</c:ser>");
        *idx += 1;
    }
    // Percentage labels inside the slices (white text), like Excel's "Style 3".
    x.push_str("<c:dLbls>");
    write_tx_pr_color(x, 900, "FFFFFF");
    if t == ChartType::Pie {
        x.push_str(r#"<c:dLblPos val="ctr"/>"#);
    }
    x.push_str(r#"<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>"#);
    if t == ChartType::Doughnut {
        let _ = write!(
            x,
            r#"<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:{tag}>"#
        );
    } else {
        let _ = write!(x, r#"<c:firstSliceAng val="0"/></c:{tag}>"#);
    }
}

fn write_scatter(x: &mut String, series: &[ChartSeries], sheet_name: &str, idx: &mut u32) {
    x.push_str(r#"<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>"#);
    for s in series {
        write_series_head(x, s, sheet_name, *idx);
        // Markers only: the connecting line is explicitly hidden.
        x.push_str(r#"<c:spPr><a:ln w="25400" cap="rnd"><a:noFill/><a:round/></a:ln></c:spPr>"#);
        match s.color.as_deref().and_then(hex) {
            Some(c) => {
                let _ = write!(
                    x,
                    r#"<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="{c}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="{c}"/></a:solidFill></a:ln></c:spPr></c:marker>"#
                );
            }
            None => x.push_str(r#"<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>"#),
        }
        if let Some(cat) = &s.categories_ref {
            write_ref(x, "xVal", "numRef", cat, sheet_name);
        }
        write_ref(x, "yVal", "numRef", &s.values_ref, sheet_name);
        x.push_str(r#"<c:smooth val="0"/></c:ser>"#);
        *idx += 1;
    }
    let _ = write!(
        x,
        r#"<c:axId val="{AX_CAT}"/><c:axId val="{AX_VAL}"/></c:scatterChart>"#
    );
}

fn axis_line(x: &mut String, visible: bool) {
    if visible {
        let _ = write!(
            x,
            r#"<c:spPr><a:noFill/><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="{LINE_GRAY}"/></a:solidFill><a:round/></a:ln></c:spPr>"#
        );
    } else {
        x.push_str(r#"<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>"#);
    }
}

fn write_cat_axis(x: &mut String, pos: &str, title: Option<&str>) {
    let _ = write!(
        x,
        r#"<c:catAx><c:axId val="{AX_CAT}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="{pos}"/>"#
    );
    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        write_title(x, t, 1000, pos == "l");
    }
    x.push_str(r#"<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>"#);
    axis_line(x, true);
    write_tx_pr(x, 900);
    let _ = write!(
        x,
        r#"<c:crossAx val="{AX_VAL}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>"#
    );
}

#[allow(clippy::too_many_arguments)]
fn write_val_axis(
    x: &mut String,
    id: u32,
    cross: u32,
    pos: &str,
    gridlines: bool,
    title: Option<&str>,
    fmt: &str,
    cross_between: &str,
) {
    let _ = write!(
        x,
        r#"<c:valAx><c:axId val="{id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="{pos}"/>"#
    );
    if gridlines {
        let _ = write!(
            x,
            r#"<c:majorGridlines><c:spPr><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="{LINE_GRAY}"/></a:solidFill><a:round/></a:ln></c:spPr></c:majorGridlines>"#
        );
    }
    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        write_title(x, t, 1000, pos == "l" || pos == "r");
    }
    let linked = if fmt == "General" { 1 } else { 0 };
    let _ = write!(
        x,
        r#"<c:numFmt formatCode="{fmt}" sourceLinked="{linked}"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>"#
    );
    // Value axes of category charts have no axis line in Excel 2013+; scatter X keeps one.
    axis_line(x, cross_between == "midCat" && !gridlines);
    write_tx_pr(x, 900);
    let _ = write!(
        x,
        r#"<c:crossAx val="{cross}"/><c:crosses val="autoZero"/><c:crossBetween val="{cross_between}"/></c:valAx>"#
    );
}

fn grouping_name(g: ChartGrouping) -> &'static str {
    match g {
        ChartGrouping::Clustered => "clustered",
        ChartGrouping::Stacked => "stacked",
        ChartGrouping::PercentStacked => "percentStacked",
        ChartGrouping::Standard => "standard",
    }
}

/// True when a sheet name must be quoted in a formula (`'Mi hoja'!A1`).
pub fn sheet_needs_quotes(name: &str) -> bool {
    let Some(first) = name.chars().next() else {
        return true;
    };
    if first.is_ascii_digit() || first == '.' {
        return true;
    }
    if !name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '.')
    {
        return true;
    }
    // Names that look like A1 or R1C1 references.
    let upper = name.to_ascii_uppercase();
    let letters = upper
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .count();
    let rest = &upper[letters..];
    if (1..=3).contains(&letters) && !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    let bytes = upper.as_bytes();
    if bytes[0] == b'R' {
        let after_r: String = upper[1..]
            .chars()
            .skip_while(|c| c.is_ascii_digit())
            .collect();
        if after_r.is_empty()
            || (after_r.starts_with('C') && after_r[1..].chars().all(|c| c.is_ascii_digit()))
        {
            return true;
        }
    }
    if bytes[0] == b'C' && upper[1..].chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    false
}

pub fn quote_sheet(name: &str) -> String {
    if sheet_needs_quotes(name) {
        format!("'{}'", name.replace('\'', "''"))
    } else {
        name.to_string()
    }
}

/// Adds the sheet name to unqualified references (`B2:B5` -> `Hoja1!B2:B5`)
/// and strips a leading `=`.
pub fn qualify_ref(formula: &str, sheet_name: &str) -> String {
    let f = formula.trim().trim_start_matches('=');
    if f.contains('!') {
        return f.to_string();
    }
    if let Some(inner) = f.strip_prefix('(').and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<String> = inner
            .split(',')
            .map(|p| qualify_ref(p, sheet_name))
            .collect();
        return format!("({})", parts.join(","));
    }
    format!("{}!{}", quote_sheet(sheet_name), f)
}
