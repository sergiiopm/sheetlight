//! Minimal span-preserving XML scanner for OOXML parts.
//!
//! The fidelity layer copies fragments of the original package byte for byte
//! and splices them into the parts IronCalc writes, so it needs exact byte
//! spans of elements rather than a DOM. Parts are machine-written and
//! well-formed; the scanner handles declarations, comments, CDATA, quoted
//! attribute values containing `>` and namespace prefixes. Malformed input
//! never panics: unclosed elements simply end at the end of the text.

use std::borrow::Cow;

/// One element with its byte span in the source text.
#[derive(Debug, Clone, Copy)]
pub struct Elem<'a> {
    /// Qualified name as written (`x14:sparklineGroup`).
    pub name: &'a str,
    /// Raw attribute text of the start tag.
    pub attrs: &'a str,
    /// Offset of `<` of the start tag.
    pub start: usize,
    /// Offset just after the start tag's `>`.
    pub open_end: usize,
    /// Offset of `<` of the end tag (== `open_end` for empty elements).
    pub close_start: usize,
    /// Offset just after the end tag (or the empty tag).
    pub end: usize,
    pub depth: u32,
}

impl<'a> Elem<'a> {
    pub fn local(&self) -> &'a str {
        local(self.name)
    }

    pub fn prefix(&self) -> Option<&'a str> {
        self.name.split_once(':').map(|(p, _)| p)
    }

    pub fn attr(&self, name: &str) -> Option<Cow<'a, str>> {
        attr(self.attrs, name)
    }

    /// Full source text of the element.
    pub fn text<'s>(&self, xml: &'s str) -> &'s str {
        &xml[self.start..self.end]
    }

    /// Text between the start and the end tag (empty for `<a/>`).
    pub fn inner<'s>(&self, xml: &'s str) -> &'s str {
        &xml[self.open_end..self.close_start]
    }

    pub fn contains(&self, other: &Elem<'_>) -> bool {
        other.start >= self.start && other.end <= self.end
    }
}

pub fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, l)| l)
}

/// Every element of `xml`, in document order.
pub fn elements(xml: &str) -> Vec<Elem<'_>> {
    elements_upto(xml, u32::MAX)
}

/// Elements with `depth <= max_depth` only: scanning a worksheet with
/// millions of cells for its top-level children stays allocation-light.
pub fn elements_upto(xml: &str, max_depth: u32) -> Vec<Elem<'_>> {
    let bytes = xml.as_bytes();
    let mut out: Vec<Elem<'_>> = Vec::new();
    // Index into `out` of each open element (None when deeper than `max_depth`).
    let mut stack: Vec<Option<usize>> = Vec::new();
    let mut i = 0;
    while let Some(off) = memchr::memchr(b'<', &bytes[i..]) {
        let lt = i + off;
        let rest = &xml[lt..];
        if rest.starts_with("<?") {
            i = find_after(xml, lt, "?>");
            continue;
        }
        if rest.starts_with("<!--") {
            i = find_after(xml, lt, "-->");
            continue;
        }
        if rest.starts_with("<![CDATA[") {
            i = find_after(xml, lt, "]]>");
            continue;
        }
        if rest.starts_with("<!") {
            i = find_after(xml, lt, ">");
            continue;
        }
        let Some(gt) = tag_end(bytes, lt + 1) else {
            break;
        };
        let end = (gt + 1).min(xml.len());
        if bytes.get(lt + 1) == Some(&b'/') {
            if let Some(Some(index)) = stack.pop() {
                out[index].close_start = lt;
                out[index].end = end;
            }
            i = end;
            continue;
        }
        let body_end = if gt > lt + 1 && bytes[gt - 1] == b'/' { gt - 1 } else { gt };
        let body = &xml[lt + 1..body_end];
        let name_len = body.find(|c: char| c.is_ascii_whitespace()).unwrap_or(body.len());
        let name = &body[..name_len];
        let attrs = body[name_len..].trim();
        let empty = body_end != gt;
        let depth = stack.len() as u32;
        let slot = if depth <= max_depth {
            out.push(Elem { name, attrs, start: lt, open_end: end, close_start: end, end, depth });
            Some(out.len() - 1)
        } else {
            None
        };
        if !empty {
            stack.push(slot);
        }
        i = end;
    }
    // Unclosed elements end at the end of the text.
    for index in stack.into_iter().flatten() {
        out[index].close_start = xml.len();
        out[index].end = xml.len();
    }
    out
}

fn find_after(xml: &str, from: usize, pat: &str) -> usize {
    xml[from..].find(pat).map_or(xml.len(), |p| from + p + pat.len())
}

/// Offset of the `>` closing a tag that starts before `from`, skipping quoted values.
fn tag_end(bytes: &[u8], from: usize) -> Option<usize> {
    let mut quote = 0u8;
    let mut i = from;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if b == quote {
                quote = 0;
            }
        } else if b == b'"' || b == b'\'' {
            quote = b;
        } else if b == b'>' {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Value of attribute `name` (exact qualified name, or local name when
/// `name` has no prefix and no exact match exists), unescaped.
pub fn attr<'a>(attrs: &'a str, name: &str) -> Option<Cow<'a, str>> {
    let mut fallback = None;
    for (key, value) in attr_iter(attrs) {
        if key == name {
            return Some(unescape(value));
        }
        if !name.contains(':') && local(key) == name && !key.starts_with("xmlns") && fallback.is_none() {
            fallback = Some(value);
        }
    }
    fallback.map(unescape)
}

