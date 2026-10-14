//! `inspect`: fidelity scan of the original package on open.

use std::collections::{BTreeMap, HashSet};

use crate::engine::types::{CellRange, ChartSpec, EngineResult, FidelityFeature, FidelityWarning, OnSave};

use super::a1;
use super::drawing::{self, AnchorKind, Drawing};
use super::package::{self, ContentTypes, Package, Rel, CONTENT_TYPES, REL_CHART, REL_DRAWING};
use super::xml;
use super::OriginalPackage;

/// Worksheet children copied verbatim into the sheet IronCalc writes (when it
/// did not write them itself). `drawing` / `legacyDrawing` / `tableParts`
/// carry relationship ids that are remapped on save.
pub const PRESERVED_ELEMENTS: [&str; 12] = [
    "sheetProtection",
    "dataValidations",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "ignoredErrors",
    "drawing",
    "legacyDrawing",
    "tableParts",
];

/// `<ext>` blocks of the worksheet `extLst` that are re-inserted:
/// sparkline groups and x14 data validations (lists from other sheets).
/// x14 conditional formatting is written by IronCalc itself.
pub const PRESERVED_EXT_URIS: [&str; 2] = ["{05C60535-1F16-4fd2-B633-F4F36F0B64E0}", "{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"];

/// Sheet relationship types (suffixes) whose targets are re-inserted.
pub const PRESERVED_REL_SUFFIXES: [&str; 4] = ["/comments", "/vmlDrawing", "/table", "/drawing"];

/// Everything `post_process` needs from the original package.
#[derive(Debug, Default)]
pub struct State {
    /// Only the parts reachable from preserved relationships (plus their rels).
    pub parts: Package,
    pub content_types: ContentTypes,
    pub sheets: Vec<SheetState>,
}

#[derive(Debug, Default, Clone)]
pub struct SheetState {
    /// Namespace declarations of the original `<worksheet>` root.
    pub root_ns: Vec<(String, String)>,
    /// `(local name, xml)` of `PRESERVED_ELEMENTS` found in the sheet.
    pub fragments: Vec<(String, String)>,
    /// `(uri, xml)` of preserved `<ext>` blocks.
    pub exts: Vec<(String, String)>,
    /// Original `<autoFilter>` (keeps filter criteria when the range is unchanged).
    pub auto_filter: Option<(CellRange, String)>,
    /// Preserved relationships of the sheet (targets resolved to part paths).
    pub rels: Vec<Rel>,
    /// Relationship id of the drawing and its parsed anchors.
    pub drawing: Option<(String, Drawing)>,
}

#[derive(Default)]
struct Counts(BTreeMap<(u8, u8), u32>);

impl Counts {
    fn add(&mut self, feature: FidelityFeature, on_save: OnSave, n: u32) {
        if n > 0 {
            *self.0.entry((feature as u8, on_save as u8)).or_default() += n;
        }
    }

    fn into_warnings(self) -> Vec<FidelityWarning> {
        const FEATURES: [FidelityFeature; 14] = [
            FidelityFeature::Charts,
            FidelityFeature::Images,
            FidelityFeature::Shapes,
            FidelityFeature::Comments,
            FidelityFeature::DataValidation,
            FidelityFeature::AutoFilter,
            FidelityFeature::ConditionalFormatting,
            FidelityFeature::PivotTables,
            FidelityFeature::Tables,
            FidelityFeature::Macros,
            FidelityFeature::ExternalLinks,
            FidelityFeature::Sparklines,
            FidelityFeature::Slicers,
            FidelityFeature::Other,
        ];
        const SAVES: [OnSave; 3] = [OnSave::Preserved, OnSave::Editable, OnSave::Lost];
        self.0
            .into_iter()
            .map(|((f, s), count)| FidelityWarning { feature: FEATURES[f as usize], on_save: SAVES[s as usize], count })
            .collect()
    }
}

