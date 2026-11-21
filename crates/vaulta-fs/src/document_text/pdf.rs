use super::{Text, MAX_DECODED};
use flate2::bufread::ZlibDecoder;
use lopdf::{content::Content, Dictionary, Document, Encoding, LoadOptions, Object, Stream};
use memchr::memmem;
use std::{
    collections::{BTreeMap, HashSet},
    io::Read,
};

const MAX_PAGE: usize = 1024 * 1024;
const MAX_PAGES: usize = 100;
const MAX_OBJECTS: usize = 16_384;
const MAX_OPS: usize = 250_000;
const MAX_PAGE_FONTS: usize = 128;

pub(super) fn extract(input: &[u8], out: &mut Text) -> Option<()> {
    check_structure(input)?;
    let doc = Document::load_mem_with_options(
        input,
        LoadOptions {
            strict: true,
            max_decompressed_size: Some(MAX_PAGE),
            ..Default::default()
        },
    )
    .ok()?;
    let mut remaining = MAX_DECODED;
    let mut encoded_remaining = super::MAX_INPUT;
    let mut operations = MAX_OPS;
    let mut seen = HashSet::new();
    let mut data = Vec::new();
    let mut font_cache = std::collections::HashMap::<lopdf::ObjectId, Option<Encoding<'_>>>::new();
    for (n, id) in doc.page_iter().enumerate() {
        if n == MAX_PAGES || !seen.insert(id) {
            return None;
        }
        let page = doc.get_dictionary(id).ok()?;
        if !page.has(b"Contents") {
            continue;
        }
        let contents = page.get_deref(b"Contents", &doc).ok()?;
        data.clear();
        let mut append = |obj: &Object| -> Option<()> {
            let stream = doc.dereference(obj).ok()?.1.as_stream().ok()?;
            // Charge reused streams each time, including their encoded bytes, so references
            // cannot multiply decoding work beyond the document budget.
            encoded_remaining = encoded_remaining.checked_sub(stream.content.len())?;
            let cap = remaining.min(MAX_PAGE - data.len()).checked_sub(1)?;
            let before = data.len();
            append_stream(stream, cap, &mut data)?;
            remaining -= data.len() - before + 1;
            data.push(b'\n');
            Some(())
        };
        match contents {
            Object::Array(streams) => {
                for s in streams {
                    append(s)?;
                }
            }
            Object::Null => continue,
            s => append(s)?,
        }
        let fonts = page_fonts(page, &doc)?;
        enum FontSlot<'a> {
            Cached(lopdf::ObjectId),
            Inline(&'a [u8]),
        }
        let mut page_slots: BTreeMap<&[u8], Option<FontSlot<'_>>> = BTreeMap::new();
        let mut inline_encodings: BTreeMap<&[u8], Option<Encoding<'_>>> = BTreeMap::new();
        let mut current: Option<FontSlot<'_>> = None;
        let mut in_text = false;
        for op in Content::decode_iter(&data) {
            operations = operations.checked_sub(1)?;
            let op = op.ok()?;
            match op.operator.as_str() {
                "BT" => {
                    in_text = true;
                    out.line()?;
                }
                "ET" => {
                    in_text = false;
                    out.line()?;
                }
                "Tf" if in_text => {
                    let name = op.operands.first()?.as_name().ok()?;
                    current = None;
                    if let Some(slot) = page_slots.get(name) {
                        current = match slot {
                            Some(FontSlot::Cached(id)) => Some(FontSlot::Cached(*id)),
                            Some(FontSlot::Inline(k)) => Some(FontSlot::Inline(*k)),
                            None => None,
                        };
                    } else if let Some((key, font)) =
                        fonts.and_then(|fonts| fonts.iter().find(|(key, _)| key.as_slice() == name))
                    {
                        if page_slots.len() == MAX_PAGE_FONTS {
                            return None;
                        }
                        let slot = match font {
                            Object::Reference(font_id) => {
                                if !font_cache.contains_key(font_id) {
                                    let enc = doc
                                        .dereference(font)
                                        .ok()?
                                        .1
                                        .as_dict()
                                        .ok()
                                        .and_then(|d| basic_encoding(d, &doc));
                                    font_cache.insert(*font_id, enc);
                                }
                                Some(FontSlot::Cached(*font_id))
                            }
                            _ => {
                                let enc = doc
                                    .dereference(font)
                                    .ok()?
                                    .1
                                    .as_dict()
                                    .ok()
                                    .and_then(|d| basic_encoding(d, &doc));
                                inline_encodings.insert(key.as_slice(), enc);
                                Some(FontSlot::Inline(key.as_slice()))
                            }
                        };
                        current = match &slot {
                            Some(FontSlot::Cached(id)) => Some(FontSlot::Cached(*id)),
                            Some(FontSlot::Inline(k)) => Some(FontSlot::Inline(*k)),
                            None => None,
                        };
                        page_slots.insert(key.as_slice(), slot);
                    }
                }
                "T*" | "Td" | "TD" if in_text => out.line()?,
                "Tj" | "TJ" | "'" | "\"" if in_text => {
                    let Some(encoding) = (match &current {
                        Some(FontSlot::Cached(id)) => font_cache.get(id).and_then(Option::as_ref),
                        Some(FontSlot::Inline(k)) => {
                            inline_encodings.get(k).and_then(Option::as_ref)
                        }
                        None => None,
                    }) else {
                        continue;
                    };
                    if matches!(op.operator.as_str(), "'" | "\"") {
                        out.line()?;
                    }
                    let value = op.operands.last()?;
                    match value {
                        Object::Array(items) if op.operator == "TJ" => {
                            for item in items {
                                match item {
                                    Object::String(bytes, _) => append_text(encoding, bytes, out)?,
                                    Object::Integer(i) if *i < -100 => out.push(" ")?,
                                    Object::Real(i) if *i < -100.0 => out.push(" ")?,
                                    Object::Integer(_) | Object::Real(_) => {}
                                    _ => return None,
                                }
                            }
                        }
                        Object::String(bytes, _) => append_text(encoding, bytes, out)?,
                        _ => return None,
                    }
                }
                _ => {} // No interpretation of images, XObjects, annotations or actions.
            }
        }
        out.line()?;
    }
    Some(())
}

