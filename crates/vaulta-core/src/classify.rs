//! Extension-based category suggestions.
//!
//! The mapping is deliberately conservative. Only formats we can name with
//! confidence are classified; anything else stays uncategorized so it can wait
//! in the inbox instead of being guessed into the wrong bucket. Contents are
//! never read here, so scanning remains a read-only directory walk.

/// Categories created for every vault, in display order.
///
/// `项目` predates automatic classification and is kept so existing vaults and
/// user habits keep working. The remaining names are the buckets the classifier
/// can suggest.
pub(crate) const CATEGORIES: [&str; 6] = ["文档", "图片", "音视频", "项目", "代码", "压缩包"];

/// Suggest a category for a vault-relative path.
///
/// Returns `None` for directories, dotfiles, extensionless names and formats we
/// do not recognize. The path may use either separator.
pub(crate) fn category_for(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    // A handful of formats are identified by their whole name.
    if matches!(
        lower.as_str(),
        "dockerfile"
            | "containerfile"
            | "makefile"
            | "gnumakefile"
            | "rakefile"
            | "gemfile"
            | "procfile"
            | "jenkinsfile"
            | "vagrantfile"
            | "justfile"
    ) {
        return Some("代码");
    }
    if lower == "cmakelists.txt" {
        return Some("代码");
    }
    // `.gitignore` and friends are configuration, not documents; a leading dot
    // means there is no extension to classify.
    let (stem, ext) = lower.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    let category = match ext {
        // Documents, including the markup and office formats users expect to
        // find under 文档.
        "pdf" | "doc" | "docx" | "docm" | "dot" | "dotx" | "dotm" | "rtf" | "odt" | "ott"
        | "txt" | "text" | "md" | "markdown" | "mdown" | "mkd" | "mdx" | "rst" | "tex" | "bib"
        | "epub" | "mobi" | "azw" | "azw3" | "fb2" | "djvu" | "pages" | "wpd" | "csv" | "tsv"
        | "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" | "numbers" | "ppt" | "pptx" | "pptm"
        | "pps" | "ppsx" | "odp" | "key" | "one" => "文档",
        // Raster and vector images, plus camera raw and design sources.
        "png" | "jpg" | "jpeg" | "jpe" | "jfif" | "gif" | "webp" | "avif" | "bmp" | "dib"
        | "tif" | "tiff" | "heic" | "heif" | "ico" | "cur" | "svg" | "svgz" | "psd" | "psb"
        | "ai" | "eps" | "cdr" | "sketch" | "fig" | "xd" | "raw" | "cr2" | "cr3" | "nef"
        | "arw" | "dng" | "orf" | "rw2" | "raf" | "srw" => "图片",
        // Audio and video share one bucket.
        "mp3" | "wav" | "flac" | "aac" | "m4a" | "ogg" | "oga" | "opus" | "wma" | "aiff"
        | "aif" | "alac" | "ape" | "mid" | "midi" | "mp4" | "m4v" | "mov" | "mkv" | "avi"
        | "webm" | "wmv" | "flv" | "f4v" | "mpeg" | "mpg" | "mpe" | "m2ts" | "mts" | "3gp"
        | "3g2" | "ogv" | "rmvb" | "vob" => "音视频",
        // Source code, markup and configuration.
        "rs" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "py" | "pyw" | "pyi" | "java"
        | "kt" | "kts" | "scala" | "groovy" | "gradle" | "c" | "h" | "cc" | "cpp" | "cxx"
        | "hpp" | "hh" | "hxx" | "cs" | "go" | "rb" | "php" | "swift" | "m" | "mm" | "sh"
        | "bash" | "zsh" | "fish" | "ps1" | "psm1" | "bat" | "cmd" | "sql" | "html" | "htm"
        | "xhtml" | "css" | "scss" | "sass" | "less" | "styl" | "json" | "jsonc" | "json5"
        | "yaml" | "yml" | "toml" | "xml" | "xsl" | "xslt" | "ini" | "cfg" | "conf" | "env"
        | "properties" | "cmake" | "mk" | "lua" | "dart" | "vue" | "svelte" | "astro" | "zig"
        | "hs" | "lhs" | "ex" | "exs" | "erl" | "hrl" | "clj" | "cljs" | "cljc" | "fs" | "fsx"
        | "ml" | "mli" | "r" | "jl" | "pl" | "pm" | "vb" | "vbs" | "asm" | "s" | "sol"
        | "proto" | "graphql" | "gql" => "代码",
        // Archives and disk images.
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "tbz2" | "xz" | "txz" | "zst"
        | "tzst" | "lz" | "lzma" | "cab" | "iso" | "img" | "dmg" | "vhd" | "vhdx" | "wim"
        | "arj" | "lzh" | "z" | "sfx" => "压缩包",
        _ => return None,
    };
    Some(category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_the_formats_users_expect() {
        assert_eq!(category_for("笔记/计划.md"), Some("文档"));
        assert_eq!(category_for("reports/q3.DOCX"), Some("文档"));
        assert_eq!(category_for("a/b.pdf"), Some("文档"));
        assert_eq!(category_for("镜头/封面.PNG"), Some("图片"));
        assert_eq!(category_for("照片/DSC_01.cr2"), Some("图片"));
        assert_eq!(category_for("录音/备忘.flac"), Some("音视频"));
        assert_eq!(category_for("剪辑/成片.MP4"), Some("音视频"));
        assert_eq!(category_for("src/main.rs"), Some("代码"));
        assert_eq!(category_for("Dockerfile"), Some("代码"));
        assert_eq!(category_for("backup/2026.tar.gz"), Some("压缩包"));
    }

    #[test]
    fn leaves_ambiguous_names_uncategorized() {
        assert_eq!(category_for("README"), None);
        assert_eq!(category_for(".gitignore"), None);
        assert_eq!(category_for("data.bin"), None);
        assert_eq!(category_for("folder/"), None);
        assert_eq!(category_for(""), None);
    }

    #[test]
    fn accepts_both_separators() {
        assert_eq!(category_for(r"设计\封面.jpg"), Some("图片"));
        assert_eq!(category_for("设计/封面.jpg"), Some("图片"));
    }
}
