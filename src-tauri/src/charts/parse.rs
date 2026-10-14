//! DrawingML `c:chartSpace` -> `ChartDraft`.

use super::dom::{self, Element};
use crate::engine::types::{
    AnchorPoint, ChartAnchor, ChartDraft, ChartGrouping, ChartSeries, ChartType, EngineError,
    EngineResult, LegendPosition,
};

/// One supported plot element of the plot area (`c:barChart`, `c:lineChart`…).
struct Plot<'a> {
    el: &'a Element,
    chart_type: ChartType,
    grouping: ChartGrouping,
}

pub fn parse(xml: &str) -> EngineResult<Option<ChartDraft>> {
    let root = dom::parse(xml).map_err(|e| {
        EngineError::new(
            crate::engine::types::EngineErrorCode::Parse,
            format!("XML de gráfico no válido: {e}"),
        )
    })?;
    if root.name != "chartSpace" {
        return Ok(None);
    }
    let Some(chart) = root.child("chart") else {
        return Ok(None);
    };
    let Some(plot_area) = chart.child("plotArea") else {
        return Ok(None);
    };

    let plots: Vec<Plot> = plot_area.children.iter().filter_map(plot_of).collect();
    let Some(primary) = plots.first() else {
        return Ok(None);
    };

    // Combo charts: category charts drawn vertically (column/line/area) can be
    // combined; everything else keeps only the first plot. The original part
    // is preserved byte-for-byte on save while the chart is not edited.
    let combinable =
        |t: ChartType| matches!(t, ChartType::Column | ChartType::Line | ChartType::Area);
    let mut ordered: Vec<(u32, usize, ChartSeries)> = Vec::new();
    for (plot_index, plot) in plots.iter().enumerate() {
        let joins = plot_index == 0
            || plot.chart_type == primary.chart_type
            || (combinable(primary.chart_type) && combinable(plot.chart_type));
        if !joins {
            continue;
        }
        let override_type = (plot.chart_type != primary.chart_type).then_some(plot.chart_type);
        for ser in plot.el.children_named("ser") {
            if let Some(series) = parse_series(ser, primary.chart_type, override_type) {
                let order = ser
                    .child_val("order")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(u32::MAX);
                ordered.push((order, ordered.len(), series));
            }
        }
    }
    if ordered.is_empty() {
        return Ok(None);
    }
    ordered.sort_by_key(|(order, seq, _)| (*order, *seq));
    let series: Vec<ChartSeries> = ordered.into_iter().map(|(_, _, s)| s).collect();

    let title = match chart.child("title") {
        Some(title) => text_of(title),
        None => None,
    };
    let auto_title_deleted = chart
        .child_val("autoTitleDeleted")
        .map(is_true)
        .unwrap_or(false);
    let title = title.or_else(|| {
        // Excel shows the series name as the default title of single-series charts.
        if !auto_title_deleted && series.len() == 1 {
            series[0].name.clone()
        } else {
            None
        }
    });

    let legend = match chart.child("legend") {
        None => LegendPosition::None,
        Some(legend) => match legend.child_val("legendPos") {
            Some("l") => LegendPosition::Left,
            Some("t") => LegendPosition::Top,
            Some("b") => LegendPosition::Bottom,
            _ => LegendPosition::Right,
        },
    };

    let (x_axis_title, y_axis_title) = axis_titles(plot_area, primary);

    Ok(Some(ChartDraft {
        sheet: 0,
        chart_type: primary.chart_type,
        title,
        series,
        anchor: ChartAnchor {
            from: AnchorPoint {
                row: 0,
                col: 0,
                dx: 0.0,
                dy: 0.0,
            },
            to: AnchorPoint {
                row: 0,
                col: 0,
                dx: 0.0,
                dy: 0.0,
            },
        },
        legend,
        grouping: primary.grouping,
        x_axis_title,
        y_axis_title,
    }))
}

fn is_true(v: &str) -> bool {
    v == "1" || v.eq_ignore_ascii_case("true")
}

fn grouping_of(el: &Element, default: ChartGrouping) -> ChartGrouping {
    match el.child_val("grouping") {
        Some("clustered") => ChartGrouping::Clustered,
        Some("stacked") => ChartGrouping::Stacked,
        Some("percentStacked") => ChartGrouping::PercentStacked,
        Some("standard") => ChartGrouping::Standard,
        _ => default,
    }
}

