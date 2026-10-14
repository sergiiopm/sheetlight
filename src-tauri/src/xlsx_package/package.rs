//! OPC package plumbing: zip entries, relationships, content types and part
//! path arithmetic.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use crate::engine::types::{EngineError, EngineErrorCode, EngineResult};

use super::xml;

pub const REL_OFFICE_DOCUMENT: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
pub const REL_DRAWING: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
pub const REL_CHART: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
pub const NS_RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub const CT_DRAWING: &str = "application/vnd.openxmlformats-officedocument.drawing+xml";
pub const CT_CHART: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";

/// Uncompressed size above which a package is rejected (zip bomb guard).
const MAX_TOTAL_BYTES: u64 = 2 << 30;

pub fn parse_error() -> EngineError {
    EngineError::new(EngineErrorCode::Parse, "El archivo no es un libro de Excel válido o está dañado.")
}

/// All entries of a zip package, in their original order.
#[derive(Debug, Default, Clone)]
pub struct Package {
    entries: Vec<(String, Vec<u8>)>,
    index: HashMap<String, usize>,
}

impl Package {
    pub fn read(bytes: &[u8]) -> EngineResult<Package> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| parse_error())?;
        let mut package = Package::default();
        let mut total: u64 = 0;
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|_| parse_error())?;
            if file.is_dir() {
                continue;
            }
            total += file.size();
            if total > MAX_TOTAL_BYTES {
                return Err(EngineError::new(EngineErrorCode::TooLarge, "El archivo es demasiado grande."));
            }
            let name = file.name().trim_start_matches('/').to_string();
            let mut data = Vec::with_capacity(file.size().min(64 << 20) as usize);
            file.read_to_end(&mut data).map_err(|_| parse_error())?;
            package.set(&name, data);
        }
        Ok(package)
    }

    pub fn write(&self) -> EngineResult<Vec<u8>> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let fail = |_| EngineError::internal("No se pudo generar el archivo .xlsx.");
        // `[Content_Types].xml` first, as Excel writes it.
        let order = self.entries.iter().filter(|(n, _)| n == "[Content_Types].xml").chain(self.entries.iter().filter(|(n, _)| n != "[Content_Types].xml"));
        for (name, data) in order {
            zip.start_file(name.as_str(), options).map_err(fail)?;
            zip.write_all(data).map_err(|_| EngineError::internal("No se pudo generar el archivo .xlsx."))?;
        }
        let cursor = zip.finish().map_err(fail)?;
        Ok(cursor.into_inner())
    }

    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.index.get(path).map(|&i| self.entries[i].1.as_slice())
    }

    /// Part as text (lossy for invalid UTF-8; OOXML parts are UTF-8).
    pub fn text(&self, path: &str) -> Option<String> {
        self.get(path).map(decode_xml)
    }

    pub fn contains(&self, path: &str) -> bool {
        self.index.contains_key(path)
    }

    pub fn set(&mut self, path: &str, data: Vec<u8>) {
        match self.index.get(path) {
            Some(&i) => self.entries[i].1 = data,
            None => {
                self.index.insert(path.to_string(), self.entries.len());
                self.entries.push((path.to_string(), data));
            }
        }
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(n, _)| n.as_str())
    }

    /// Relationships of `part` (empty when it has none).
    pub fn rels(&self, part: &str) -> Vec<Rel> {
        self.text(&rels_path(part)).map(|x| parse_rels(&x)).unwrap_or_default()
    }

    /// The main workbook part (`xl/workbook.xml` unless `_rels/.rels` says otherwise).
    pub fn workbook_path(&self) -> String {
        self.rels("")
            .into_iter()
            .find(|r| r.rel_type == REL_OFFICE_DOCUMENT && !r.external)
            .map(|r| resolve_target("", &r.target))
            .unwrap_or_else(|| "xl/workbook.xml".to_string())
    }

    /// Worksheets in workbook order: `(name, part path)`. Chartsheets and
    /// dialog sheets are skipped, matching IronCalc's sheet indices.
    pub fn worksheets(&self) -> Vec<(String, String)> {
        let workbook = self.workbook_path();
        let Some(xml_text) = self.text(&workbook) else {
            return Vec::new();
        };
        let rels = self.rels(&workbook);
        let elems = xml::elements(&xml_text);
        elems
            .iter()
            .filter(|e| e.local() == "sheet" && e.depth == 2)
            .filter_map(|e| {
                let name = e.attr("name")?.into_owned();
                let id = e.attr("r:id")?;
                let rel = rels.iter().find(|r| r.id == id)?;
                rel.rel_type.ends_with("/worksheet").then(|| (name, resolve_target(&workbook, &rel.target)))
            })
            .collect()
    }
}

