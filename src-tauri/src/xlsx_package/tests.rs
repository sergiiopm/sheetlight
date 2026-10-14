//! Fidelity round trips: an original package with charts, images, shapes,
//! comments, validation, autofilter, tables, sparklines, pivot tables and
//! macros is opened with IronCalc, saved by IronCalc and post-processed.

use std::io::Cursor;

use ironcalc::base::Model;
use ironcalc::export::save_xlsx_to_writer;
use ironcalc::import::load_from_xlsx_bytes;

use super::package::{self, ContentTypes, Package, CONTENT_TYPES};
use super::*;
use crate::engine::types::{AnchorPoint, ChartAnchor, ChartDraft, ChartGrouping, ChartSeries, ChartType, EngineError, FidelityFeature, LegendPosition, OnSave};

const SHEET1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
<dimension ref="A1:B3"/>
<sheetViews><sheetView workbookViewId="0"/></sheetViews>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Mes</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row>
<row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>10</v></c></row>
<row r="3"><c r="A3"><v>2</v></c><c r="B3"><f>B2*2</f><v>20</v></c></row>
</sheetData>
<autoFilter ref="A1:B3"><filterColumn colId="0"><filters><filter val="1"/></filters></filterColumn></autoFilter>
<conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>15</formula></cfRule></conditionalFormatting>
<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A2:A3 D1"><formula1>"1,2,3"</formula1></dataValidation></dataValidations>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" r:id="rId5"/>
<drawing r:id="rId1"/>
<legacyDrawing r:id="rId2"/>
<tableParts count="1"><tablePart r:id="rId4"/></tableParts>
<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f>Ventas!B2:B3</xm:f><xm:sqref>C3</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext></extLst>
</worksheet>"#;

const SHEET1_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings" Target="../printerSettings/printerSettings1.bin"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>
</Relationships>"#;

const DRAWING1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Gráfico 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="952500"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Imagen 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>20</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp macro="" textlink=""><xdr:nvSpPr><xdr:cNvPr id="4" name="Rectángulo 1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>
</xdr:wsDr>"#;

const DRAWING1_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>"#;

const CHART1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/></c:barChart></c:plotArea></c:chart></c:chartSpace>"#;
const CHART1_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2011/relationships/chartColorStyle" Target="colors1.xml"/></Relationships>"#;
const COLORS1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cs:colorStyle xmlns:cs="http://schemas.microsoft.com/office/drawing/2012/chartStyle" meth="cycle" id="10"/>"#;

const COMMENTS1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Ana</author></authors><commentList><comment ref="A2" authorId="0"><text><r><t>Primero</t></r></text></comment><comment ref="B3" authorId="0"><text><r><t>Doble</t></r></text></comment></commentList></comments>"#;
const VML1: &str = r##"<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape id="_x0000_s1025" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Row>1</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>"##;
const TABLE1: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Tabla1" displayName="Tabla1" ref="A1:B3" totalsRowShown="0"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Mes"/><tableColumn id="2" name="Total"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>"#;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

fn ironcalc_bytes(model: &Model) -> Vec<u8> {
    save_xlsx_to_writer(model, Cursor::new(Vec::new())).expect("ironcalc save").into_inner()
}

/// Two sheets ("Ventas", "Notas") written by IronCalc, then decorated by hand.
fn original() -> Vec<u8> {
    let mut model = Model::new_empty("libro", "en", "UTC", "en").unwrap();
    model.rename_sheet_by_index(0, "Ventas").unwrap();
    model.add_sheet("Notas").unwrap();
    model.set_user_input(1, 1, 1, "nota".to_string()).unwrap();
    model.evaluate();
    let mut pkg = Package::read(&ironcalc_bytes(&model)).unwrap();
    let sheet1 = pkg.worksheets()[0].1.clone();
    pkg.set(&sheet1, SHEET1.as_bytes().to_vec());
    pkg.set(&package::rels_path(&sheet1), SHEET1_RELS.as_bytes().to_vec());
    for (path, data) in [
        ("xl/drawings/drawing1.xml", DRAWING1.as_bytes()),
        ("xl/drawings/_rels/drawing1.xml.rels", DRAWING1_RELS.as_bytes()),
        ("xl/charts/chart1.xml", CHART1.as_bytes()),
        ("xl/charts/_rels/chart1.xml.rels", CHART1_RELS.as_bytes()),
        ("xl/charts/colors1.xml", COLORS1.as_bytes()),
        ("xl/media/image1.png", PNG),
        ("xl/comments1.xml", COMMENTS1.as_bytes()),
        ("xl/drawings/vmlDrawing1.vml", VML1.as_bytes()),
        ("xl/tables/table1.xml", TABLE1.as_bytes()),
        ("xl/printerSettings/printerSettings1.bin", b"bin"),
        ("xl/vbaProject.bin", b"vba"),
    ] {
        pkg.set(path, data.to_vec());
    }
    let mut ct = ContentTypes::parse(&pkg.text(CONTENT_TYPES).unwrap());
    ct.ensure("xl/media/image1.png", "image/png", true);
    ct.ensure("xl/drawings/vmlDrawing1.vml", "application/vnd.openxmlformats-officedocument.vmlDrawing", true);
    ct.ensure("xl/printerSettings/printerSettings1.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings", true);
    ct.ensure("xl/drawings/drawing1.xml", package::CT_DRAWING, false);
    ct.ensure("xl/charts/chart1.xml", package::CT_CHART, false);
    ct.ensure("xl/charts/colors1.xml", "application/vnd.ms-office.chartcolorstyle+xml", false);
    ct.ensure("xl/comments1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml", false);
    ct.ensure("xl/tables/table1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml", false);
    pkg.set(CONTENT_TYPES, ct.write().into_bytes());
    pkg.write().unwrap()
}

