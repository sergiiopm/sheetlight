//! DrawingML chart XML <-> `ChartDraft` (WS6). Pure functions, no package
//! plumbing: `crate::xlsx_package` finds chart parts and anchors on open and
//! assembles drawing/chart parts on save.
//!
//! Supported plots: `barChart` (col/bar; clustered, stacked, percentStacked),
//! `lineChart`, `areaChart`, `pieChart`, `doughnutChart`, `scatterChart`; the
//! 3-D variants (`bar3DChart`, `line3DChart`, `pie3DChart`, `area3DChart`) map
//! to their 2-D type. Combo charts: column/line/area plots sharing the plot
//! area are merged (series of the non-primary plots get `chart_type`); other
//! combinations keep only the first plot. Anything else (radar, stock, bubble,
//! surface, pie-of-pie…) returns `Ok(None)` and is preserved byte-for-byte by
//! `xlsx_package` as long as the chart is not edited.
//!
//! Axis titles: `x_axis_title` is the category axis (horizontal X axis for
//! scatter), `y_axis_title` the value axis, regardless of the bar direction.

mod dom;
mod parse;
mod write;

use crate::engine::types::{ChartDraft, ChartSpec, EngineResult};

/// EMUs (English Metric Units) per CSS pixel at 96 dpi.
pub const EMU_PER_PX: f64 = 9525.0;

/// Converts a DrawingML offset (`xdr:colOff`, `xdr:rowOff`) to CSS px at 100%.
pub fn emu_to_px(emu: i64) -> f64 {
    emu as f64 / EMU_PER_PX
}

/// Converts CSS px at 100% to EMUs for drawing anchors.
pub fn px_to_emu(px: f64) -> i64 {
    (px * EMU_PER_PX).round() as i64
}

/// Parses a `xl/charts/chartN.xml` part. The anchor and sheet in the returned
/// draft are placeholders; the caller fills them from the drawing part.
/// Returns `Ok(None)` for chart kinds Sheetlight does not model (they are
/// still preserved byte-for-byte when untouched); `Err` for malformed XML.
pub fn parse_chart_xml(xml: &str) -> EngineResult<Option<ChartDraft>> {
    parse::parse(xml)
}

/// Writes a chart part for a chart created or edited in Sheetlight.
/// `sheet_name` is used to qualify unqualified references.
pub fn write_chart_xml(chart: &ChartSpec, sheet_name: &str) -> EngineResult<String> {
    write::write(chart, sheet_name)
}

/// `xdr:twoCellAnchor` for a chart frame in `xl/drawings/drawingN.xml`.
/// `frame_id` must be unique inside the drawing part; `rel_id` is the
/// relationship id (`rId1`) of the chart part in the drawing's `.rels`.
pub fn write_chart_anchor_xml(chart: &ChartSpec, frame_id: u32, rel_id: &str) -> String {
    let a = &chart.draft.anchor;
    let name = format!("Gráfico {frame_id}");
    format!(
        concat!(
            r#"<xdr:twoCellAnchor editAs="oneCell">"#,
            "<xdr:from><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:from>",
            "<xdr:to><xdr:col>{}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:to>",
            r#"<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="{}" name="{}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>"#,
            r#"<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>"#,
            r#"<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">"#,
            r#"<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="{}"/>"#,
            "</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"
        ),
        a.from.col,
        px_to_emu(a.from.dx).max(0),
        a.from.row,
        px_to_emu(a.from.dy).max(0),
        a.to.col,
        px_to_emu(a.to.dx).max(0),
        a.to.row,
        px_to_emu(a.to.dy).max(0),
        frame_id + 1,
        quick_xml::escape::escape(&name),
        quick_xml::escape::escape(rel_id),
    )
}

#[cfg(test)]
mod tests {
    use super::write::{qualify_ref, quote_sheet};
    use super::*;
    use crate::engine::types::{
        AnchorPoint, ChartAnchor, ChartGrouping, ChartSeries, ChartType, LegendPosition,
    };