fn append_stream(stream: &Stream, cap: usize, data: &mut Vec<u8>) -> Option<()> {
    // Page content only. Use a limited zlib reader rather than decoding arbitrary PDF
    // filter chains or invoking predictors intended for image data.
    if stream.dict.has(b"F") || stream.dict.has(b"DecodeParms") {
        return None;
    }
    if let Ok(filter) = stream.dict.get(b"Filter") {
        let name = match filter {
            Object::Array(filters) if filters.len() == 1 => filters[0].as_name().ok()?,
            filter => filter.as_name().ok()?,
        };
        if name != b"FlateDecode" {
            return None;
        }
        let mut decoder = ZlibDecoder::new(stream.content.as_slice());
        let before = data.len();
        (&mut decoder).take(cap as u64 + 1).read_to_end(data).ok()?;
        if data.len() - before > cap || !decoder.get_ref().is_empty() {
            return None;
        }
    } else {
        if stream.content.len() > cap {
            return None;
        }
        data.extend_from_slice(&stream.content);
    }
    Some(())
}

fn page_fonts<'a>(mut page: &'a Dictionary, doc: &'a Document) -> Option<Option<&'a Dictionary>> {
    // Use only the nearest Resources value (the entire dictionary is inherited).
    for _ in 0..64 {
        if page.has(b"Resources") {
            let resources = page.get_deref(b"Resources", doc).ok()?.as_dict().ok()?;
            return if resources.has(b"Font") {
                let fonts = resources.get_deref(b"Font", doc).ok()?.as_dict().ok()?;
                (fonts.len() <= MAX_PAGE_FONTS).then_some(Some(fonts))
            } else {
                Some(None)
            };
        }
        match page.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => page = doc.get_dictionary(parent).ok()?,
            Err(_) => return Some(None),
        }
    }
    None
}

fn append_text(encoding: &Encoding<'_>, bytes: &[u8], out: &mut Text) -> Option<()> {
    // Only single-byte encodings reach here (no CMap expansion); even the temporary
    // decoded run is bounded by the page budget and at most four UTF-8 bytes per byte.
    out.push(&encoding.bytes_to_string(bytes).ok()?)
}

