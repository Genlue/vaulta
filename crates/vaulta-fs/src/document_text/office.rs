use super::{Format, Text, MAX_DECODED};
use flate2::bufread::DeflateDecoder;
use quick_xml::{events::Event, name::ResolveResult, reader::NsReader};
use rawzip::{CompressionMethod, ZipArchive, ZipFileHeaderRecord, ZipSliceArchive};
use std::{borrow::Cow, collections::HashSet, io::Read};

const MAX_ENTRIES: u64 = 2048;
const MAX_PARTS: usize = 128;
const MAX_PART: usize = 2 * 1024 * 1024;
const MAX_XML_DEPTH: usize = 64;
const MAX_SHARED_STRINGS: usize = 32_768;

pub(super) fn extract(format: Format, input: &[u8], out: &mut Text) -> Option<()> {
    if !input.starts_with(b"PK\x03\x04") {
        return None;
    }
    let archive = ZipArchive::from_slice(input).ok()?;
    let count = archive.entries_hint();
    if count > MAX_ENTRIES {
        return None;
    }
    let mut budget = MAX_DECODED;
    let mut names = HashSet::new();
    let mut ranges = Vec::new();
    let mut parts = Vec::new();
    let mut shared = None;
    let mut has_main = false;
    let mut has_content_types = false;
    for (i, entry) in archive.entries().enumerate() {
        if i as u64 >= count {
            return None;
        }
        let entry = entry.ok()?;
        let name = entry.file_path().as_bytes();
        if !names.insert(name) || entry.flags().is_encrypted() {
            return None;
        }
        has_content_types |= name == b"[Content_Types].xml";
        let main = match format {
            Format::Docx => &b"word/document.xml"[..],
            Format::Pptx => b"ppt/presentation.xml",
            Format::Xlsx => b"xl/workbook.xml",
            Format::Pdf => return None,
        };
        has_main |= name == main;
        let part = match format {
            Format::Docx if name == main => Some((0, Part::Word)),
            Format::Pptx => numbered_part(name, b"ppt/slides/slide").map(|n| (n, Part::Slide)),
            Format::Xlsx => numbered_part(name, b"xl/worksheets/sheet").map(|n| (n, Part::Sheet)),
            _ => None,
        };
        let is_shared = matches!(format, Format::Xlsx) && name == b"xl/sharedStrings.xml";
        if part.is_some() || is_shared {
            let local = archive.get_entry(entry.wayfinder()).ok()?;
            let header = local.local_header();
            let (_, end) = local.compressed_data_range();
            if header.flags().is_encrypted()
                || header.file_path().as_bytes() != name
                || end > archive.directory_offset()
            {
                return None;
            }
            ranges.push((entry.local_header_offset(), end));
            if let Some((n, kind)) = part {
                if parts.len() == MAX_PARTS {
                    return None;
                }
                parts.push((n, kind, entry));
            } else {
                shared = Some(entry);
            }
        }
    }
    ranges.sort_unstable();
    if names.len() as u64 != count
        || !has_main
        || !has_content_types
        || parts.is_empty()
        || ranges.windows(2).any(|w| w[0].1 > w[1].0)
    {
        return None;
    }
    let mut strings = Shared::default();
    if let Some(entry) = shared {
        parse_xml(
            &read_part(&archive, &entry, &mut budget)?,
            Part::Shared,
            &mut strings,
            out,
        )?;
    }
    parts.sort_unstable_by_key(|(n, _, _)| *n);
    for (_, kind, entry) in parts {
        parse_xml(
            &read_part(&archive, &entry, &mut budget)?,
            kind,
            &mut strings,
            out,
        )?;
        out.line()?;
    }
    Some(())
}

fn numbered_part(name: &[u8], prefix: &[u8]) -> Option<u32> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(b".xml")?;
    if digits.first() == Some(&b'0') || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

fn read_part(
    archive: &ZipSliceArchive<&[u8]>,
    entry: &ZipFileHeaderRecord<'_>,
    budget: &mut usize,
) -> Option<Vec<u8>> {
    let cap = MAX_PART.min(*budget);
    let declared = usize::try_from(entry.uncompressed_size_hint()).ok()?;
    if declared > cap {
        return None;
    }
    let local = archive.get_entry(entry.wayfinder()).ok()?;
    let data = local.data();
    let mut xml = Vec::new();
    // Read at most cap + 1 even if the advertised size is forged. rawzip also checks CRC.
    match entry.compression_method() {
        CompressionMethod::STORE => local
            .verifying_reader(data)
            .take(cap as u64 + 1)
            .read_to_end(&mut xml),
        CompressionMethod::DEFLATE => local
            .verifying_reader(DeflateDecoder::new(data))
            .take(cap as u64 + 1)
            .read_to_end(&mut xml),
        _ => return None,
    }
    .ok()?;
    if xml.len() != declared {
        return None;
    }
    *budget -= xml.len();
    Some(xml)
}

#[derive(Clone, Copy)]
enum Part {
    Word,
    Slide,
    Sheet,
    Shared,
}

impl Part {
    fn root(self) -> &'static str {
        match self {
            Self::Word => "document",
            Self::Slide => "sld",
            Self::Sheet => "worksheet",
            Self::Shared => "sst",
        }
    }

    fn namespace(self, ns: &str) -> bool {
        match self {
            Self::Word => matches!(
                ns,
                "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
                    | "http://purl.oclc.org/ooxml/wordprocessingml/main"
            ),
            Self::Slide => matches!(
                ns,
                "http://schemas.openxmlformats.org/presentationml/2006/main"
                    | "http://purl.oclc.org/ooxml/presentationml/main"
            ),
            Self::Sheet | Self::Shared => matches!(
                ns,
                "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                    | "http://purl.oclc.org/ooxml/spreadsheetml/main"
            ),
        }
    }
}

