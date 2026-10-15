//! End-to-end chart round trips through a real `.xlsx` package: IronCalc
//! writes the workbook, `xlsx_package::post_process` adds the chart parts
//! produced by `write_chart_xml`, and `xlsx_package::inspect` reads them back
//! with `parse_chart_xml`. Also covers a chart part made by Excel 365 and an
//! unsupported chart kind.

use std::io::{Cursor, Read, Write};

use ironcalc::base::Model;
use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::load_from_xlsx_bytes;

use super::parse_chart_xml;
use crate::engine::types::{
    AnchorPoint, ChartAnchor, ChartDraft, ChartGrouping, ChartSeries, ChartSpec, ChartType, FidelityFeature,
    LegendPosition, OnSave,
};
use crate::xlsx_package::{inspect, post_process, SheetSaveInfo};

const EXCEL_COLUMN: &str = include_str!("fixtures/excel365_column.xml");
const RADAR: &str = include_str!("fixtures/unsupported_radar.xml");

/// "Hoja1" with months in A2:A4 and two series in B:C, as IronCalc saves it.
fn workbook() -> Vec<u8> {
    let mut model = Model::new_empty("libro", "en", "UTC", "en").unwrap();
    model.rename_sheet_by_index(0, "Hoja1").unwrap();
    let rows = [["Mes", "Ingresos", "Gastos"], ["Ene", "10", "4"], ["Feb", "12", "5"], ["Mar", "9", "7"]];
    for (r, row) in rows.iter().enumerate() {
        for (c, value) in row.iter().enumerate() {
            model.set_user_input(0, r as i32 + 1, c as i32 + 1, value.to_string()).unwrap();
        }
    }
    model.evaluate();
    save_xlsx_to_writer(&model, Cursor::new(Vec::new())).unwrap().into_inner()
}

fn infos(original_index: Option<usize>) -> Vec<SheetSaveInfo> {
    vec![SheetSaveInfo { id: 1, name: "Hoja1".into(), original_index, auto_filter: None }]
}

fn chart(id: u32, chart_type: ChartType, grouping: ChartGrouping) -> ChartSpec {
    let series = |col: char, color: Option<&str>| ChartSeries {
        name_ref: Some(format!("Hoja1!${col}$1")),
        name: Some(if col == 'B' { "Ingresos" } else { "Gastos" }.into()),
        categories_ref: Some("Hoja1!$A$2:$A$4".into()),
        values_ref: format!("Hoja1!${col}$2:${col}$4"),
        color: color.map(str::to_string),
        chart_type: None,
    };
    let pie = chart_type == ChartType::Pie;
    ChartSpec {
        id,
        draft: ChartDraft {
            sheet: 1,
            chart_type,
            title: Some("Resultados 2026".into()),
            series: if pie { vec![series('B', None)] } else { vec![series('B', Some("#4472C4")), series('C', None)] },
            anchor: ChartAnchor {
                from: AnchorPoint { row: 1, col: 4, dx: 0.0, dy: 0.0 },
                to: AnchorPoint { row: 16, col: 11, dx: 10.0, dy: 5.0 },
            },
            legend: LegendPosition::Bottom,
            grouping,
            x_axis_title: (!pie).then(|| "Mes".into()),
            y_axis_title: (!pie).then(|| "Euros".into()),
        },
        from_file: false,
    }
}

fn names(bytes: &[u8]) -> Vec<String> {
    let zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    zip.file_names().map(str::to_string).collect()
}

fn part(bytes: &[u8], name: &str) -> Option<String> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut file = zip.by_name(name).ok()?;
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

/// Copy of the package with one part replaced (how a file "made by Excel" is simulated).
fn replace_part(bytes: &[u8], name: &str, data: &str) -> Vec<u8> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).unwrap();
        let entry = file.name().to_string();
        let mut content = Vec::new();
        file.read_to_end(&mut content).unwrap();
        out.start_file(entry.as_str(), options).unwrap();
        out.write_all(if entry == name { data.as_bytes() } else { &content }).unwrap();
    }
    out.finish().unwrap().into_inner()
}

fn chart_part(bytes: &[u8]) -> String {
    names(bytes)
        .into_iter()
        .find(|n| n.starts_with("xl/charts/chart") && n.ends_with(".xml"))
        .expect("a chart part")
}

/// Saves `charts` into a fresh workbook with no original package.
fn save_new(charts: &[ChartSpec]) -> Vec<u8> {
    post_process(workbook(), None, &infos(None), charts).unwrap()
}

/// Opens `bytes` (inspect + IronCalc) and saves again with `charts` as the engine would.
fn resave(bytes: &[u8], charts: impl FnOnce(&[ChartSpec]) -> Vec<ChartSpec>) -> Vec<u8> {
    let original = inspect(bytes).unwrap();
    let workbook = load_from_xlsx_bytes(bytes, "libro", "en", "UTC").expect("IronCalc opens the package");
    let model = Model::from_workbook(workbook, "en").unwrap();
    let fresh = save_xlsx_to_writer(&model, Cursor::new(Vec::new())).unwrap().into_inner();
    let opened: Vec<ChartSpec> = original
        .charts
        .iter()
        .map(|(_, c)| {
            let mut c = c.clone();
            c.draft.sheet = 1;
            c
        })
        .collect();
    post_process(fresh, Some(&original), &infos(Some(0)), &charts(&opened)).unwrap()
}

