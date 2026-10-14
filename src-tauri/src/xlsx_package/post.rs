//! `post_process`: re-inserts preserved parts into the package IronCalc wrote.

use std::collections::{HashMap, HashSet};

use crate::engine::types::{ChartId, ChartSpec, EngineResult};

use super::a1;
use super::drawing::{self, AnchorKind};
use super::inspect::{SheetState, State};
use super::package::{self, ContentTypes, Package, Rel, CONTENT_TYPES, CT_CHART, CT_DRAWING, REL_CHART, REL_DRAWING};
use super::xml;
use super::{OriginalPackage, SheetSaveInfo};

pub type ChartWriter = dyn Fn(&ChartSpec, &str) -> EngineResult<String>;

/// Order of `CT_Worksheet` children (ECMA-376 Part 1, 18.3.1.99).
const WORKSHEET_ORDER: [&str; 38] = [
    "sheetPr",
    "dimension",
    "sheetViews",
    "sheetFormatPr",
    "cols",
    "sheetData",
    "sheetCalcPr",
    "sheetProtection",
    "protectedRanges",
    "scenarios",
    "autoFilter",
    "sortState",
    "dataConsolidate",
    "customSheetViews",
    "mergeCells",
    "phoneticPr",
    "conditionalFormatting",
    "dataValidations",
    "hyperlinks",
    "printOptions",
    "pageMargins",
    "pageSetup",
    "headerFooter",
    "rowBreaks",
    "colBreaks",
    "customProperties",
    "cellWatches",
    "ignoredErrors",
    "smartTags",
    "drawing",
    "legacyDrawing",
    "legacyDrawingHF",
    "drawingHF",
    "picture",
    "oleObjects",
    "controls",
    "webPublishItems",
    "tableParts",
];

fn order_of(local: &str) -> usize {
    if local == "extLst" {
        return WORKSHEET_ORDER.len();
    }
    WORKSHEET_ORDER.iter().position(|n| *n == local).unwrap_or(usize::MAX)
}

pub fn post_process(
    fresh: Vec<u8>,
    original: Option<&OriginalPackage>,
    sheets: &[SheetSaveInfo],
    charts: &[ChartSpec],
    write_chart: &ChartWriter,
) -> EngineResult<(Vec<u8>, Vec<ChartId>)> {
    let has_original = original.is_some_and(|o| !o.state.sheets.is_empty());
    if !has_original && charts.is_empty() && sheets.iter().all(|s| s.auto_filter.is_none()) {
        return Ok((fresh, Vec::new()));
    }
    let empty = State::default();
    let state = original.map_or(&empty, |o| &o.state);
    let mut pkg = Package::read(&fresh)?;
    let mut ct = pkg.text(CONTENT_TYPES).map(|t| ContentTypes::parse(&t)).unwrap_or_default();
    let fresh_sheets = pkg.worksheets();
    let mut copier = Copier { state, memo: HashMap::new() };
    let mut dropped = Vec::new();
    let mut used: HashSet<usize> = HashSet::new();
    for (i, info) in sheets.iter().enumerate() {
        let Some((_, path)) = fresh_sheets.get(i) else { continue };
        // A sheet's original parts go to one sheet only (a duplicate must
        // not repeat table names, for instance).
        let orig = info.original_index.filter(|k| used.insert(*k)).and_then(|k| state.sheets.get(k));
        let sheet_charts: Vec<&ChartSpec> = charts.iter().filter(|c| c.draft.sheet == info.id).collect();
        let mut job = SheetJob { pkg: &mut pkg, ct: &mut ct, copier: &mut copier, path, info, orig, write_chart, dropped: &mut dropped };
        job.run(&sheet_charts);
    }
    pkg.set(CONTENT_TYPES, ct.write().into_bytes());
    Ok((pkg.write()?, dropped))
}

/// Copies original parts (and everything they reference) into the new
/// package under free names, rewriting relationship targets.
struct Copier<'a> {
    state: &'a State,
    /// original path -> new path
    memo: HashMap<String, String>,
}

