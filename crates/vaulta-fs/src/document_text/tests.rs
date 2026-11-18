use super::{Format, MAX_DECODED, MAX_INPUT, MAX_OUTPUT};
use flate2::{
    write::{DeflateEncoder, ZlibEncoder},
    Compression,
};
use lopdf::{dictionary, xref::XrefType, Document, Stream};
use rawzip::{CompressionMethod, ZipArchiveWriter};
use std::io::Write;

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const SLIDE: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAW: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";

fn zip(parts: &[(&str, &str)]) -> Vec<u8> {
    let mut archive = ZipArchiveWriter::new(Vec::new());
    for &(name, content) in parts {
        let (mut entry, config) = archive
            .new_file(name)
            .compression_method(CompressionMethod::DEFLATE)
            .start()
            .unwrap();
        let mut writer = config.wrap(DeflateEncoder::new(&mut entry, Compression::fast()));
        writer.write_all(content.as_bytes()).unwrap();
        let (encoder, descriptor) = writer.finish().unwrap();
        encoder.finish().unwrap();
        entry.finish(descriptor).unwrap();
    }
    archive.finish().unwrap()
}

const OPC: &str = "http://schemas.openxmlformats.org/package/2006";
const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MIME: &str = "application/vnd.openxmlformats-officedocument";

fn relationships(targets: &[(&str, &str)]) -> String {
    let mut xml = format!(r#"<Relationships xmlns="{OPC}/relationships">"#);
    for (i, (kind, target)) in targets.iter().enumerate() {
        xml.push_str(&format!(
            r#"<Relationship Id="rId{}" Type="{REL}/{kind}" Target="{target}"/>"#,
            i + 1
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

fn office_package(parts: &[(&str, &str)], types: &[(&str, &str)]) -> Vec<u8> {
    let mut content_types = format!(
        r#"<Types xmlns="{OPC}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>"#
    );
    for &(path, mime) in types {
        content_types.push_str(&format!(
            r#"<Override PartName="/{path}" ContentType="{MIME}.{mime}+xml"/>"#
        ));
    }
    content_types.push_str("</Types>");
    let rels = relationships(&[("officeDocument", types[0].0)]);
    let mut entries = vec![("[Content_Types].xml", content_types.as_str())];
    // Keep the first content part immediately after the manifest for ZIP mutation tests.
    entries.extend_from_slice(parts);
    entries.push(("_rels/.rels", &rels));
    zip(&entries)
}

fn docx(xml: &str) -> Vec<u8> {
    office_package(
        &[("word/document.xml", xml)],
        &[("word/document.xml", "wordprocessingml.document.main")],
    )
}

pub(crate) fn word_fixture() -> Vec<u8> {
    docx(&format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><x:document xmlns:x="{WORD}" xmlns:y="urn:foreign"><x:body><x:p><x:r><x:t>Vault</x:t><y:t>not collected</y:t></x:r><x:r><x:t>a &amp; &#x732B; &lt;script&gt;</x:t></x:r><x:r><x:tab/><x:t><![CDATA[plain]]></x:t></x:r></x:p><x:p><x:r><x:t>Second paragraph</x:t></x:r></x:p></x:body></x:document>"#
    ))
}

pub(crate) fn slide_fixture() -> Vec<u8> {
    let slide = |text| {
        format!(
            r#"<p:sld xmlns:p="{SLIDE}" xmlns:a="{DRAW}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#
        )
    };
    let presentation = format!(
        r#"<p:presentation xmlns:p="{SLIDE}" xmlns:r="{REL}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#
    );
    let rels = relationships(&[
        ("slide", "slides/slide2.xml"),
        ("slide", "slides/slide10.xml"),
    ]);
    office_package(
        &[
            ("ppt/presentation.xml", &presentation),
            ("ppt/_rels/presentation.xml.rels", &rels),
            ("ppt/slides/slide10.xml", &slide("Tenth slide")),
            ("ppt/slides/slide2.xml", &slide("Second slide")),
        ],
        &[
            ("ppt/presentation.xml", "presentationml.presentation.main"),
            ("ppt/slides/slide10.xml", "presentationml.slide"),
            ("ppt/slides/slide2.xml", "presentationml.slide"),
        ],
    )
}

fn workbook(strings: &str, cells: &str) -> Vec<u8> {
    let workbook = format!(
        r#"<workbook xmlns="{SHEET}" xmlns:r="{REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>"#
    );
    let sst = format!(r#"<sst xmlns="{SHEET}">{strings}</sst>"#);
    let sheet = format!(
        r#"<worksheet xmlns="{SHEET}"><sheetData><row r="1">{cells}</row></sheetData></worksheet>"#
    );
    let rels = relationships(&[
        ("worksheet", "worksheets/sheet1.xml"),
        ("sharedStrings", "sharedStrings.xml"),
    ]);
    office_package(
        &[
            ("xl/workbook.xml", &workbook),
            ("xl/_rels/workbook.xml.rels", &rels),
            ("xl/sharedStrings.xml", &sst),
            ("xl/worksheets/sheet1.xml", &sheet),
        ],
        &[
            ("xl/workbook.xml", "spreadsheetml.sheet.main"),
            ("xl/sharedStrings.xml", "spreadsheetml.sharedStrings"),
            ("xl/worksheets/sheet1.xml", "spreadsheetml.worksheet"),
        ],
    )
}

pub(crate) fn workbook_fixture() -> Vec<u8> {
    workbook("<si><r><t xml:space=\"preserve\">Shared </t></r><r><t>label</t></r><rPh sb=\"0\" eb=\"1\"><t>not collected</t></rPh></si><si><t>unused</t></si>",
        r#"<c t="s"><v>0</v></c><c t="inlineStr"><is><t>Inline label</t></is></c><c><f>SUM(40,2)</f><v>42</v></c>"#)
}

fn pdf(streams: &[Vec<u8>], classic: bool) -> Vec<u8> {
    let mut pdf = Document::with_version("1.5");
    if classic {
        pdf.reference_table.cross_reference_type = XrefType::CrossReferenceTable;
    }
    let pages = pdf.new_object_id();
    let font = pdf.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let mut kids = Vec::new();
    for content in streams {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(content).unwrap();
        let stream = Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            encoder.finish().unwrap(),
        );
        let contents = pdf.add_object(stream);
        let page = pdf.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => contents,
        });
        kids.push(page.into());
    }
    pdf.set_object(
        pages,
        dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => streams.len() as i64,
            "Resources" => dictionary! { "Font" => dictionary! {"F1" => font} },
            "MediaBox" => vec![0.into(), 0.into(), 400.into(), 400.into()],
        },
    );
    let root = pdf.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages});
    pdf.trailer.set("Root", root);
    let mut bytes = Vec::new();
    pdf.save_to(&mut bytes).unwrap();
    bytes
}