fn basic_encoding<'a>(font: &'a Dictionary, doc: &'a Document) -> Option<Encoding<'a>> {
    if !matches!(
        font.get(b"Subtype").ok()?.as_name().ok()?,
        b"Type1" | b"MMType1" | b"TrueType"
    ) {
        return None;
    }
    let safe_base = |name: &[u8]| {
        matches!(
            name,
            b"StandardEncoding"
                | b"WinAnsiEncoding"
                | b"MacRomanEncoding"
                | b"MacExpertEncoding"
                | b"PDFDocEncoding"
        )
    };
    // Do not let lopdf construct ToUnicode reverse maps: even a tiny map can
    // describe billions of mappings. This pass handles basic single-byte fonts.
    match font.get(b"Encoding") {
        Ok(encoding) => match doc.dereference(encoding).ok()?.1 {
            Object::Name(name) if safe_base(name) => {}
            Object::Dictionary(dict) => {
                if let Ok(base) = dict.get(b"BaseEncoding") {
                    if !safe_base(base.as_name().ok()?) {
                        return None;
                    }
                }
                if let Ok(differences) = dict.get(b"Differences") {
                    if differences.as_array().ok()?.len() > 512 {
                        return None;
                    }
                }
            }
            _ => return None,
        },
        Err(_) if font.has(b"ToUnicode") => return None,
        Err(_) => {}
    }
    font.get_font_encoding_with_limit(doc, 0).ok()
}

fn space(byte: u8) -> bool {
    matches!(byte, 0 | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn words(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    bytes.split(|b| space(*b)).filter(|s| !s.is_empty())
}

fn number<T: std::str::FromStr>(bytes: &[u8]) -> Option<T> {
    if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(bytes).ok()?.parse().ok()
}

/// Restrict eager loading to one classic xref and well-bounded, non-recursive stream lengths.
/// lopdf still parses and loads the PDF; this is a conservative format gate, not xref recovery.
fn check_structure(input: &[u8]) -> Option<()> {
    if !input.starts_with(b"%PDF-") {
        return None;
    }
    let end = input.iter().rposition(|&b| !space(b))? + 1;
    let footer = input[..end].strip_suffix(b"%%EOF")?;
    let start = memmem::rfind(&footer[footer.len().saturating_sub(24)..], b"startxref")?
        + footer.len().saturating_sub(24);
    let mut offset = words(&footer[start + b"startxref".len()..]);
    let xref: usize = number(offset.next()?)?;
    if offset.next().is_some() || xref >= start {
        return None;
    }
    let table = input.get(xref..start)?.strip_prefix(b"xref")?;
    let at = memmem::find(table, b"trailer")?;
    let trailer = dictionary_operand(trim_space(&table[at + b"trailer".len()..]))?;
    if !trailer.has(b"Root")
        || [b"Prev".as_slice(), b"XRefStm", b"Encrypt"]
            .iter()
            .any(|key| trailer.has(key))
    {
        return None;
    }
    // Validate ranges before giving them to the eager loader. In particular don't
    // let repeated or overlapping xref entries turn one stream into many copies.
    let mut rows = lines(&table[..at]);
    if !trim_space(rows.next()?).is_empty() {
        return None;
    }
    let mut objects = BTreeMap::new();
    let mut entries = 0;
    let mut ids = HashSet::new();
    while let Some(line) = rows.next() {
        if line.is_empty() && rows.clone().next().is_none() {
            break;
        }
        let mut fields = words(line);
        let first: u32 = number(fields.next()?)?;
        let count: usize = number(fields.next()?)?;
        if fields.next().is_some() || count == 0 || count > MAX_OBJECTS - entries {
            return None;
        }
        entries += count;
        for i in 0..count {
            let line = rows.next()?;
            let mut fields = words(line);
            let pos: usize = number(fields.next()?)?;
            let generation: u16 = number(fields.next()?)?;
            let state = fields.next()?;
            let id = first.checked_add(i as u32)?;
            if fields.next().is_some() || !ids.insert(id) {
                return None;
            }
            match state {
                b"f" => {}
                b"n" if pos > 0 && pos < xref && id < u32::MAX => {
                    if objects.insert(pos, (id, generation)).is_some() {
                        return None;
                    }
                }
                _ => return None,
            }
        }
    }
    let first = *objects.keys().next()?;
    if lines(&input[..first])
        .skip(1)
        .map(trim_space)
        .any(|line| !line.is_empty() && !line.starts_with(b"%"))
    {
        return None;
    }
    let mut objects = objects.into_iter().peekable();
    while let Some((pos, (id, generation))) = objects.next() {
        let end = objects.peek().map_or(xref, |&(p, _)| p);
        let object = &input[pos..end];
        let mut tokens = words(object);
        let a = tokens.next()?;
        let b = tokens.next()?;
        let keyword = tokens.next()?;
        if !object.starts_with(a)
            || number::<u32>(a)? != id
            || number::<u16>(b)? != generation
            || keyword != b"obj"
        {
            return None;
        }
        let body_start = keyword.as_ptr() as usize - object.as_ptr() as usize + 3;
        let body = trim_space(trim_space(&object[body_start..]).strip_suffix(b"endobj")?);
        check_object_body(body)?;
    }
    Some(())
}

fn trim_space(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|&b| !space(b)).unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&b| !space(b))
        .map_or(start, |i| i + 1);
    &bytes[start..end]
}