impl Copier<'_> {
    /// Copies `src`. `bytes` / `rels` override the original content and
    /// relationships; `extra` adds relationships to parts already in `pkg`
    /// (targets are package paths).
    fn copy(&mut self, pkg: &mut Package, ct: &mut ContentTypes, src: &str, bytes: Option<Vec<u8>>, rels: Option<Vec<Rel>>, extra: &[Rel]) -> Option<String> {
        if let Some(done) = self.memo.get(src) {
            return Some(done.clone());
        }
        let data = match bytes {
            Some(b) => b,
            None => self.state.parts.get(src)?.to_vec(),
        };
        let new_path = package::free_name(src, |p| pkg.contains(p));
        pkg.set(&new_path, Vec::new()); // reserve the name
        self.memo.insert(src.to_string(), new_path.clone());
        let rels = rels.unwrap_or_else(|| self.state.parts.rels(src));
        let mut out_rels: Vec<Rel> = Vec::with_capacity(rels.len() + extra.len());
        for rel in rels {
            if rel.external {
                out_rels.push(rel);
                continue;
            }
            let child = package::resolve_target(src, &rel.target);
            if let Some(new_child) = self.copy(pkg, ct, &child, None, None, &[]) {
                out_rels.push(Rel { target: package::relative_target(&new_path, &new_child), ..rel });
            }
        }
        for rel in extra {
            out_rels.push(Rel { target: package::relative_target(&new_path, &rel.target), ..rel.clone() });
        }
        if !out_rels.is_empty() {
            pkg.set(&package::rels_path(&new_path), package::write_rels(&out_rels).into_bytes());
        }
        pkg.set(&new_path, data);
        if let Some(content_type) = self.state.content_types.of(src) {
            ct.ensure(&new_path, content_type, self.state.content_types.is_default_for(src));
        }
        Some(new_path)
    }
}

struct SheetJob<'a, 'b> {
    pkg: &'a mut Package,
    ct: &'a mut ContentTypes,
    copier: &'a mut Copier<'b>,
    path: &'a str,
    info: &'a SheetSaveInfo,
    orig: Option<&'b SheetState>,
    write_chart: &'a ChartWriter,
    dropped: &'a mut Vec<ChartId>,
}

/// A splice into the fresh sheet XML.
struct Edit {
    at: usize,
    remove_to: usize,
    order: usize,
    text: String,
}