fn reload(bytes: &[u8]) -> Model<'static> {
    let workbook = load_from_xlsx_bytes(bytes, "libro", "en", "UTC").expect("ironcalc reads the package");
    Model::from_workbook(workbook, "en").unwrap()
}

fn save_infos() -> Vec<SheetSaveInfo> {
    vec![
        SheetSaveInfo { id: 1, name: "Ventas".into(), original_index: Some(0), auto_filter: Some(CellRange { r0: 0, c0: 0, r1: 2, c1: 1 }) },
        SheetSaveInfo { id: 2, name: "Notas".into(), original_index: Some(1), auto_filter: None },
    ]
}

fn warning(pkg: &OriginalPackage, feature: FidelityFeature) -> Option<(u32, OnSave)> {
    pkg.warnings.iter().find(|w| w.feature == feature).map(|w| (w.count, w.on_save))
}

/// Every non-external relationship target exists and every part has a content type.
fn assert_consistent(bytes: &[u8]) -> Package {
    let pkg = Package::read(bytes).unwrap();
    let ct = ContentTypes::parse(&pkg.text(CONTENT_TYPES).unwrap());
    let names: Vec<String> = pkg.names().map(str::to_string).collect();
    for name in &names {
        if name.ends_with(".rels") {
            let source = name.replace("_rels/", "").trim_end_matches(".rels").to_string();
            for rel in pkg.rels(&source).iter().filter(|r| !r.external) {
                let target = package::resolve_target(&source, &rel.target);
                assert!(pkg.contains(&target), "{name}: missing target {target}");
            }
        } else if name != CONTENT_TYPES {
            assert!(ct.of(name).is_some(), "no content type for {name}");
        }
    }
    pkg
}

fn sheet_xml(pkg: &Package, index: usize) -> String {
    pkg.text(&pkg.worksheets()[index].1).unwrap()
}

/// Positions of the given elements must follow the schema order.
fn assert_order(xml_text: &str, names: &[&str]) {
    let mut last = 0;
    for name in names {
        let at = xml_text.find(&format!("<{name}")).unwrap_or_else(|| panic!("missing <{name}> in {xml_text}"));
        assert!(at > last, "<{name}> out of order");
        last = at;
    }
}

#[test]
fn inspect_reports_every_feature() {
    let pkg = inspect(&original()).unwrap();
    assert_eq!(warning(&pkg, FidelityFeature::Charts), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::Images), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::Shapes), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::Comments), Some((2, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::DataValidation), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::AutoFilter), Some((1, OnSave::Editable)));
    assert_eq!(warning(&pkg, FidelityFeature::ConditionalFormatting), Some((1, OnSave::Editable)));
    assert_eq!(warning(&pkg, FidelityFeature::Tables), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::Sparklines), Some((1, OnSave::Preserved)));
    assert_eq!(warning(&pkg, FidelityFeature::PivotTables), Some((1, OnSave::Lost)));
    assert_eq!(warning(&pkg, FidelityFeature::Macros), Some((1, OnSave::Lost)));
    assert_eq!(warning(&pkg, FidelityFeature::Slicers), None);
    assert_eq!(pkg.auto_filters, vec![(0, CellRange { r0: 0, c0: 0, r1: 2, c1: 1 })]);
    assert_eq!(pkg.data_validations[0].0, 0);
    assert_eq!(pkg.data_validations[0].1.len(), 2);
    // Only the parts that can be re-inserted are kept in memory.
    assert!(pkg.state.parts.contains("xl/media/image1.png"));
    assert!(pkg.state.parts.contains("xl/charts/colors1.xml"));
    assert!(!pkg.state.parts.contains("xl/sharedStrings.xml"));
    assert!(!pkg.state.parts.contains("xl/printerSettings/printerSettings1.bin"));
}

