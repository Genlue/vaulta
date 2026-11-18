//! Best-effort, bounded text extraction. No fallback to raw binary bytes.

mod office;
mod pdf;

pub(super) const MAX_INPUT: usize = 8 * 1024 * 1024;
const MAX_OUTPUT: usize = 512 * 1024;
const MAX_DECODED: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(super) enum Format {
    Pdf,
    Docx,
    Pptx,
    Xlsx,
}

impl Format {
    pub(super) fn from_extension(extension: &str) -> Option<Self> {
        Some(match extension {
            "pdf" => Self::Pdf,
            "docx" => Self::Docx,
            "pptx" => Self::Pptx,
            "xlsx" => Self::Xlsx,
            _ => return None,
        })
    }

    pub(super) fn extract(self, input: &[u8]) -> Option<String> {
        if input.len() > MAX_INPUT {
            return None;
        }
        let mut out = Text::default();
        match self {
            Self::Pdf => pdf::extract(input, &mut out)?,
            _ => office::extract(self, input, &mut out)?,
        }
        let text = out.0.trim();
        (!text.is_empty()).then(|| text.to_owned())
    }
}

#[derive(Default)]
struct Text(String);

impl Text {
    fn push(&mut self, text: &str) -> Option<()> {
        if text.len() > self.remaining() {
            return None;
        }
        // Keep all extracted previews inert, including uncommon controls from fonts/XML.
        self.0.extend(text.chars().map(|c| {
            if c.is_control() && !matches!(c, '\t' | '\n' | '\r') {
                ' '
            } else {
                c
            }
        }));
        Some(())
    }

    fn remaining(&self) -> usize {
        MAX_OUTPUT - self.0.len()
    }

    fn line(&mut self) -> Option<()> {
        if !self.0.is_empty() && !self.0.ends_with('\n') {
            self.push("\n")?;
        }
        Some(())
    }
}

#[cfg(test)]
pub(crate) mod tests;