pub(crate) fn pdf_fixture() -> Vec<u8> {
    pdf(
        &[br"BT /F1 11 Tf 20 30 Td [(Local) -150 (PDF \351vidence)] TJ ET".to_vec()],
        true,
    )
}

#[test]
fn extracts_ooxml_text_in_formatted_runs_and_numeric_part_order() {
    assert_eq!(
        Format::Docx.extract(&word_fixture()).as_deref(),
        Some("Vaulta & 猫 <script>\tplain\nSecond paragraph")
    );
    assert_eq!(
        Format::Pptx.extract(&slide_fixture()).as_deref(),
        Some("Second slide\nTenth slide")
    );
    assert_eq!(
        Format::Xlsx.extract(&workbook_fixture()).as_deref(),
        Some("Shared label\nInline label\n42")
    );
    assert!(Format::Docx.extract(&slide_fixture()).is_none());
}

#[test]
fn rejects_invalid_ooxml_and_unsupported_payloads() {
    for bad in [
        format!(r#"<w:document xmlns:w="{WORD}"><w:t>Visible</w:t>"#),
        format!(
            r#"<!DOCTYPE x SYSTEM "http://invalid.example/dtd"><w:document xmlns:w="{WORD}"><w:t>Visible</w:t></w:document>"#
        ),
        format!(r#"<w:document xmlns:w="{WORD}"><w:t>&unknown;</w:t></w:document>"#),
        format!(r#"<w:document xmlns:w="{WORD}"><w:t>Visible</w:t></w:document><more/>"#),
    ] {
        assert!(Format::Docx.extract(&docx(&bad)).is_none());
    }
    assert!(Format::Xlsx
        .extract(&workbook(
            "<si><t>unused</t></si>",
            r#"<c t="s"><v>5</v></c>"#
        ))
        .is_none());
    assert!(Format::Docx.extract(b"PK\x03\x04bad").is_none());
    let mut bad_crc = word_fixture();
    let entries: Vec<_> = memchr::memmem::find_iter(&bad_crc, b"PK\x01\x02").collect();
    bad_crc[entries[1] + 16] ^= 1;
    assert!(Format::Docx.extract(&bad_crc).is_none());
}

#[test]
fn office_caps_input_output_size_and_decoded_parts() {
    assert!(Format::Docx.extract(&vec![0; MAX_INPUT + 1]).is_none());
    let output = "é".repeat(MAX_OUTPUT / 2 + 1);
    assert!(Format::Docx
        .extract(&docx(&format!(
            r#"<w:document xmlns:w="{WORD}"><w:t>{output}</w:t></w:document>"#
        )))
        .is_none());
    let comment = "a".repeat(2 * 1024 * 1024);
    let part = docx(&format!(
        r#"<w:document xmlns:w="{WORD}"><!--{comment}--><w:t>Visible</w:t></w:document>"#
    ));
    assert!(part.len() < 20_000);
    assert!(Format::Docx.extract(&part).is_none());
    // Lie about the XML size in the central directory; the actual read is still limited.
    let mut forged = part;
    let entries: Vec<_> = memchr::memmem::find_iter(&forged, b"PK\x01\x02").collect();
    forged[entries[1] + 24..entries[1] + 28].copy_from_slice(&32u32.to_le_bytes());
    assert!(Format::Docx.extract(&forged).is_none());
    let comment = "a".repeat(MAX_DECODED / 5);
    let slide = format!(
        r#"<p:sld xmlns:p="{SLIDE}" xmlns:a="{DRAW}"><!--{comment}--><a:t>Visible</a:t></p:sld>"#
    );
    let mut parts = vec![
        ("[Content_Types].xml", "<Types/>"),
        ("ppt/presentation.xml", "<presentation/>"),
    ];
    for name in ["slide1", "slide2", "slide3", "slide4", "slide5"] {
        let path = match name {
            "slide1" => "ppt/slides/slide1.xml",
            "slide2" => "ppt/slides/slide2.xml",
            "slide3" => "ppt/slides/slide3.xml",
            "slide4" => "ppt/slides/slide4.xml",
            _ => "ppt/slides/slide5.xml",
        };
        parts.push((path, &slide));
    }
    assert!(Format::Pptx.extract(&zip(&parts)).is_none());
}

#[test]
fn pdf_extracts_compressed_text_and_refuses_bad_or_oversized_documents() {
    assert_eq!(
        Format::Pdf.extract(&pdf_fixture()).as_deref(),
        Some("Local PDF évidence")
    );
    assert!(Format::Pdf.extract(b"%PDF-1.7\nnot a document").is_none());
    assert!(Format::Pdf
        .extract(&pdf(
            &[b"BT /F1 11 Tf (Not supported) Tj ET".to_vec()],
            false
        ))
        .is_none());
    assert!(Format::Pdf
        .extract(&pdf(&[b"q Q".to_vec()], true))
        .is_none()); // no text
    assert!(Format::Pdf
        .extract(&pdf(&vec![b"q Q".to_vec(); 101], true))
        .is_none());
    let bomb = pdf(&[vec![b' '; 1024 * 1024 + 1]], true);
    assert!(bomb.len() < 20_000);
    assert!(Format::Pdf.extract(&bomb).is_none());
    let mut padded = b"BT /F1 11 Tf (Visible) Tj ET\n".to_vec();
    padded.resize(1024 * 1024 - 1, b' ');
    assert!(Format::Pdf.extract(&pdf(&[padded.clone()], true)).is_some());
    assert!(Format::Pdf.extract(&pdf(&vec![padded; 9], true)).is_none());
    let mut page = b"BT /F1 11 Tf (".to_vec();
    page.extend(std::iter::repeat_n(b'A', MAX_OUTPUT + 1));
    page.extend_from_slice(b") Tj ET");
    assert!(Format::Pdf.extract(&pdf(&[page], true)).is_none());
}