/// Iterates `(key, raw value)` pairs.
pub fn attr_iter(attrs: &str) -> impl Iterator<Item = (&str, &str)> {
    let mut rest = attrs;
    std::iter::from_fn(move || {
        let trimmed = rest.trim_start();
        let eq = trimmed.find('=')?;
        let key = trimmed[..eq].trim();
        let after = trimmed[eq + 1..].trim_start();
        let quote = after.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let close = after[1..].find(quote)? + 1;
        let value = &after[1..close];
        rest = &after[close + 1..];
        Some((key, value))
    })
}

pub fn unescape(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp..];
        let Some(semi) = after.find(';') else {
            out.push_str(after);
            rest = "";
            break;
        };
        let entity = &after[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &after[1..];
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

pub fn escape(text: &str) -> Cow<'_, str> {
    if !text.contains(['&', '<', '>', '"', '\'']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}

/// Root element (depth 0) of a part.
pub fn root<'a>(elems: &[Elem<'a>]) -> Option<Elem<'a>> {
    elems.iter().find(|e| e.depth == 0).copied()
}

/// Direct children of `parent`.
pub fn children<'a, 'b>(elems: &'b [Elem<'a>], parent: &'b Elem<'a>) -> impl Iterator<Item = &'b Elem<'a>> + 'b {
    elems.iter().filter(move |e| e.depth == parent.depth + 1 && parent.contains(e) && e.start != parent.start)
}

/// Descendants of `parent` with local name `name`.
pub fn descendants<'a, 'b>(elems: &'b [Elem<'a>], parent: &'b Elem<'a>, name: &'b str) -> impl Iterator<Item = &'b Elem<'a>> + 'b {
    elems.iter().filter(move |e| e.depth > parent.depth && parent.contains(e) && e.local() == name)
}

/// Text content of the first descendant named `name` (e.g. `<xdr:col>3</xdr:col>`).
pub fn child_text<'s>(xml: &'s str, elems: &[Elem<'_>], parent: &Elem<'_>, name: &str) -> Option<&'s str> {
    descendants(elems, parent, name).next().map(|e| xml[e.open_end..e.close_start].trim())
}

/// Replaces the value of attribute `name` inside the start tag `start_tag`
/// (full text `<x ... >`), or returns None if it is absent.
pub fn replace_attr(start_tag: &str, name: &str, value: &str) -> Option<String> {
    let mut search = 0;
    while let Some(pos) = start_tag[search..].find(name) {
        let at = search + pos;
        let before_ok = at > 0 && start_tag.as_bytes()[at - 1].is_ascii_whitespace();
        let after = &start_tag[at + name.len()..];
        let after_trim = after.trim_start();
        if before_ok && after_trim.starts_with('=') {
            let value_part = after_trim[1..].trim_start();
            let quote = value_part.chars().next()?;
            let open = start_tag.len() - value_part.len();
            let close = value_part[1..].find(quote)? + 1;
            let mut out = String::with_capacity(start_tag.len() + value.len());
            out.push_str(&start_tag[..open + 1]);
            out.push_str(&escape(value));
            out.push_str(&start_tag[open + close..]);
            return Some(out);
        }
        search = at + name.len();
    }
    None
}

/// `xmlns` / `xmlns:p` declarations of a start tag as `(attribute, value)`.
pub fn namespace_decls(attrs: &str) -> Vec<(String, String)> {
    attr_iter(attrs).filter(|(k, _)| *k == "xmlns" || k.starts_with("xmlns:")).map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_and_depths() {
        let xml = r#"<?xml version="1.0"?><!-- c --><a x="1>2"><b/><c:d y='q'>t<![CDATA[<no/>]]></c:d></a>"#;
        let e = elements(xml);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].name, "a");
        assert_eq!(e[0].attr("x").as_deref(), Some("1>2"));
        assert_eq!(e[1].text(xml), "<b/>");
        assert_eq!(e[2].local(), "d");
        assert_eq!(e[2].prefix(), Some("c"));
        assert_eq!(e[2].inner(xml), "t<![CDATA[<no/>]]>");
        assert_eq!(e[2].depth, 1);
        assert_eq!(e[0].end, xml.len());
        let root = root(&e).unwrap();
        assert_eq!(children(&e, &root).count(), 2);
        let top = elements_upto(xml, 1);
        assert_eq!(top.len(), 3);
        assert_eq!(elements_upto(xml, 0).len(), 1);
        assert_eq!(elements_upto(xml, 0)[0].end, xml.len());
    }

    #[test]
    fn attributes_unescape_and_replace() {
        let tag = r#"<drawing r:id="rId2" name="a&amp;b"/>"#;
        let e = elements(tag);
        assert_eq!(e[0].attr("r:id").as_deref(), Some("rId2"));
        assert_eq!(e[0].attr("id").as_deref(), Some("rId2"));
        assert_eq!(e[0].attr("name").as_deref(), Some("a&b"));
        assert_eq!(replace_attr(tag, "r:id", "rId9").unwrap(), r#"<drawing r:id="rId9" name="a&amp;b"/>"#);
        assert_eq!(unescape("&#65;&#x42;&lt;&bogus;"), "AB<&bogus;");
    }

    #[test]
    fn malformed_input_does_not_panic() {
        for xml in ["<a", "<a><b>", "</a>", "<", "<a x=\"1/>", "<!--", "<?x", "<añ", "<a>ñ</"] {
            let _ = elements(xml);
        }
    }
}