    fn fixture(name: &str) -> &'static str {
        match name {
            "combo" => include_str!("fixtures/combo_bar_line.xml"),
            "excel_column" => include_str!("fixtures/excel365_column.xml"),
            "excel_pie3d" => include_str!("fixtures/excel365_pie3d_autotitle.xml"),
            "radar" => include_str!("fixtures/unsupported_radar.xml"),
            "column_clustered" => include_str!("fixtures/xlsxwriter_column_clustered.xml"),
            "column_stacked" => include_str!("fixtures/xlsxwriter_column_stacked.xml"),
            "column_percent" => include_str!("fixtures/xlsxwriter_column_percent.xml"),
            "bar_clustered" => include_str!("fixtures/xlsxwriter_bar_clustered.xml"),
            "line_markers" => include_str!("fixtures/xlsxwriter_line_markers.xml"),
            "pie" => include_str!("fixtures/xlsxwriter_pie.xml"),
            "doughnut" => include_str!("fixtures/xlsxwriter_doughnut.xml"),
            "area_stacked" => include_str!("fixtures/xlsxwriter_area_stacked.xml"),
            "scatter" => include_str!("fixtures/xlsxwriter_scatter.xml"),
            _ => panic!("unknown fixture {name}"),
        }
    }

    fn parse_ok(name: &str) -> ChartDraft {
        parse_chart_xml(fixture(name))
            .expect("parse")
            .expect("supported chart")
    }

    const ALL: [&str; 12] = [
        "combo",
        "excel_column",
        "excel_pie3d",
        "column_clustered",
        "column_stacked",
        "column_percent",
        "bar_clustered",
        "line_markers",
        "pie",
        "doughnut",
        "area_stacked",
        "scatter",
    ];

    #[test]
    fn parses_column_clustered_with_titles_colors_and_quoted_refs() {
        let d = parse_ok("column_clustered");
        assert_eq!(d.chart_type, ChartType::Column);
        assert_eq!(d.grouping, ChartGrouping::Clustered);
        assert_eq!(d.title.as_deref(), Some("Ventas por mes"));
        assert_eq!(d.legend, LegendPosition::Bottom);
        assert_eq!(d.x_axis_title.as_deref(), Some("Mes"));
        assert_eq!(d.y_axis_title.as_deref(), Some("Euros"));
        assert_eq!(d.series.len(), 2);
        let s0 = &d.series[0];
        assert_eq!(s0.name_ref.as_deref(), Some("'Mi hoja'!$B$1"));
        assert_eq!(s0.name.as_deref(), Some("Ventas"));
        assert_eq!(s0.categories_ref.as_deref(), Some("'Mi hoja'!$A$2:$A$5"));
        assert_eq!(s0.values_ref, "'Mi hoja'!$B$2:$B$5");
        assert_eq!(s0.color.as_deref(), Some("#FF0000"));
        assert_eq!(s0.chart_type, None);
        assert_eq!(d.series[1].color, None);
    }

    #[test]
    fn parses_groupings_directions_and_legend_positions() {
        let d = parse_ok("column_stacked");
        assert_eq!(
            (d.chart_type, d.grouping, d.legend),
            (
                ChartType::Column,
                ChartGrouping::Stacked,
                LegendPosition::Top
            )
        );
        let d = parse_ok("column_percent");
        assert_eq!(
            (d.grouping, d.legend),
            (ChartGrouping::PercentStacked, LegendPosition::Left)
        );
        let d = parse_ok("bar_clustered");
        assert_eq!(
            (d.chart_type, d.legend),
            (ChartType::Bar, LegendPosition::None)
        );
        assert_eq!(d.title.as_deref(), Some("Barras"));
        let d = parse_ok("area_stacked");
        assert_eq!(
            (d.chart_type, d.grouping),
            (ChartType::Area, ChartGrouping::Stacked)
        );
        let d = parse_ok("line_markers");
        assert_eq!(
            (d.chart_type, d.grouping),
            (ChartType::Line, ChartGrouping::Standard)
        );
    }

    #[test]
    fn parses_pie_doughnut_and_default_titles() {
        let d = parse_ok("pie");
        assert_eq!(d.chart_type, ChartType::Pie);
        assert_eq!(d.title.as_deref(), Some("Tarta"));
        assert_eq!(d.series.len(), 1);
        // Doughnut without a title element: Excel shows the single series name.
        let d = parse_ok("doughnut");
        assert_eq!(d.chart_type, ChartType::Doughnut);
        assert_eq!(d.title.as_deref(), Some("Ventas"));
        // pie3D maps to pie; empty <c:title> = automatic title from the series name.
        let d = parse_ok("excel_pie3d");
        assert_eq!(d.chart_type, ChartType::Pie);
        assert_eq!(d.title.as_deref(), Some("Cuota"));
        assert_eq!(d.legend, LegendPosition::Top);
        assert_eq!(
            d.series[0].categories_ref.as_deref(),
            Some("'Datos 2025'!$A$2:$A$4")
        );
    }

    #[test]
    fn parses_scatter_x_and_y_values() {
        let d = parse_ok("scatter");
        assert_eq!(d.chart_type, ChartType::Scatter);
        assert_eq!(d.series[0].name.as_deref(), Some("Literal 1"));
        assert_eq!(d.series[0].name_ref, None);
        assert_eq!(
            d.series[0].categories_ref.as_deref(),
            Some("'Mi hoja'!$A$2:$A$5")
        );
        assert_eq!(d.series[0].values_ref, "'Mi hoja'!$B$2:$B$5");
        assert_eq!(d.x_axis_title.as_deref(), Some("X"));
        assert_eq!(d.y_axis_title.as_deref(), Some("Y"));
        assert_eq!(d.title, None);
    }

    #[test]
    fn parses_excel_rich_title_scheme_colors_and_entities() {
        let d = parse_ok("excel_column");
        assert_eq!(d.title.as_deref(), Some("Ingresos & gastos 2025"));
        assert_eq!(d.series[0].color.as_deref(), Some("#4472C4"));
        assert_eq!(d.series[1].color.as_deref(), Some("#C55A11"));
        assert_eq!(d.x_axis_title.as_deref(), Some("Año"));
        assert_eq!(d.y_axis_title.as_deref(), Some("Miles de €"));
        assert_eq!(
            d.series[0].categories_ref.as_deref(),
            Some("Hoja1!$A$2:$A$4")
        );
    }

    #[test]
    fn combo_bar_line_keeps_both_plots() {
        let d = parse_ok("combo");
        assert_eq!(d.chart_type, ChartType::Column);
        assert_eq!(d.title.as_deref(), Some("Ventas vs objetivo"));
        assert_eq!(d.series.len(), 2);
        assert_eq!(d.series[0].name.as_deref(), Some("Ventas"));
        assert_eq!(d.series[0].chart_type, None);
        assert_eq!(d.series[1].name.as_deref(), Some("Objetivo"));
        assert_eq!(d.series[1].chart_type, Some(ChartType::Line));
        assert_eq!(d.series[1].values_ref, "Ventas!$C$2:$C$7");
        assert_eq!(d.legend, LegendPosition::Right);
    }

    #[test]
    fn unsupported_and_malformed() {
        assert!(parse_chart_xml(fixture("radar")).unwrap().is_none());
        assert!(parse_chart_xml("<root/>").unwrap().is_none());
        assert!(parse_chart_xml("<c:chartSpace><c:chart>").is_err());
    }

    fn spec(chart_type: ChartType, grouping: ChartGrouping, series: Vec<ChartSeries>) -> ChartSpec {
        ChartSpec {
            id: 1,
            draft: ChartDraft {
                sheet: 1,
                chart_type,
                title: Some("Título <con> \"especiales\" & más".into()),
                series,
                anchor: ChartAnchor {
                    from: AnchorPoint {
                        row: 1,
                        col: 4,
                        dx: 0.0,
                        dy: 0.0,
                    },
                    to: AnchorPoint {
                        row: 16,
                        col: 11,
                        dx: 10.0,
                        dy: 5.0,
                    },
                },
                legend: LegendPosition::Bottom,
                grouping,
                x_axis_title: Some("Meses".into()),
                y_axis_title: Some("Importe (€)".into()),
            },
            from_file: false,
        }
    }

    fn series(n: u32, color: Option<&str>, chart_type: Option<ChartType>) -> ChartSeries {
        let col = (b'B' + n as u8) as char;
        ChartSeries {
            name_ref: Some(format!("${col}$1")),
            name: Some(format!("Serie {n}")),
            categories_ref: Some("$A$2:$A$13".into()),
            values_ref: format!("${col}$2:${col}$13"),
            color: color.map(str::to_string),
            chart_type,
        }
    }

    fn well_formed(xml: &str) {
        dom::parse(xml).unwrap_or_else(|e| panic!("not well-formed: {e}\n{xml}"));
    }

    #[test]
    fn write_parse_round_trip_all_types() {
        let cases = [
            (ChartType::Column, ChartGrouping::Clustered),
            (ChartType::Column, ChartGrouping::Stacked),
            (ChartType::Column, ChartGrouping::PercentStacked),
            (ChartType::Bar, ChartGrouping::Clustered),
            (ChartType::Bar, ChartGrouping::Stacked),
            (ChartType::Line, ChartGrouping::Standard),
            (ChartType::Line, ChartGrouping::Stacked),
            (ChartType::Area, ChartGrouping::Standard),
            (ChartType::Area, ChartGrouping::PercentStacked),
            (ChartType::Scatter, ChartGrouping::Standard),
            (ChartType::Doughnut, ChartGrouping::Standard),
        ];
        for (t, g) in cases {
            let chart = spec(
                t,
                g,
                vec![series(0, Some("#ff0000"), None), series(1, None, None)],
            );
            let xml = write_chart_xml(&chart, "Mi hoja").unwrap();
            well_formed(&xml);
            let back = parse_chart_xml(&xml)
                .unwrap()
                .unwrap_or_else(|| panic!("{t:?} not parsed back"));
            assert_eq!(back.chart_type, t);
            assert_eq!(back.grouping, g, "{t:?}");
            assert_eq!(back.title, chart.draft.title);
            assert_eq!(back.legend, LegendPosition::Bottom);
            let has_axes = t != ChartType::Doughnut;
            assert_eq!(
                back.x_axis_title.as_deref(),
                has_axes.then_some("Meses"),
                "{t:?}"
            );
            assert_eq!(
                back.y_axis_title.as_deref(),
                has_axes.then_some("Importe (€)"),
                "{t:?}"
            );
            assert_eq!(back.series.len(), 2);
            assert_eq!(back.series[0].name_ref.as_deref(), Some("'Mi hoja'!$B$1"));
            assert_eq!(back.series[0].name.as_deref(), Some("Serie 0"));
            assert_eq!(
                back.series[0].categories_ref.as_deref(),
                Some("'Mi hoja'!$A$2:$A$13")
            );
            assert_eq!(back.series[1].values_ref, "'Mi hoja'!$C$2:$C$13");
            let expected_color = if t == ChartType::Doughnut {
                None
            } else {
                Some("#FF0000")
            };
            assert_eq!(back.series[0].color.as_deref(), expected_color, "{t:?}");
            assert_eq!(back.series[1].color, None);
        }
    }

    #[test]
    fn write_pie_keeps_first_series_and_no_axes() {
        let chart = spec(
            ChartType::Pie,
            ChartGrouping::Standard,
            vec![series(0, None, None), series(1, None, None)],
        );
        let xml = write_chart_xml(&chart, "Hoja1").unwrap();
        well_formed(&xml);
        assert!(!xml.contains("<c:catAx>"));
        let back = parse_chart_xml(&xml).unwrap().unwrap();
        assert_eq!(back.series.len(), 1);
        assert_eq!(back.x_axis_title, None);
        assert_eq!(back.series[0].values_ref, "Hoja1!$B$2:$B$13");
    }

    #[test]
    fn write_combo_round_trip() {
        let chart = spec(
            ChartType::Column,
            ChartGrouping::Clustered,
            vec![
                series(0, None, None),
                series(1, Some("#00AA00"), Some(ChartType::Line)),
            ],
        );
        let xml = write_chart_xml(&chart, "Hoja1").unwrap();
        well_formed(&xml);
        assert!(xml.contains("<c:barChart>") && xml.contains("<c:lineChart>"));
        let back = parse_chart_xml(&xml).unwrap().unwrap();
        assert_eq!(back.chart_type, ChartType::Column);
        assert_eq!(back.series[0].chart_type, None);
        assert_eq!(back.series[1].chart_type, Some(ChartType::Line));
        assert_eq!(back.series[1].color.as_deref(), Some("#00AA00"));
        // Both plots share the same pair of axes; each axis references the other.
        assert_eq!(xml.matches(r#"<c:axId val="50010001"/>"#).count(), 3);
        assert!(
            xml.contains(r#"<c:crossAx val="50010002"/>"#)
                && xml.contains(r#"<c:crossAx val="50010001"/>"#)
        );
    }

    #[test]
    fn write_without_title_deletes_auto_title_and_legend() {
        let mut chart = spec(
            ChartType::Column,
            ChartGrouping::Clustered,
            vec![series(0, None, None)],
        );
        chart.draft.title = None;
        chart.draft.legend = LegendPosition::None;
        chart.draft.series[0].name_ref = None;
        chart.draft.series[0].name = Some("Literal".into());
        let xml = write_chart_xml(&chart, "Hoja1").unwrap();
        assert!(xml.contains(r#"<c:autoTitleDeleted val="1"/>"#));
        assert!(!xml.contains("<c:legend>"));
        let back = parse_chart_xml(&xml).unwrap().unwrap();
        assert_eq!(back.title, None);
        assert_eq!(back.legend, LegendPosition::None);
        assert_eq!(back.series[0].name.as_deref(), Some("Literal"));
        assert_eq!(back.series[0].name_ref, None);
    }

    #[test]
    fn write_rejects_empty_series() {
        let chart = spec(ChartType::Column, ChartGrouping::Clustered, vec![]);
        assert!(write_chart_xml(&chart, "Hoja1").is_err());
    }

    #[test]
    fn fixtures_survive_parse_write_parse() {
        for name in ALL {
            let first = parse_ok(name);
            let chart = ChartSpec {
                id: 7,
                draft: first.clone(),
                from_file: false,
            };
            let xml = write_chart_xml(&chart, "Hoja1").unwrap();
            well_formed(&xml);
            let mut second = parse_chart_xml(&xml).unwrap().unwrap();
            // Pie keeps one series; Excel default titles are written out explicitly.
            if first.chart_type == ChartType::Pie {
                second.series.truncate(first.series.len());
            }
            for s in second.series.iter_mut() {
                // Colors are not written for pie/doughnut series; names are cached.
                if matches!(first.chart_type, ChartType::Pie | ChartType::Doughnut) {
                    s.color = None;
                }
            }
            assert_eq!(second.chart_type, first.chart_type, "{name}");
            assert_eq!(second.grouping, first.grouping, "{name}");
            assert_eq!(second.title, first.title, "{name}");
            assert_eq!(second.legend, first.legend, "{name}");
            assert_eq!(second.x_axis_title, first.x_axis_title, "{name}");
            assert_eq!(second.y_axis_title, first.y_axis_title, "{name}");
            assert_eq!(second.series, first.series, "{name}");
        }
    }

    #[test]
    fn sheet_quoting_and_qualification() {
        assert_eq!(quote_sheet("Hoja1"), "Hoja1");
        assert_eq!(quote_sheet("Mi hoja"), "'Mi hoja'");
        assert_eq!(quote_sheet("O'Brien"), "'O''Brien'");
        assert_eq!(quote_sheet("A1"), "'A1'");
        assert_eq!(quote_sheet("R1C1"), "'R1C1'");
        assert_eq!(quote_sheet("2025"), "'2025'");
        assert_eq!(quote_sheet("Año"), "Año");
        assert_eq!(quote_sheet("Resumen"), "Resumen");
        assert_eq!(qualify_ref("=$B$2:$B$5", "Mi hoja"), "'Mi hoja'!$B$2:$B$5");
        assert_eq!(qualify_ref("Otra!A1", "Mi hoja"), "Otra!A1");
        assert_eq!(
            qualify_ref("(A1:A2,A4:A5)", "Hoja1"),
            "(Hoja1!A1:A2,Hoja1!A4:A5)"
        );
    }

    #[test]
    fn anchor_xml_uses_emus() {
        let chart = spec(
            ChartType::Column,
            ChartGrouping::Clustered,
            vec![series(0, None, None)],
        );
        let xml = write_chart_anchor_xml(&chart, 2, "rId3");
        let wrapped = format!(
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{xml}</xdr:wsDr>"#
        );
        well_formed(&wrapped);
        assert!(xml.contains("<xdr:colOff>95250</xdr:colOff>"));
        assert!(xml.contains("<xdr:rowOff>47625</xdr:rowOff>"));
        assert!(xml.contains(r#"r:id="rId3""#));
        assert_eq!(emu_to_px(95250), 10.0);
    }
}