/// Decodes an XML part: UTF-8 (BOM stripped) or UTF-16 with BOM.
pub fn decode_xml(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return text.into_owned();
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rel {
    pub id: String,
    pub rel_type: String,
    pub target: String,
    pub external: bool,
}

pub fn parse_rels(text: &str) -> Vec<Rel> {
    xml::elements(text)
        .iter()
        .filter(|e| e.local() == "Relationship")
        .filter_map(|e| {
            Some(Rel {
                id: e.attr("Id")?.into_owned(),
                rel_type: e.attr("Type")?.into_owned(),
                target: e.attr("Target")?.into_owned(),
                external: e.attr("TargetMode").is_some_and(|m| m.eq_ignore_ascii_case("external")),
            })
        })
        .collect()
}

pub fn write_rels(rels: &[Rel]) -> String {
    let mut out = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
    out.push_str("\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    for rel in rels {
        out.push_str(&format!(r#"<Relationship Id="{}" Type="{}" Target="{}""#, xml::escape(&rel.id), xml::escape(&rel.rel_type), xml::escape(&rel.target)));
        if rel.external {
            out.push_str(r#" TargetMode="External""#);
        }
        out.push_str("/>");
    }
    out.push_str("</Relationships>");
    out
}

/// A relationship id not used in `rels` (`rId{n}`).
pub fn next_rel_id(rels: &[Rel]) -> String {
    let max = rels.iter().filter_map(|r| r.id.strip_prefix("rId").and_then(|n| n.parse::<u32>().ok())).max().unwrap_or(0);
    let mut n = max + 1;
    loop {
        let id = format!("rId{n}");
        if !rels.iter().any(|r| r.id == id) {
            return id;
        }
        n += 1;
    }
}

/// `xl/worksheets/sheet1.xml` -> `xl/worksheets/_rels/sheet1.xml.rels`; `""` -> `_rels/.rels`.
pub fn rels_path(part: &str) -> String {
    let (dir, file) = split(part);
    if dir.is_empty() {
        format!("_rels/{file}.rels")
    } else {
        format!("{dir}/_rels/{file}.rels")
    }
}

fn split(part: &str) -> (&str, &str) {
    part.rsplit_once('/').unwrap_or(("", part))
}

/// Resolves a relationship target relative to its source part.
pub fn resolve_target(source: &str, target: &str) -> String {
    let target = target.split('#').next().unwrap_or(target);
    let mut segments: Vec<&str> = Vec::new();
    if let Some(absolute) = target.strip_prefix('/') {
        return normalize(absolute.split('/'), &mut segments);
    }
    let (dir, _) = split(source);
    if !dir.is_empty() {
        segments.extend(dir.split('/'));
    }
    normalize(target.split('/'), &mut segments)
}

fn normalize<'a>(parts: impl Iterator<Item = &'a str>, segments: &mut Vec<&'a str>) -> String {
    for p in parts {
        match p {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            p => segments.push(p),
        }
    }
    segments.join("/")
}

/// Relative target from `source` part to `target` part (`../drawings/drawing1.xml`).
pub fn relative_target(source: &str, target: &str) -> String {
    let (dir, _) = split(source);
    let from: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    let to: Vec<&str> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count().min(to.len().saturating_sub(1));
    let mut out: Vec<&str> = std::iter::repeat_n("..", from.len() - common).collect();
    out.extend(&to[common..]);
    out.join("/")
}

/// A free part name like `path`: keeps it when unused, otherwise bumps the
/// trailing number (`xl/drawings/drawing1.xml` -> `drawing2.xml`).
pub fn free_name(path: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(path) {
        return path.to_string();
    }
    let (dir, file) = split(path);
    let (stem, ext) = file.rsplit_once('.').map_or((file, ""), |(s, e)| (s, e));
    let base = stem.trim_end_matches(|c: char| c.is_ascii_digit());
    let base = if base.is_empty() { "part" } else { base };
    let mut n = 1;
    loop {
        let name = if ext.is_empty() { format!("{base}{n}") } else { format!("{base}{n}.{ext}") };
        let candidate = if dir.is_empty() { name } else { format!("{dir}/{name}") };
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// `[Content_Types].xml`.
#[derive(Debug, Default, Clone)]
pub struct ContentTypes {
    pub defaults: Vec<(String, String)>,
    pub overrides: Vec<(String, String)>,
}

pub const CONTENT_TYPES: &str = "[Content_Types].xml";

impl ContentTypes {
    pub fn parse(text: &str) -> ContentTypes {
        let mut out = ContentTypes::default();
        for e in xml::elements(text) {
            match e.local() {
                "Default" => {
                    if let (Some(ext), Some(ct)) = (e.attr("Extension"), e.attr("ContentType")) {
                        out.defaults.push((ext.to_ascii_lowercase(), ct.into_owned()));
                    }
                }
                "Override" => {
                    if let (Some(part), Some(ct)) = (e.attr("PartName"), e.attr("ContentType")) {
                        out.overrides.push((part.trim_start_matches('/').to_string(), ct.into_owned()));
                    }
                }
                _ => {}
            }
        }
        out
    }

    pub fn of(&self, part: &str) -> Option<&str> {
        if let Some((_, ct)) = self.overrides.iter().find(|(p, _)| p.eq_ignore_ascii_case(part)) {
            return Some(ct);
        }
        let ext = part.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase())?;
        self.defaults.iter().find(|(e, _)| *e == ext).map(|(_, ct)| ct.as_str())
    }

    /// Makes `part` resolve to `content_type`, preferring an extension default
    /// when the original used one.
    pub fn ensure(&mut self, part: &str, content_type: &str, via_default: bool) {
        if self.of(part) == Some(content_type) {
            return;
        }
        let ext = part.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
        if via_default {
            if let Some(ext) = ext {
                if !self.defaults.iter().any(|(e, _)| *e == ext) {
                    self.defaults.push((ext, content_type.to_string()));
                    return;
                }
            }
        }
        self.overrides.retain(|(p, _)| !p.eq_ignore_ascii_case(part));
        self.overrides.push((part.to_string(), content_type.to_string()));
    }

    pub fn is_default_for(&self, part: &str) -> bool {
        !self.overrides.iter().any(|(p, _)| p.eq_ignore_ascii_case(part)) && self.of(part).is_some()
    }

    pub fn write(&self) -> String {
        let mut out = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#);
        out.push_str("\n<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">");
        for (ext, ct) in &self.defaults {
            out.push_str(&format!(r#"<Default Extension="{}" ContentType="{}"/>"#, xml::escape(ext), xml::escape(ct)));
        }
        for (part, ct) in &self.overrides {
            out.push_str(&format!(r#"<Override PartName="/{}" ContentType="{}"/>"#, xml::escape(part), xml::escape(ct)));
        }
        out.push_str("</Types>");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_arithmetic() {
        assert_eq!(rels_path("xl/worksheets/sheet1.xml"), "xl/worksheets/_rels/sheet1.xml.rels");
        assert_eq!(rels_path(""), "_rels/.rels");
        assert_eq!(resolve_target("xl/worksheets/sheet1.xml", "../drawings/drawing1.xml"), "xl/drawings/drawing1.xml");
        assert_eq!(resolve_target("xl/workbook.xml", "worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(resolve_target("xl/workbook.xml", "/xl/worksheets/sheet1.xml"), "xl/worksheets/sheet1.xml");
        assert_eq!(resolve_target("", "xl/workbook.xml"), "xl/workbook.xml");
        assert_eq!(relative_target("xl/worksheets/sheet1.xml", "xl/drawings/drawing1.xml"), "../drawings/drawing1.xml");
        assert_eq!(relative_target("xl/drawings/drawing1.xml", "xl/drawings/x.xml"), "x.xml");
        assert_eq!(relative_target("xl/workbook.xml", "xl/worksheets/sheet2.xml"), "worksheets/sheet2.xml");
        for (src, dst) in [("xl/worksheets/sheet1.xml", "xl/comments1.xml"), ("xl/charts/chart1.xml", "xl/charts/colors1.xml"), ("xl/drawings/d.xml", "xl/media/image1.png")] {
            assert_eq!(resolve_target(src, &relative_target(src, dst)), dst);
        }
    }

    #[test]
    fn free_names_bump_numbers() {
        let taken = ["xl/drawings/drawing1.xml", "xl/drawings/drawing2.xml"];
        assert_eq!(free_name("xl/drawings/drawing1.xml", |p| taken.contains(&p)), "xl/drawings/drawing3.xml");
        assert_eq!(free_name("xl/media/image9.png", |p| taken.contains(&p)), "xl/media/image9.png");
    }

    #[test]
    fn rels_and_content_types_round_trip() {
        let rels = vec![Rel { id: "rId1".into(), rel_type: REL_DRAWING.into(), target: "../drawings/drawing1.xml".into(), external: false }, Rel { id: "rId3".into(), rel_type: "x/hyperlink".into(), target: "https://a.es/?a=1&b=2".into(), external: true }];
        let parsed = parse_rels(&write_rels(&rels));
        assert_eq!(parsed, rels);
        assert_eq!(next_rel_id(&rels), "rId4");
        let mut ct = ContentTypes::parse(r#"<Types><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="wb"/></Types>"#);
        assert_eq!(ct.of("xl/workbook.xml"), Some("wb"));
        assert_eq!(ct.of("xl/other.xml"), Some("application/xml"));
        ct.ensure("xl/media/image1.png", "image/png", true);
        ct.ensure("xl/drawings/drawing1.xml", CT_DRAWING, false);
        let again = ContentTypes::parse(&ct.write());
        assert_eq!(again.of("xl/media/image1.png"), Some("image/png"));
        assert_eq!(again.of("xl/drawings/drawing1.xml"), Some(CT_DRAWING));
    }
}