#[derive(Default)]
struct Shared {
    data: Text,
    ends: Vec<usize>,
}

impl Shared {
    fn get(&self, index: usize) -> Option<&str> {
        let end = *self.ends.get(index)?;
        let start = if index == 0 { 0 } else { self.ends[index - 1] };
        Some(&self.data.0[start..end])
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tag {
    Other,
    Paragraph,
    Text,
    Item,
    Cell,
    Value,
    Inline,
    Skip,
}

fn parse_xml(xml: &[u8], part: Part, shared: &mut Shared, out: &mut Text) -> Option<()> {
    // OOXML XML is typically UTF-8. Validate once; don't allow lossy decoding.
    let xml = std::str::from_utf8(xml).ok()?;
    let mut reader = NsReader::from_str(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut stack = Vec::new();
    let mut root_seen = false;
    let mut cell_type = None;
    let mut index = String::new();
    loop {
        let (ns, event) = reader.read_resolved_event().ok()?;
        match event {
            Event::Start(element) => {
                let ns = match ns {
                    ResolveResult::Bound(ns) => ns.0,
                    ResolveResult::Unbound => "",
                    ResolveResult::Unknown(_) => return None,
                };
                let local = element.local_name();
                let name = local.as_ref();
                let own = part.namespace(ns);
                if stack.len() == MAX_XML_DEPTH
                    || matches!(stack.last(), Some(Tag::Text | Tag::Value))
                {
                    return None;
                }
                if stack.is_empty() {
                    if root_seen || !own || name != part.root() {
                        return None;
                    }
                    root_seen = true;
                }
                let tag = if stack.last() == Some(&Tag::Skip) {
                    Tag::Skip
                } else if own {
                    match (part, name) {
                        (Part::Word, "p") => Tag::Paragraph,
                        (Part::Word, "t") => Tag::Text,
                        (Part::Word, "tab" | "br" | "cr") => {
                            out.push(if name == "tab" { "\t" } else { "\n" })?;
                            Tag::Other
                        }
                        (Part::Shared, "si") if stack.len() == 1 => Tag::Item,
                        (Part::Sheet, "c") => {
                            if stack.contains(&Tag::Cell) {
                                return None;
                            }
                            cell_type = element
                                .try_get_attribute("t")
                                .ok()?
                                .map(|a| a.value.into_owned());
                            index.clear();
                            Tag::Cell
                        }
                        (Part::Sheet, "is") if stack.last() == Some(&Tag::Cell) => Tag::Inline,
                        (Part::Sheet, "v") if stack.last() == Some(&Tag::Cell) => Tag::Value,
                        (Part::Sheet, "t") if stack.contains(&Tag::Inline) => Tag::Text,
                        (Part::Shared, "t") if stack.contains(&Tag::Item) => Tag::Text,
                        (Part::Sheet | Part::Shared, "rPh") => Tag::Skip,
                        _ => Tag::Other,
                    }
                } else if matches!(part, Part::Slide)
                    && matches!(
                        ns,
                        "http://schemas.openxmlformats.org/drawingml/2006/main"
                            | "http://purl.oclc.org/ooxml/drawingml/main"
                    )
                {
                    match name {
                        "p" => Tag::Paragraph,
                        "t" => Tag::Text,
                        "br" => {
                            out.push("\n")?;
                            Tag::Other
                        }
                        _ => Tag::Other,
                    }
                } else {
                    Tag::Other
                };
                stack.push(tag);
            }
            Event::End(_) => match stack.pop()? {
                Tag::Paragraph | Tag::Cell => out.line()?,
                Tag::Item => {
                    if shared.ends.len() == MAX_SHARED_STRINGS {
                        return None;
                    }
                    shared.ends.push(shared.data.0.len());
                }
                Tag::Value if cell_type.as_deref() == Some("s") => {
                    out.push(shared.get(index.trim().parse().ok()?)?)?;
                }
                _ => {}
            },
            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) => {
                let text = match event {
                    Event::Text(e) => e.xml10_content(),
                    Event::CData(e) => e.xml10_content(),
                    Event::GeneralRef(e) => {
                        let name = e.xml10_content();
                        if let Some(value) = quick_xml::escape::resolve_xml_entity(&name) {
                            Cow::Borrowed(value)
                        } else {
                            Cow::Owned(e.resolve_char_ref().ok()??.to_string())
                        }
                    }
                    _ => unreachable!(),
                };
                match stack.last() {
                    Some(Tag::Text) if matches!(part, Part::Shared) => shared.data.push(&text)?,
                    Some(Tag::Text) => out.push(&text)?,
                    Some(Tag::Value) if cell_type.as_deref() == Some("s") => {
                        if text.len() > 32 - index.len() {
                            return None;
                        }
                        index.push_str(&text);
                    }
                    Some(Tag::Value) => out.push(&text)?,
                    None if !text.trim().is_empty() => return None,
                    _ => {}
                }
            }
            Event::DocType(_) => return None, // No DTDs, entity expansion or external fetches.
            Event::Eof => return (root_seen && stack.is_empty()).then_some(()),
            _ => {}
        }
    }
}