#[test]
fn plain_ironcalc_files_have_no_warnings() {
    let model = Model::new_empty("libro", "en", "UTC", "en").unwrap();
    let pkg = inspect(&ironcalc_bytes(&model)).unwrap();
    assert!(pkg.warnings.is_empty(), "{:?}", pkg.warnings);
    assert!(inspect(b"no es un zip").is_err());
}

#[test]
fn save_reinserts_preserved_parts() {
    let original_bytes = original();
    let original = inspect(&original_bytes).unwrap();
    let model = reload(&original_bytes);
    let fresh = ironcalc_bytes(&model);
    let out = post_process(fresh, Some(&original), &save_infos(), &[]).unwrap();

    let pkg = assert_consistent(&out);
    for part in ["xl/drawings/drawing1.xml", "xl/charts/chart1.xml", "xl/charts/colors1.xml", "xl/media/image1.png", "xl/comments1.xml", "xl/drawings/vmlDrawing1.vml", "xl/tables/table1.xml"] {
        assert!(pkg.contains(part), "missing {part}");
    }
    assert!(!pkg.contains("xl/vbaProject.bin"));
    let sheet = sheet_xml(&pkg, 0);
    assert_order(&sheet, &["sheetData", "autoFilter", "dataValidations", "pageMargins", "pageSetup", "drawing", "legacyDrawing", "tableParts", "extLst"]);
    assert!(sheet.contains("<filterColumn colId=\"0\">"), "unchanged autofilter keeps its criteria");
    assert!(!sheet.contains("rId5"), "printer settings relationship dropped");
    assert!(sheet.contains("xmlns:x14ac="), "root namespaces copied");
    assert!(sheet.contains("sparklineGroup"));
    let rels = pkg.rels(&pkg.worksheets()[0].1);
    for t in ["/drawing", "/vmlDrawing", "/comments", "/table"] {
        assert!(rels.iter().any(|r| r.rel_type.ends_with(t)), "rel {t}");
    }
    assert!(!rels.iter().any(|r| r.rel_type.ends_with("/pivotTable")));
    assert!(!sheet_xml(&pkg, 1).contains("<drawing"));

    // IronCalc reads its own post-processed output, values intact.
    let again = reload(&out);
    assert_eq!(again.get_formatted_cell_value(0, 3, 2).unwrap(), "20");
    // A second open/save cycle keeps everything (idempotent).
    let inspected = inspect(&out).unwrap();
    for feature in [FidelityFeature::Charts, FidelityFeature::Images, FidelityFeature::Comments, FidelityFeature::Tables, FidelityFeature::Sparklines, FidelityFeature::DataValidation] {
        assert_eq!(warning(&inspected, feature).map(|w| w.1), Some(OnSave::Preserved), "{feature:?}");
    }
    let out2 = post_process(ironcalc_bytes(&again), Some(&inspected), &save_infos(), &[]).unwrap();
    let pkg2 = assert_consistent(&out2);
    assert_eq!(pkg2.names().filter(|n| n.starts_with("xl/drawings/drawing")).count(), 1);
}