impl SheetJob<'_, '_> {
    fn run(&mut self, charts: &[&ChartSpec]) {
        let Some(text) = self.pkg.text(self.path) else { return };
        let mut rels = self.pkg.rels(self.path);
        let rels_before = rels.len();
        let fresh_types: HashSet<String> = rels.iter().map(|r| r.rel_type.clone()).collect();
        let mut rid_map: HashMap<String, String> = HashMap::new();

        // 1. Comments, VML and tables, unless IronCalc wrote its own.
        if let Some(orig) = self.orig {
            for rel in orig.rels.iter().filter(|r| r.rel_type != REL_DRAWING && !fresh_types.contains(&r.rel_type)) {
                if let Some(new_path) = self.copier.copy(self.pkg, self.ct, &rel.target, None, None, &[]) {
                    let id = package::next_rel_id(&rels);
                    rels.push(Rel { id: id.clone(), rel_type: rel.rel_type.clone(), target: package::relative_target(self.path, &new_path), external: false });
                    rid_map.insert(rel.id.clone(), id);
                }
            }
        }

        // 2. Drawing (original anchors + edited/new charts).
        let mut drawing_rid = None;
        if !fresh_types.contains(REL_DRAWING) {
            if let Some(path) = self.build_drawing(charts) {
                let id = package::next_rel_id(&rels);
                rels.push(Rel { id: id.clone(), rel_type: REL_DRAWING.to_string(), target: package::relative_target(self.path, &path), external: false });
                drawing_rid = Some(id);
            }
        }

        // 3. Splice fragments into the sheet XML.
        let elems = xml::elements_upto(&text, 1);
        let Some(root) = xml::root(&elems) else { return };
        let children: Vec<xml::Elem<'_>> = xml::children(&elems, &root).copied().collect();
        let present: HashSet<&str> = children.iter().map(|c| c.local()).collect();
        let insert_at = |order: usize| children.iter().find(|c| order_of(c.local()) != usize::MAX && order_of(c.local()) > order).map_or(root.close_start, |c| c.start);
        let mut edits: Vec<Edit> = Vec::new();
        let push = |edits: &mut Vec<Edit>, local: &str, text: String| {
            let order = order_of(local);
            let at = insert_at(order);
            edits.push(Edit { at, remove_to: at, order, text });
        };

        if let Some(orig) = self.orig {
            for (local, fragment) in &orig.fragments {
                if present.contains(local.as_str()) || local == "drawing" {
                    continue;
                }
                let fragment = match local.as_str() {
                    "legacyDrawing" => remap_single(fragment, &rid_map),
                    "tableParts" => remap_table_parts(fragment, &rid_map),
                    // Printer settings parts are not kept.
                    "pageSetup" => Some(strip_rid(fragment)),
                    _ => Some(fragment.clone()),
                };
                if let Some(fragment) = fragment {
                    push(&mut edits, local, fragment);
                }
            }
        }
        if let Some(id) = &drawing_rid {
            if !present.contains("drawing") {
                push(&mut edits, "drawing", format!(r#"<drawing r:id="{id}"/>"#));
            }
        }

        // autoFilter: what the engine says now (original element when unchanged).
        for c in children.iter().filter(|c| c.local() == "autoFilter") {
            edits.push(Edit { at: c.start, remove_to: c.end, order: order_of("autoFilter"), text: String::new() });
        }
        if let Some(range) = self.info.auto_filter {
            let element = match self.orig.and_then(|o| o.auto_filter.as_ref()) {
                Some((orig_range, element)) if *orig_range == range => element.clone(),
                _ => format!(r#"<autoFilter ref="{}"/>"#, a1::format_range(range)),
            };
            push(&mut edits, "autoFilter", element);
        }

        // extLst: merge preserved <ext> blocks.
        if let Some(orig) = self.orig.filter(|o| !o.exts.is_empty()) {
            match children.iter().find(|c| c.local() == "extLst") {
                Some(ext_lst) => {
                    let inner = ext_lst.inner(&text);
                    let add: String = orig.exts.iter().filter(|(uri, _)| !inner.contains(uri.as_str())).map(|(_, x)| x.as_str()).collect();
                    if !add.is_empty() && ext_lst.close_start != ext_lst.end {
                        edits.push(Edit { at: ext_lst.close_start, remove_to: ext_lst.close_start, order: usize::MAX, text: add });
                    }
                }
                None => {
                    let all: String = orig.exts.iter().map(|(_, x)| x.as_str()).collect();
                    push(&mut edits, "extLst", format!("<extLst>{all}</extLst>"));
                }
            }
        }

        // Namespaces used by copied fragments.
        let changed = !edits.is_empty();
        if changed {
            if let Some(orig) = self.orig {
                let have: HashSet<String> = xml::namespace_decls(root.attrs).into_iter().map(|(k, _)| k).collect();
                let add: String = orig.root_ns.iter().filter(|(k, _)| !have.contains(k)).map(|(k, v)| format!(r#" {k}="{v}""#)).collect();
                if !add.is_empty() {
                    let at = root.open_end - if text[..root.open_end].ends_with("/>") { 2 } else { 1 };
                    edits.push(Edit { at, remove_to: at, order: 0, text: add });
                }
            }
        }

        if changed {
            edits.sort_by_key(|e| (e.at, e.order));
            let mut out = String::with_capacity(text.len() + edits.iter().map(|e| e.text.len()).sum::<usize>());
            let mut pos = 0;
            for edit in &edits {
                if edit.at < pos {
                    continue;
                }
                out.push_str(&text[pos..edit.at]);
                out.push_str(&edit.text);
                pos = edit.remove_to.max(edit.at);
            }
            out.push_str(&text[pos..]);
            self.pkg.set(self.path, out.into_bytes());
        }
        if rels.len() != rels_before {
            self.pkg.set(&package::rels_path(self.path), package::write_rels(&rels).into_bytes());
        }
    }

    /// Builds and stores the sheet's drawing part; returns its path.
    fn build_drawing(&mut self, charts: &[&ChartSpec]) -> Option<String> {
        let orig_drawing = self.orig.and_then(|o| o.drawing.as_ref()).map(|(_, d)| d);
        let modeled: HashSet<ChartId> = orig_drawing.map(|d| d.anchors.iter().filter_map(|a| a.chart.as_ref()?.model).collect()).unwrap_or_default();
        let by_id: HashMap<ChartId, &ChartSpec> = charts.iter().map(|c| (c.id, *c)).collect();
        let new_charts: Vec<&ChartSpec> = charts.iter().copied().filter(|c| !modeled.contains(&c.id)).collect();
        if orig_drawing.is_none() && new_charts.is_empty() {
            return None;
        }
        let state_rels: Vec<Rel> = orig_drawing.map(|d| self.copier.state.parts.rels(&d.path)).unwrap_or_default();
        let mut xml_text = orig_drawing.map_or_else(drawing::empty_drawing_xml, |d| d.xml.clone());
        let mut drawing_rels = state_rels.clone();
        let mut next_shape = drawing::max_shape_id(&xml_text) + 1;
        let mut chart_overrides: Vec<(String, String)> = Vec::new();

        // Edit / remove original anchors, back to front so spans stay valid.
        if let Some(d) = orig_drawing {
            for anchor in d.anchors.iter().rev() {
                let replacement = match (anchor.kind, &anchor.chart) {
                    (AnchorKind::Slicer, _) => Some(String::new()),
                    (AnchorKind::Chart, Some(chart)) => match chart.model.map(|id| (id, by_id.get(&id))) {
                        Some((_, None)) => {
                            drawing_rels.retain(|r| r.id != chart.rel_id);
                            Some(String::new())
                        }
                        Some((id, Some(spec))) if !spec.from_file => match (self.write_chart)(spec, &self.info.name) {
                            Ok(chart_xml) => {
                                chart_overrides.push((chart.path.clone(), chart_xml));
                                let name = format!("Gráfico {next_shape}");
                                let x = drawing::chart_anchor_xml(&spec.draft.anchor, &chart.rel_id, next_shape, &name);
                                next_shape += 1;
                                Some(x)
                            }
                            Err(_) => {
                                self.dropped.push(id);
                                None
                            }
                        },
                        _ => None,
                    },
                    _ => None,
                };
                if let Some(text) = replacement {
                    xml_text.replace_range(anchor.start..anchor.end, &text);
                }
            }
        }

        // New charts.
        let mut extra: Vec<Rel> = Vec::new();
        let mut anchors_xml = String::new();
        for spec in new_charts {
            match (self.write_chart)(spec, &self.info.name) {
                Ok(chart_xml) => {
                    // Original part names stay reserved for the original parts.
                    let path = package::free_name("xl/charts/chart1.xml", |p| self.pkg.contains(p) || self.copier.state.parts.contains(p));
                    self.pkg.set(&path, chart_xml.into_bytes());
                    self.ct.ensure(&path, CT_CHART, false);
                    let mut all: Vec<Rel> = drawing_rels.clone();
                    all.extend(extra.iter().cloned());
                    let id = package::next_rel_id(&all);
                    extra.push(Rel { id: id.clone(), rel_type: REL_CHART.to_string(), target: path, external: false });
                    anchors_xml.push_str(&drawing::chart_anchor_xml(&spec.draft.anchor, &id, next_shape, &format!("Gráfico {next_shape}")));
                    next_shape += 1;
                }
                Err(_) => self.dropped.push(spec.id),
            }
        }
        if !anchors_xml.is_empty() {
            xml_text = drawing::open_root(&xml_text);
            let at = drawing::insertion_point(&xml_text);
            xml_text.insert_str(at, &anchors_xml);
        }

        match orig_drawing {
            Some(_) if anchors_xml.is_empty() && xml::elements_upto(&xml_text, 1).len() <= 1 => None,
            Some(d) => {
                // Edited charts: their parts get the new XML (the chart's own
                // style/color parts are kept).
                for (chart_path, chart_xml) in chart_overrides {
                    let bytes = chart_xml.into_bytes();
                    let rels = self.copier.state.parts.rels(&chart_path);
                    self.copier.copy(self.pkg, self.ct, &chart_path, Some(bytes), Some(rels), &[]);
                }
                self.copier.copy(self.pkg, self.ct, &d.path, Some(xml_text.into_bytes()), Some(drawing_rels), &extra)
            }
            None => {
                if extra.is_empty() {
                    return None;
                }
                let path = package::free_name("xl/drawings/drawing1.xml", |p| self.pkg.contains(p) || self.copier.state.parts.contains(p));
                let rels: Vec<Rel> = extra.into_iter().map(|r| Rel { target: package::relative_target(&path, &r.target), ..r }).collect();
                self.pkg.set(&package::rels_path(&path), package::write_rels(&rels).into_bytes());
                self.pkg.set(&path, xml_text.into_bytes());
                self.ct.ensure(&path, CT_DRAWING, false);
                Some(path)
            }
        }
    }
}

/// Rewrites the single `r:id` of an element; None when it was not kept.
fn remap_single(fragment: &str, map: &HashMap<String, String>) -> Option<String> {
    let elems = xml::elements(fragment);
    let root = xml::root(&elems)?;
    let new_id = map.get(root.attr("r:id")?.as_ref())?;
    let open = &fragment[root.start..root.open_end];
    let replaced = xml::replace_attr(open, "r:id", new_id)?;
    Some(format!("{replaced}{}", &fragment[root.open_end..]))
}

/// `<tableParts>` with only the kept tables, ids remapped.
fn remap_table_parts(fragment: &str, map: &HashMap<String, String>) -> Option<String> {
    let elems = xml::elements(fragment);
    let root = xml::root(&elems)?;
    let parts: Vec<String> = xml::children(&elems, &root)
        .filter_map(|e| {
            let new_id = map.get(e.attr("r:id")?.as_ref())?;
            xml::replace_attr(e.text(fragment), "r:id", new_id)
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    let tag = root.name;
    Some(format!(r#"<{tag} count="{}">{}</{tag}>"#, parts.len(), parts.concat()))
}

/// Removes the `r:id` attribute from the start tag of a fragment.
fn strip_rid(fragment: &str) -> String {
    let elems = xml::elements(fragment);
    let Some(root) = xml::root(&elems) else { return fragment.to_string() };
    let open = &fragment[root.start..root.open_end];
    let Some(at) = open.find(" r:id=") else { return fragment.to_string() };
    let rest = &open[at + 6..];
    let quote = rest.chars().next().unwrap_or('"');
    let Some(close) = rest[1..].find(quote) else { return fragment.to_string() };
    let new_open = format!("{}{}", &open[..at], &rest[close + 2..]);
    format!("{new_open}{}", &fragment[root.open_end..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragment_helpers() {
        let map: HashMap<String, String> = [("rId3".to_string(), "rId7".to_string())].into();
        assert_eq!(remap_single(r#"<legacyDrawing r:id="rId3"/>"#, &map).unwrap(), r#"<legacyDrawing r:id="rId7"/>"#);
        assert!(remap_single(r#"<legacyDrawing r:id="rId1"/>"#, &map).is_none());
        let tp = remap_table_parts(r#"<tableParts count="2"><tablePart r:id="rId1"/><tablePart r:id="rId3"/></tableParts>"#, &map).unwrap();
        assert_eq!(tp, r#"<tableParts count="1"><tablePart r:id="rId7"/></tableParts>"#);
        assert_eq!(strip_rid(r#"<pageSetup paperSize="9" r:id="rId1" orientation="landscape"/>"#), r#"<pageSetup paperSize="9" orientation="landscape"/>"#);
        assert_eq!(strip_rid(r#"<pageSetup paperSize="9"/>"#), r#"<pageSetup paperSize="9"/>"#);
    }
}