pub fn inspect(bytes: &[u8]) -> EngineResult<OriginalPackage> {
    let package = Package::read(bytes)?;
    let content_types = package.text(CONTENT_TYPES).map(|t| ContentTypes::parse(&t)).unwrap_or_default();
    let mut counts = Counts::default();
    let mut out = OriginalPackage::default();
    let mut keep: Vec<String> = Vec::new();
    let mut next_chart_id = 1;

    workbook_level(&package, &mut counts);

    for (index, (_, path)) in package.worksheets().into_iter().enumerate() {
        let mut sheet = SheetState::default();
        let Some(text) = package.text(&path) else {
            out.state.sheets.push(sheet);
            continue;
        };
        // Depth 1 only: `sheetData` can hold millions of cells.
        let elems = xml::elements_upto(&text, 1);
        let Some(root) = xml::root(&elems) else {
            out.state.sheets.push(sheet);
            continue;
        };
        sheet.root_ns = xml::namespace_decls(root.attrs);
        let sheet_rels = package.rels(&path);
        let mut validations: Vec<CellRange> = Vec::new();

        for child in xml::children(&elems, &root) {
            let local = child.local();
            let fragment = child.text(&text);
            if PRESERVED_ELEMENTS.contains(&local) {
                sheet.fragments.push((local.to_string(), fragment.to_string()));
            }
            if local == "sheetData" {
                continue;
            }
            let sub = xml::elements(fragment);
            let Some(top) = xml::root(&sub) else { continue };
            match local {
                "dataValidations" => {
                    for dv in xml::children(&sub, &top).filter(|e| e.local() == "dataValidation") {
                        validations.extend(dv.attr("sqref").map(|s| a1::parse_sqref(&s)).unwrap_or_default());
                        counts.add(FidelityFeature::DataValidation, OnSave::Preserved, 1);
                    }
                }
                "autoFilter" => {
                    if let Some(range) = top.attr("ref").and_then(|r| a1::parse_range(&r)) {
                        sheet.auto_filter = Some((range, fragment.to_string()));
                        out.auto_filters.push((index, range));
                        counts.add(FidelityFeature::AutoFilter, OnSave::Editable, 1);
                    }
                }
                "conditionalFormatting" => counts.add(FidelityFeature::ConditionalFormatting, OnSave::Editable, 1),
                "oleObjects" | "controls" => {
                    let n = xml::children(&sub, &top).count().max(1) as u32;
                    counts.add(FidelityFeature::Other, OnSave::Lost, n);
                }
                "extLst" => {
                    for ext in xml::children(&sub, &top).filter(|e| e.local() == "ext") {
                        let uri = ext.attr("uri").unwrap_or_default().into_owned();
                        let sparklines = xml::descendants(&sub, ext, "sparklineGroup").count() as u32;
                        counts.add(FidelityFeature::Sparklines, OnSave::Preserved, sparklines);
                        for dv in xml::descendants(&sub, ext, "dataValidation") {
                            counts.add(FidelityFeature::DataValidation, OnSave::Preserved, 1);
                            if let Some(sqref) = xml::child_text(fragment, &sub, dv, "sqref") {
                                validations.extend(a1::parse_sqref(sqref));
                            }
                        }
                        let x14_cf = xml::descendants(&sub, ext, "conditionalFormatting").count() as u32;
                        counts.add(FidelityFeature::ConditionalFormatting, OnSave::Editable, x14_cf);
                        let slicers = xml::descendants(&sub, ext, "slicer").count() as u32 + xml::descendants(&sub, ext, "timelineRef").count() as u32;
                        counts.add(FidelityFeature::Slicers, OnSave::Lost, slicers);
                        if PRESERVED_EXT_URIS.iter().any(|u| u.eq_ignore_ascii_case(&uri)) {
                            sheet.exts.push((uri, ext.text(fragment).to_string()));
                        }
                    }
                }
                _ => {}
            }
        }
        if !validations.is_empty() {
            out.data_validations.push((index, validations));
        }

        for rel in sheet_rels.iter().filter(|r| !r.external) {
            let target = package::resolve_target(&path, &rel.target);
            let t = rel.rel_type.as_str();
            if t.ends_with("/pivotTable") {
                counts.add(FidelityFeature::PivotTables, OnSave::Lost, 1);
            } else if t.ends_with("/table") {
                counts.add(FidelityFeature::Tables, OnSave::Preserved, 1);
            } else if t.ends_with("/comments") {
                let n = package.text(&target).map(|c| xml::elements(&c).iter().filter(|e| e.local() == "comment").count()).unwrap_or(0);
                counts.add(FidelityFeature::Comments, OnSave::Preserved, n as u32);
            }
            if PRESERVED_REL_SUFFIXES.iter().any(|s| t.ends_with(s)) && package.contains(&target) {
                sheet.rels.push(Rel { target: target.clone(), ..rel.clone() });
                keep.push(target);
            }
        }

        // Drawing: classify anchors, model charts.
        if let Some(rel) = sheet.rels.iter().find(|r| r.rel_type == REL_DRAWING) {
            if let Some(dxml) = package.text(&rel.target) {
                let drels = package.rels(&rel.target);
                let mut anchors = drawing::parse(&dxml, |id| {
                    drels.iter().find(|r| r.id == id && r.rel_type == REL_CHART && !r.external).map(|r| package::resolve_target(&rel.target, &r.target))
                });
                for anchor in &mut anchors {
                    match anchor.kind {
                        AnchorKind::Chart => {
                            let position = drawing::chart_anchor(&dxml, anchor);
                            if let Some(chart) = &mut anchor.chart {
                                let draft = package.text(&chart.path).and_then(|x| crate::charts::parse_chart_xml(&x).ok().flatten());
                                if let Some(mut draft) = draft {
                                    draft.sheet = 0;
                                    draft.anchor = position;
                                    chart.model = Some(next_chart_id);
                                    out.charts.push((index, ChartSpec { id: next_chart_id, draft, from_file: true }));
                                    next_chart_id += 1;
                                }
                            }
                            counts.add(FidelityFeature::Charts, OnSave::Preserved, 1);
                        }
                        AnchorKind::Image => counts.add(FidelityFeature::Images, OnSave::Preserved, 1),
                        AnchorKind::Shape | AnchorKind::Other => counts.add(FidelityFeature::Shapes, OnSave::Preserved, 1),
                        AnchorKind::Slicer => counts.add(FidelityFeature::Slicers, OnSave::Lost, 1),
                    }
                }
                sheet.drawing = Some((rel.id.clone(), Drawing { path: rel.target.clone(), xml: dxml, anchors }));
            }
        }
        out.state.sheets.push(sheet);
    }

    out.warnings = counts.into_warnings();
    out.state.parts = closure(&package, keep);
    out.state.content_types = content_types;
    Ok(out)
}