fn plot_of(el: &Element) -> Option<Plot<'_>> {
    let (chart_type, grouping) = match el.name.as_str() {
        "barChart" | "bar3DChart" => {
            let ty = if el.child_val("barDir") == Some("bar") {
                ChartType::Bar
            } else {
                ChartType::Column
            };
            let grouping = match grouping_of(el, ChartGrouping::Clustered) {
                // 3-D "standard" columns render as clustered in 2-D.
                ChartGrouping::Standard => ChartGrouping::Clustered,
                g => g,
            };
            (ty, grouping)
        }
        "lineChart" | "line3DChart" => (ChartType::Line, grouping_of(el, ChartGrouping::Standard)),
        "areaChart" | "area3DChart" => (ChartType::Area, grouping_of(el, ChartGrouping::Standard)),
        "pieChart" | "pie3DChart" => (ChartType::Pie, ChartGrouping::Standard),
        "doughnutChart" => (ChartType::Doughnut, ChartGrouping::Standard),
        "scatterChart" => (ChartType::Scatter, ChartGrouping::Standard),
        _ => return None,
    };
    Some(Plot {
        el,
        chart_type,
        grouping,
    })
}

/// Formula of a data source (`c:cat`, `c:val`, `c:xVal`, `c:yVal`).
fn ref_of(source: Option<&Element>) -> Option<String> {
    let source = source?;
    for kind in ["numRef", "strRef", "multiLvlStrRef"] {
        if let Some(f) = source.path(&[kind, "f"]) {
            let f = f.text.trim();
            if !f.is_empty() {
                return Some(f.to_string());
            }
        }
    }
    None
}

fn parse_series(
    ser: &Element,
    primary: ChartType,
    override_type: Option<ChartType>,
) -> Option<ChartSeries> {
    let effective = override_type.unwrap_or(primary);
    let (cat_el, val_el) = if effective == ChartType::Scatter {
        (ser.child("xVal"), ser.child("yVal"))
    } else {
        (ser.child("cat"), ser.child("val"))
    };
    let values_ref = ref_of(val_el)?;
    let categories_ref = ref_of(cat_el);

    let (name_ref, name) = match ser.child("tx") {
        Some(tx) => {
            if let Some(str_ref) = tx.child("strRef") {
                let f = str_ref
                    .child("f")
                    .map(|f| f.text.trim().to_string())
                    .filter(|f| !f.is_empty());
                let cached = str_ref
                    .path(&["strCache", "pt", "v"])
                    .map(|v| v.text.clone());
                (f, cached)
            } else {
                (None, tx.child("v").map(|v| v.text.clone()))
            }
        }
        None => (None, None),
    };

    let color = if matches!(effective, ChartType::Pie | ChartType::Doughnut) {
        None
    } else {
        series_color(ser)
    };

    Some(ChartSeries {
        name_ref,
        name,
        categories_ref,
        values_ref,
        color,
        chart_type: override_type,
    })
}

fn series_color(ser: &Element) -> Option<String> {
    let candidates: [&[&str]; 4] = [
        &["spPr", "solidFill"],
        &["spPr", "ln", "solidFill"],
        &["marker", "spPr", "solidFill"],
        &["marker", "spPr", "ln", "solidFill"],
    ];
    candidates
        .iter()
        .find_map(|path| ser.path(path).and_then(color_of_fill))
}

/// Office 2013–2022 default theme colors (accent1..6, dk1/lt1, dk2/lt2).
fn scheme_color(name: &str) -> Option<u32> {
    Some(match name {
        "accent1" => 0x4472C4,
        "accent2" => 0xED7D31,
        "accent3" => 0xA5A5A5,
        "accent4" => 0xFFC000,
        "accent5" => 0x5B9BD5,
        "accent6" => 0x70AD47,
        "tx1" | "dk1" => 0x000000,
        "bg1" | "lt1" => 0xFFFFFF,
        "tx2" | "dk2" => 0x44546A,
        "bg2" | "lt2" => 0xE7E6E6,
        "hlink" => 0x0563C1,
        "folHlink" => 0x954F72,
        _ => return None,
    })
}