fn lines(bytes: &[u8]) -> impl Iterator<Item = &[u8]> + Clone {
    let mut remaining = bytes;
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let Some(at) = memchr::memchr2(b'\r', b'\n', remaining) else {
            return Some(std::mem::take(&mut remaining));
        };
        let line = &remaining[..at];
        let two = usize::from(remaining[at..].starts_with(b"\r\n"));
        remaining = &remaining[at + 1 + two..];
        Some(line)
    })
}

fn dictionary_operand(bytes: &[u8]) -> Option<Dictionary> {
    if bytes.len() > 64 * 1024 || !bytes.starts_with(b"<<") || !bytes.ends_with(b">>") {
        return None;
    }
    let mut data = bytes.to_vec();
    // Keep the sentinel on the same line: it must not escape an unterminated comment.
    data.extend_from_slice(b" q");
    match single_operand(&data)? {
        Object::Dictionary(dict) => Some(dict),
        _ => None,
    }
}

fn single_operand(data: &[u8]) -> Option<Object> {
    let mut operations = Content::decode_strict(data).ok()?.operations.into_iter();
    let op = operations.next()?;
    if op.operator != "q" || operations.next().is_some() || op.operands.len() != 1 {
        return None;
    }
    op.operands.into_iter().next()
}

fn check_object_body(body: &[u8]) -> Option<()> {
    if !body.starts_with(b"<<") {
        // lopdf reads objects from their offset through the end of the whole file.
        // Verify non-stream operands end inside their own xref range too. The array
        // uses the direct-object grammar (including indirect references).
        if body.is_empty() || body.len() > 64 * 1024 || body.starts_with(b"%") {
            return None;
        }
        let mut data = Vec::with_capacity(body.len() + 5);
        data.push(b'[');
        data.extend_from_slice(body);
        data.extend_from_slice(b"\n] q");
        return match single_operand(&data)? {
            Object::Array(items) if items.len() == 1 => Some(()),
            _ => None,
        };
    }
    // Locate and validate the stream boundary before lopdf resolves /Length. Direct
    // lengths are required here: the eager reader follows indirect length objects.
    // Try only a tight dictionary prefix; the stream body is never scanned as PDF.
    let prefix = &body[..body.len().min(64 * 1024)];
    let markers = memmem::find_iter(prefix, b"stream").filter(|&p| {
        p > 0
            && (space(prefix[p - 1]) || prefix[p - 1] == b'>')
            && prefix.get(p + 6).is_some_and(|&b| space(b))
    });
    for (i, p) in markers.enumerate() {
        if i == 16 {
            return None;
        }
        let Some(dict) = dictionary_operand(trim_space(&prefix[..p])) else {
            continue;
        };
        if dict.has_type(b"ObjStm") || dict.has_type(b"XRef") {
            return None; // Never let the eager loader decompress container streams.
        }
        let size = usize::try_from(dict.get(b"Length").ok()?.as_i64().ok()?).ok()?;
        let rest = &body[p + 6..];
        let eol = rest.iter().position(|b| !matches!(b, b' ' | b'\t'))?;
        let rest = strip_eol(&rest[eol..])?;
        let end = rest.get(size..)?;
        let after = strip_eol(end).unwrap_or(end).strip_prefix(b"endstream")?;
        return trim_space(after).is_empty().then_some(());
    }
    // No stream found. A dictionary must consume the whole body, so a hidden
    // stream beyond the prefix or a malformed stream cannot reach the loader.
    dictionary_operand(body).map(|_| ())
}

fn strip_eol(bytes: &[u8]) -> Option<&[u8]> {
    bytes
        .strip_prefix(b"\r\n")
        .or_else(|| bytes.strip_prefix(b"\n"))
        .or_else(|| bytes.strip_prefix(b"\r"))
}
