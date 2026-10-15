//! Minimal namespace-agnostic XML tree for chart parts. Chart XML is small
//! (a few KB), so building a tree is simpler and safer than a streaming state
//! machine. Element names are stored without their prefix (`c:ser` -> `ser`).

use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

#[derive(Debug, Default)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Element>,
    /// Concatenated character data directly inside this element.
    pub text: String,
}

impl Element {
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    /// Follows a path of child names, e.g. `["tx", "strRef", "f"]`.
    pub fn path(&self, names: &[&str]) -> Option<&Element> {
        let mut cur = self;
        for name in names {
            cur = cur.child(name)?;
        }
        Some(cur)
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    /// `val` attribute of a child (`<c:barDir val="col"/>`).
    pub fn child_val(&self, name: &str) -> Option<&str> {
        self.child(name)?.attr("val")
    }

    /// Depth-first search for all descendants with this name.
    pub fn descendants<'a>(&'a self, name: &str, out: &mut Vec<&'a Element>) {
        for child in &self.children {
            if child.name == name {
                out.push(child);
            }
            child.descendants(name, out);
        }
    }
}

fn local(name: &str) -> &str {
    match name.rfind(':') {
        Some(i) => &name[i + 1..],
        None => name,
    }
}

fn start_element(e: &BytesStart<'_>) -> Result<Element, String> {
    let name = local(e.name().as_ref()).to_string();
    let mut attrs = Vec::new();
    for attr in e.attributes() {
        let attr = attr.map_err(|err| err.to_string())?;
        let key = local(attr.key.as_ref()).to_string();
        let value = attr
            .normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .map_err(|err| err.to_string())?
            .into_owned();
        attrs.push((key, value));
    }
    Ok(Element {
        name,
        attrs,
        children: Vec::new(),
        text: String::new(),
    })
}

/// Parses a whole document and returns its root element.
pub fn parse(xml: &str) -> Result<Element, String> {
    let mut reader = Reader::from_str(xml);
    let mut stack: Vec<Element> = Vec::new();
    let mut root: Option<Element> = None;
    loop {
        match reader.read_event().map_err(|e| e.to_string())? {
            Event::Start(e) => stack.push(start_element(&e)?),
            Event::Empty(e) => {
                let el = start_element(&e)?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => root = Some(el),
                }
            }
            Event::End(_) => {
                let el = stack.pop().ok_or("unbalanced end tag")?;
                match stack.last_mut() {
                    Some(parent) => parent.children.push(el),
                    None => root = Some(el),
                }
            }
            Event::Text(t) => {
                if let Some(cur) = stack.last_mut() {
                    cur.text.push_str(&t.xml10_content());
                }
            }
            Event::CData(t) => {
                if let Some(cur) = stack.last_mut() {
                    cur.text.push_str(&t.into_inner());
                }
            }
            Event::GeneralRef(r) => {
                if let Some(cur) = stack.last_mut() {
                    if let Ok(Some(ch)) = r.resolve_char_ref() {
                        cur.text.push(ch);
                    } else if let Some(s) = resolve_predefined_entity(&r.xml10_content()) {
                        cur.text.push_str(s);
                    } else {
                        return Err(format!("unknown entity &{};", r.xml10_content()));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !stack.is_empty() {
        return Err("unexpected end of document".into());
    }
    root.ok_or_else(|| "empty document".into())
}