fn color_of_fill(fill: &Element) -> Option<String> {
    let (base, el) = if let Some(c) = fill.child("srgbClr") {
        (u32::from_str_radix(c.attr("val")?, 16).ok()?, c)
    } else if let Some(c) = fill.child("schemeClr") {
        (scheme_color(c.attr("val")?)?, c)
    } else {
        let c = fill.child("sysClr")?;
        (u32::from_str_radix(c.attr("lastClr")?, 16).ok()?, c)
    };
    let pct = |name: &str| {
        el.child_val(name)
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| v / 100_000.0)
    };
    let (lum_mod, lum_off) = (pct("lumMod"), pct("lumOff"));
    let rgb = if lum_mod.is_some() || lum_off.is_some() {
        apply_luminance(base, lum_mod.unwrap_or(1.0), lum_off.unwrap_or(0.0))
    } else {
        base
    };
    Some(format!("#{:06X}", rgb & 0xFF_FFFF))
}

/// DrawingML `lumMod`/`lumOff`: scales and offsets the HSL luminance.
fn apply_luminance(rgb: u32, lum_mod: f64, lum_off: f64) -> u32 {
    let r = ((rgb >> 16) & 0xFF) as f64 / 255.0;
    let g = ((rgb >> 8) & 0xFF) as f64 / 255.0;
    let b = (rgb & 0xFF) as f64 / 255.0;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    let (h, s) = if d == 0.0 {
        (0.0, 0.0)
    } else {
        let s = if l > 0.5 {
            d / (2.0 - max - min)
        } else {
            d / (max + min)
        };
        let h = if max == r {
            ((g - b) / d).rem_euclid(6.0)
        } else if max == g {
            (b - r) / d + 2.0
        } else {
            (r - g) / d + 4.0
        };
        (h / 6.0, s)
    };
    let l = (l * lum_mod + lum_off).clamp(0.0, 1.0);
    let (r, g, b) = hsl_to_rgb(h, s, l);
    let to = |v: f64| ((v * 255.0).round().clamp(0.0, 255.0)) as u32;
    (to(r) << 16) | (to(g) << 8) | to(b)
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        return (l, l, l);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue = |mut t: f64| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (hue(h + 1.0 / 3.0), hue(h), hue(h - 1.0 / 3.0))
}

/// Text of a `c:title` (rich text paragraphs joined by `\n`, or a cached ref).
fn text_of(title: &Element) -> Option<String> {
    let tx = title.child("tx")?;
    if let Some(rich) = tx.child("rich") {
        let paragraphs: Vec<String> = rich
            .children_named("p")
            .map(|p| {
                let mut runs = Vec::new();
                p.descendants("t", &mut runs);
                runs.iter().map(|t| t.text.as_str()).collect::<String>()
            })
            .collect();
        let text = paragraphs.join("\n");
        let text = text.trim_end_matches('\n');
        return (!text.trim().is_empty()).then(|| text.to_string());
    }
    if let Some(v) = tx.path(&["strRef", "strCache", "pt", "v"]) {
        return (!v.text.is_empty()).then(|| v.text.clone());
    }
    None
}

fn axis_titles(plot_area: &Element, primary: &Plot<'_>) -> (Option<String>, Option<String>) {
    if matches!(primary.chart_type, ChartType::Pie | ChartType::Doughnut) {
        return (None, None);
    }
    let ids: Vec<&str> = primary
        .el
        .children_named("axId")
        .filter_map(|a| a.attr("val"))
        .collect();
    let axes: Vec<&Element> = plot_area
        .children
        .iter()
        .filter(|el| matches!(el.name.as_str(), "catAx" | "valAx" | "dateAx" | "serAx"))
        .filter(|el| ids.is_empty() || el.child_val("axId").is_some_and(|id| ids.contains(&id)))
        .collect();
    let mut x = None;
    let mut y = None;
    for axis in axes {
        let title = axis.child("title").and_then(text_of);
        let is_x = if primary.chart_type == ChartType::Scatter {
            matches!(axis.child_val("axPos"), Some("b") | Some("t"))
        } else {
            matches!(axis.name.as_str(), "catAx" | "dateAx")
        };
        if axis.name == "serAx" {
            continue;
        }
        if is_x {
            x = x.or(title);
        } else {
            y = y.or(title);
        }
    }
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::apply_luminance;

    #[test]
    fn luminance_modulation_matches_office() {
        // accent1 "lighter 40%" = lumMod 60% lumOff 40% -> #8FAADC in Office.
        assert_eq!(apply_luminance(0x4472C4, 0.6, 0.4), 0x8FAADC);
        // accent2 "darker 25%" = lumMod 75% -> #C55A11.
        assert_eq!(apply_luminance(0xED7D31, 0.75, 0.0), 0xC55A11);
    }
}