#[test]
fn parts_follow_sheets_on_reorder_and_delete() {
    let original_bytes = original();
    let original = inspect(&original_bytes).unwrap();
    let fresh = ironcalc_bytes(&reload(&original_bytes));
    // "Notas" moved first: the drawing goes with "Ventas" to the second sheet.
    let infos = vec![
        SheetSaveInfo { id: 2, name: "Notas".into(), original_index: Some(1), auto_filter: None },
        SheetSaveInfo { id: 1, name: "Ventas".into(), original_index: Some(0), auto_filter: None },
    ];
    let pkg = assert_consistent(&post_process(fresh.clone(), Some(&original), &infos, &[]).unwrap());
    assert!(!sheet_xml(&pkg, 0).contains("<drawing"));
    assert!(sheet_xml(&pkg, 1).contains("<drawing"));
    assert!(!sheet_xml(&pkg, 1).contains("<autoFilter"), "autofilter removed by the user");
    // "Ventas" deleted (and a new sheet in its slot): nothing is re-inserted.
    let infos = vec![
        SheetSaveInfo { id: 2, name: "Notas".into(), original_index: Some(1), auto_filter: None },
        SheetSaveInfo { id: 3, name: "Hoja3".into(), original_index: None, auto_filter: Some(CellRange { r0: 0, c0: 0, r1: 4, c1: 2 }) },
    ];
    let pkg = assert_consistent(&post_process(fresh, Some(&original), &infos, &[]).unwrap());
    assert!(!pkg.contains("xl/drawings/drawing1.xml"));
    assert!(sheet_xml(&pkg, 1).contains(r#"<autoFilter ref="A1:C5"/>"#));
}

fn spec(id: u32, sheet: u32, from_file: bool) -> ChartSpec {
    ChartSpec {
        id,
        from_file,
        draft: ChartDraft {
            sheet,
            chart_type: ChartType::Column,
            title: Some("Ventas".into()),
            series: vec![ChartSeries { name_ref: None, name: None, categories_ref: None, values_ref: "Ventas!$B$2:$B$3".into(), color: None }],
            anchor: ChartAnchor { from: AnchorPoint { row: 2, col: 4, dx: 0.0, dy: 0.0 }, to: AnchorPoint { row: 12, col: 10, dx: 0.0, dy: 0.0 } },
            legend: LegendPosition::Bottom,
            grouping: ChartGrouping::Clustered,
            x_axis_title: None,
            y_axis_title: None,
        },
    }
}

fn fake_writer(chart: &ChartSpec, sheet: &str) -> EngineResult<String> {
    if chart.id == 13 {
        return Err(EngineError::unsupported("gráfico"));
    }
    Ok(format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><!--{sheet}#{}--></c:chartSpace>"#, chart.id))
}

/// The original with its chart modeled as id 1 (as if the chart parser knew it).
fn modeled_original(bytes: &[u8]) -> OriginalPackage {
    let mut original = inspect(bytes).unwrap();
    let (_, drawing) = original.state.sheets[0].drawing.as_mut().unwrap();
    drawing.anchors[0].chart.as_mut().unwrap().model = Some(1);
    original.charts.push((0, spec(1, 0, true)));
    original
}

#[test]
fn charts_deleted_edited_and_created() {
    let original_bytes = original();
    let original = modeled_original(&original_bytes);
    let fresh = ironcalc_bytes(&reload(&original_bytes));

    // Deleted: the chart anchor and its relationship go, the picture stays.
    let (out, dropped) = post::post_process(fresh.clone(), Some(&original), &save_infos(), &[], &fake_writer).unwrap();
    assert!(dropped.is_empty());
    let pkg = assert_consistent(&out);
    let drawing = pkg.text("xl/drawings/drawing1.xml").unwrap();
    assert!(!drawing.contains("c:chart"));
    assert!(drawing.contains("xdr:pic"));
    assert!(!pkg.rels("xl/drawings/drawing1.xml").iter().any(|r| r.rel_type == package::REL_CHART));

    // Edited: same part, new XML, new anchor; its color style part is kept.
    let edited = spec(1, 1, false);
    let (out, _) = post::post_process(fresh.clone(), Some(&original), &save_infos(), &[edited], &fake_writer).unwrap();
    let pkg = assert_consistent(&out);
    assert!(pkg.text("xl/charts/chart1.xml").unwrap().contains("<!--Ventas#1-->"));
    assert!(pkg.contains("xl/charts/colors1.xml"));
    let drawing = pkg.text("xl/drawings/drawing1.xml").unwrap();
    assert!(drawing.contains("<xdr:col>4</xdr:col>"));
    assert_eq!(drawing.matches("c:chart ").count(), 1);

    // New charts on both sheets (one the writer rejects), original kept.
    let charts = [spec(1, 1, true), spec(7, 1, false), spec(8, 2, false), spec(13, 2, false)];
    let (out, dropped) = post::post_process(fresh, Some(&original), &save_infos(), &charts, &fake_writer).unwrap();
    assert_eq!(dropped, vec![13]);
    let pkg = assert_consistent(&out);
    assert_eq!(pkg.text("xl/drawings/drawing1.xml").unwrap().matches("c:chart ").count(), 2);
    assert!(pkg.text("xl/charts/chart1.xml").unwrap().contains("barChart"), "untouched chart is byte-identical");
    let notas = sheet_xml(&pkg, 1);
    assert!(notas.contains("<drawing r:id="));
    let notas_drawing = pkg.rels(&pkg.worksheets()[1].1).into_iter().find(|r| r.rel_type == package::REL_DRAWING).unwrap();
    let path = package::resolve_target(&pkg.worksheets()[1].1, &notas_drawing.target);
    assert_eq!(pkg.text(&path).unwrap().matches("c:chart ").count(), 1);
    reload(&out);
}

#[test]
fn new_chart_in_a_file_without_original() {
    let model = Model::new_empty("libro", "en", "UTC", "en").unwrap();
    let fresh = ironcalc_bytes(&model);
    let infos = [SheetSaveInfo { id: 1, name: "Sheet1".into(), original_index: None, auto_filter: None }];
    assert_eq!(post_process(fresh.clone(), None, &infos, &[]).unwrap(), fresh, "nothing to do: bytes untouched");
    let (out, dropped) = post::post_process(fresh, None, &infos, &[spec(5, 1, false)], &fake_writer).unwrap();
    assert!(dropped.is_empty());
    let pkg = assert_consistent(&out);
    assert!(pkg.contains("xl/drawings/drawing1.xml"));
    assert!(pkg.contains("xl/charts/chart1.xml"));
    reload(&out);
}