/// Workbook-level features: macros, external links, pivot caches, slicers,
/// chartsheets and other sheet kinds.
fn workbook_level(package: &Package, counts: &mut Counts) {
    let workbook = package.workbook_path();
    let rels = package.rels(&workbook);
    let has_vba = rels.iter().any(|r| r.rel_type.ends_with("/vbaProject")) || package.names().any(|n| n.eq_ignore_ascii_case("xl/vbaProject.bin"));
    counts.add(FidelityFeature::Macros, OnSave::Lost, u32::from(has_vba));
    let external = rels.iter().filter(|r| r.rel_type.ends_with("/externalLink")).count() as u32;
    counts.add(FidelityFeature::ExternalLinks, OnSave::Lost, external);
    if let Some(text) = package.text(&workbook) {
        let elems = xml::elements(&text);
        for sheet in elems.iter().filter(|e| e.local() == "sheet" && e.depth == 2) {
            let Some(id) = sheet.attr("r:id") else { continue };
            let Some(rel) = rels.iter().find(|r| r.id == id) else { continue };
            if rel.rel_type.ends_with("/chartsheet") {
                counts.add(FidelityFeature::Charts, OnSave::Lost, 1);
            } else if !rel.rel_type.ends_with("/worksheet") {
                counts.add(FidelityFeature::Other, OnSave::Lost, 1);
            }
        }
    }
}

/// Copies `roots` and every internal part reachable from them through
/// relationships (with the rels parts themselves) into a new package.
fn closure(package: &Package, roots: Vec<String>) -> Package {
    let mut out = Package::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut stack = roots;
    while let Some(part) = stack.pop() {
        if !seen.insert(part.clone()) {
            continue;
        }
        let Some(data) = package.get(&part) else { continue };
        out.set(&part, data.to_vec());
        let rels_path = package::rels_path(&part);
        if let Some(rels) = package.get(&rels_path) {
            out.set(&rels_path, rels.to_vec());
            for rel in package.rels(&part).into_iter().filter(|r| !r.external) {
                stack.push(package::resolve_target(&part, &rel.target));
            }
        }
    }
    out
}