#[test]
fn sheetlight_charts_survive_save_and_reopen() {
    let cases = [
        (ChartType::Column, ChartGrouping::Clustered),
        (ChartType::Column, ChartGrouping::Stacked),
        (ChartType::Bar, ChartGrouping::Clustered),
        (ChartType::Line, ChartGrouping::Standard),
        (ChartType::Pie, ChartGrouping::Standard),
    ];
    for (t, g) in cases {
        let created = chart(1, t, g);
        let saved = save_new(std::slice::from_ref(&created));
        let reopened = inspect(&saved).unwrap();
        assert_eq!(reopened.charts.len(), 1, "{t:?}");
        let (index, spec) = &reopened.charts[0];
        assert_eq!(*index, 0);
        assert!(spec.from_file);
        let mut expected = created.draft.clone();
        expected.sheet = 0;
        assert_eq!(spec.draft, expected, "{t:?}");
        // Modeled charts still count as a (preserved) chart in the warnings.
        assert!(reopened.warnings.iter().any(|w| w.feature == FidelityFeature::Charts && w.on_save == OnSave::Preserved));

        // Open + save without edits: the chart part is written back byte for byte.
        let chart_xml = part(&saved, &chart_part(&saved)).unwrap();
        let again = resave(&saved, |opened| opened.to_vec());
        assert_eq!(part(&again, &chart_part(&again)).unwrap(), chart_xml, "{t:?}");
        assert_eq!(inspect(&again).unwrap().charts[0].1.draft, expected, "{t:?}");
    }
}

#[test]
fn several_charts_and_deletion() {
    let saved = save_new(&[chart(1, ChartType::Column, ChartGrouping::Clustered), chart(2, ChartType::Line, ChartGrouping::Standard)]);
    let reopened = inspect(&saved).unwrap();
    let types: Vec<ChartType> = reopened.charts.iter().map(|(_, c)| c.draft.chart_type).collect();
    assert_eq!(types, [ChartType::Column, ChartType::Line]);
    // Deleting the first chart in Sheetlight drops it from the saved file.
    let again = resave(&saved, |opened| opened[1..].to_vec());
    let after = inspect(&again).unwrap();
    assert_eq!(after.charts.len(), 1);
    assert_eq!(after.charts[0].1.draft.chart_type, ChartType::Line);
}

#[test]
fn excel_made_chart_round_trips() {
    // A package whose chart part was written by Excel 365 (fixture < 10 KB).
    let base = save_new(&[chart(1, ChartType::Column, ChartGrouping::Clustered)]);
    let path = chart_part(&base);
    let excel = replace_part(&base, &path, EXCEL_COLUMN);

    let opened = inspect(&excel).unwrap();
    assert_eq!(opened.charts.len(), 1);
    let mut expected = parse_chart_xml(EXCEL_COLUMN).unwrap().expect("Excel column chart is modeled");
    expected.sheet = 0;
    expected.anchor = chart(1, ChartType::Column, ChartGrouping::Clustered).draft.anchor;
    assert_eq!(opened.charts[0].1.draft, expected);

    // Untouched: Excel's XML is written back unchanged (styles, effects, ext lists).
    let untouched = resave(&excel, |c| c.to_vec());
    assert_eq!(part(&untouched, &chart_part(&untouched)).unwrap(), EXCEL_COLUMN);

    // Edited in Sheetlight (title + move): rewritten, everything else parsed back equal.
    let edited = resave(&excel, |c| {
        let mut c = c[0].clone();
        c.from_file = false;
        c.draft.title = Some("Nuevo título".into());
        c.draft.anchor.from.row = 3;
        c.draft.anchor.to.row = 18;
        vec![c]
    });
    let back = inspect(&edited).unwrap().charts[0].1.draft.clone();
    assert_eq!(back.title.as_deref(), Some("Nuevo título"));
    assert_eq!((back.anchor.from.row, back.anchor.to.row), (3, 18));
    assert_eq!(back.chart_type, expected.chart_type);
    assert_eq!(back.grouping, expected.grouping);
    assert_eq!(back.series, expected.series);
    assert_eq!(back.legend, expected.legend);
    // IronCalc still reads the rewritten package.
    load_from_xlsx_bytes(&edited, "libro", "en", "UTC").unwrap();
}

#[test]
fn unsupported_chart_is_reported_and_preserved() {
    let base = save_new(&[chart(1, ChartType::Column, ChartGrouping::Clustered)]);
    let path = chart_part(&base);
    let radar = replace_part(&base, &path, RADAR);

    let opened = inspect(&radar).unwrap();
    assert!(opened.charts.is_empty(), "radar charts are not modeled");
    let warning = opened.warnings.iter().find(|w| w.feature == FidelityFeature::Charts).expect("charts warning");
    assert_eq!((warning.count, warning.on_save), (1, OnSave::Preserved));

    // Saved back byte for byte, still anchored in the drawing.
    let saved = resave(&radar, |c| c.to_vec());
    assert_eq!(part(&saved, &chart_part(&saved)).unwrap(), RADAR);
    let drawing = names(&saved).into_iter().find(|n| n.starts_with("xl/drawings/drawing") && n.ends_with(".xml")).unwrap();
    assert!(part(&saved, &drawing).unwrap().contains("c:chart"));
}
