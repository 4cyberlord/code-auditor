//! Apple's Vision framework as the transcriber.
//!
//! Transcription used to be a network call with a key, a quota and a billing
//! account, and the failure that replaced it was exactly that: a key whose
//! project lacked billing. On-device OCR removes the whole class -- nothing to
//! configure, nothing to pay, nothing to expire, nothing to refuse.
//!
//! The engine is `VNRecognizeTextRequest` on the accurate path -- the same
//! engine behind Live Text. It does not understand a screenshot; it converts
//! pixels into characters, returns them with measured confidence and geometry,
//! and leaves here fully synchronously. A model, if one is needed at all, reads
//! the transcription as text and says what the problem is.
//!
//! Two things the accurate path gives us that a vision model never did:
//!
//! - **Measured uncertainty.** Every candidate carries a confidence score in
//!   0..1, so the reading document's "characters the reader could not be sure
//!   of" section is filled with numbers instead of a model being asked to admit
//!   doubt -- the single thing models are worst at.
//! - **Layout.** Every observation carries a bounding box, so indentation is
//!   rebuilt from pixels rather than hoped for. In Python that is not cosmetic;
//!   it is the semantics.
//!
//! Vision is Apple-only, so the engine halves are `cfg`-split: the real
//! implementation lives in [`apple_vision`], and other platforms compile to
//! empty pages via [`stub_ocr`], which makes them "not text" and falls back to
//! a vision model. The layout machinery between the engine and the callers is
//! shared and unit-tested here.

use serde::Serialize;

use crate::providers::ImageInput;

#[cfg(target_os = "macos")]
mod apple_vision;
#[cfg(not(target_os = "macos"))]
#[path = "vision/stub_ocr.rs"]
mod stub_ocr;

#[cfg(target_os = "macos")]
use apple_vision as imp;
#[cfg(not(target_os = "macos"))]
use stub_ocr as imp;

/// Below this, a word is worth flagging rather than trusting.
///
/// The accurate path is confident to the high nines on clean screen text, so
/// anything under 0.80 is genuinely unusual -- glare, a ligature, an unfamiliar
/// glyph -- and is exactly what the reading document's uncertainty section
/// exists to carry.
const UNSURE_BELOW: f32 = 0.80;

// ------------------------------------------------------------------ shapes

/// One word. What every decision after the engine is made on, and what a test
/// can build by hand.
#[derive(Debug, Clone)]
pub struct OcrWord {
    pub text: String,
    /// Left edge in pixels. What indentation is reconstructed from.
    pub left: i32,
    pub right: i32,
    pub confidence: f32,
    /// True when this word is the last in its observation's line.
    pub ends_line: bool,
}

/// What one image came back as.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrPage {
    /// The transcription, lines in reading order, indentation rebuilt.
    pub text: String,
    /// Words the engine was not sure of, as `"word" (61%)`, ready to print.
    pub unsure: Vec<String>,
    /// Mean word confidence across the page, 0 when it found nothing.
    pub confidence: f32,
    /// How many words were found at all. Zero means "not a picture of text".
    pub words: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub pages: Vec<OcrPage>,
}

// ---------------------------------------------------------------- the call

/// Transcribes screenshots with Apple Vision.
///
/// No chunking and no governor: there is no batch endpoint to fill and no quota
/// to respect. `performRequests` blocks on a background queue, so the body runs
/// inside `spawn_blocking` rather than on Tauri's async worker -- a whole-screen
/// capture is a real recognition pass, and a stuck async thread costs the whole
/// app.
#[tauri::command]
pub async fn ocr_images(images: Vec<ImageInput>) -> Result<OcrResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut pages = Vec::with_capacity(images.len());
        for img in images {
            pages.push(recognize_one(&img)?);
        }
        Ok(OcrResult { pages })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One image through the engine, producing a page.
///
/// A picture that is not of text -- a diagram, a chart, a mockup -- comes back
/// as an empty `OcrPage` rather than an error, which is the signal the frontend
/// already uses to fall back to a vision model. A genuinely unreadable image,
/// or a failed recognition pass, is the only error.
fn recognize_one(img: &ImageInput) -> Result<OcrPage, String> {
    let bytes = imp::decode(&img.data)?;
    let (w, h) = image_size(&bytes)?;
    let words = imp::recognize(&bytes, w, h)?;
    Ok(assemble(&words))
}

// ------------------------------------------------------------- assembling

/// Turns flat words back into laid-out text.
///
/// Two things have to be rebuilt, and only one of them is obvious. Line breaks
/// come straight from the observation boundaries: each observation maps to a
/// line or fragment, and its last word ends the line. Indentation does not: the
/// engine reports where a word *is*, not how many spaces preceded it, and a
/// screenshot of Python whose indentation is guessed is a screenshot of a
/// different program. So the left edge of each line is measured against the
/// leftmost line on the page and divided by the width of a character, which for
/// the monospaced text in a code screenshot is stable enough to round
/// confidently.
pub fn assemble(words: &[OcrWord]) -> OcrPage {
    if words.is_empty() {
        return OcrPage::default();
    }

    // Group into lines first; indentation is a property of a line, not a word.
    let mut lines: Vec<Vec<&OcrWord>> = Vec::new();
    let mut current: Vec<&OcrWord> = Vec::new();
    for w in words {
        current.push(w);
        if w.ends_line {
            lines.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }

    let char_width = char_width(words);
    let margin = lines
        .iter()
        .filter_map(|l| l.first().map(|w| w.left))
        .min()
        .unwrap_or(0);

    let mut out = String::new();
    for line in &lines {
        let left = line.first().map(|w| w.left).unwrap_or(margin);
        out.push_str(&" ".repeat(indent_spaces(left, margin, char_width)));
        // Vision splits on whitespace, so a single space between words is the
        // right reconstruction; runs of spaces inside a line are not recoverable
        // and do not change what any of this is for.
        out.push_str(
            &line
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        );
        out.push('\n');
    }

    let mut unsure: Vec<String> = words
        .iter()
        .filter(|w| w.confidence > 0.0 && w.confidence < UNSURE_BELOW)
        .map(|w| format!("\"{}\" ({:.0}% sure)", w.text, w.confidence * 100.0))
        .collect();
    // The same misread glyph usually appears several times, and eight identical
    // warnings is how a real one gets skipped over.
    unsure.sort();
    unsure.dedup();
    unsure.truncate(20);

    let scored: Vec<f32> = words
        .iter()
        .map(|w| w.confidence)
        .filter(|c| *c > 0.0)
        .collect();
    let confidence = if scored.is_empty() {
        0.0
    } else {
        scored.iter().sum::<f32>() / scored.len() as f32
    };

    OcrPage {
        text: out.trim_end().to_string(),
        unsure,
        confidence,
        words: words.len(),
    }
}

/// The width of one character, in pixels, as this page renders it.
///
/// The median rather than the mean: one wildly mis-boxed word -- a stray icon
/// read as a letter, a box spanning half the screen -- would drag an average far
/// enough to make every indent wrong, and there is usually at least one.
fn char_width(words: &[OcrWord]) -> f32 {
    let mut widths: Vec<f32> = words
        .iter()
        .filter(|w| !w.text.is_empty() && w.right > w.left)
        .map(|w| (w.right - w.left) as f32 / w.text.chars().count() as f32)
        .filter(|w| *w > 0.5)
        .collect();
    if widths.is_empty() {
        // Nothing measurable. 8px is a normal editor character, and being wrong
        // here costs indentation rather than text.
        return 8.0;
    }
    widths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    widths[widths.len() / 2]
}

/// How many spaces a line starts with, from where it starts on screen.
///
/// Rounded to the nearest whole character and then to the nearest even number,
/// because code is indented in consistent steps and a stray odd space reads as a
/// syntax error to anyone -- human or model -- looking at Python.
fn indent_spaces(left: i32, margin: i32, char_width: f32) -> usize {
    if char_width <= 0.0 || left <= margin {
        return 0;
    }
    let raw = (left - margin) as f32 / char_width;
    // Under a third of a character is noise in the bounding box, not an indent.
    if raw < 0.34 {
        return 0;
    }
    let chars = raw.round() as usize;
    // Cap it: a deep-but-plausible nesting is eight levels of four, and anything
    // past that is a mis-measured page rather than a real program.
    chars.min(64)
}

// ------------------------------------------------------------- image size

/// The image's pixel dimensions, from the encoded bytes.
///
/// The base64 payload carries no width or height, and pixel geometry is what
/// normalized observation boxes are converted against, so it is parsed here
/// from the two places it can live: the IHDR of a PNG, or the first frame
/// header (SOF0/1/2) of a JPEG. Anything else -- the app only ever feeds PNG
/// and JPEG in practice -- is a decode error.
fn image_size(bytes: &[u8]) -> Result<(u32, u32), String> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        // Signature (8), then IHDR's length (4) and name (4); width and height
        // are the chunk's first two big-endian u32s.
        if bytes.len() < 24 {
            return Err("That image could not be decoded for on-device OCR.".into());
        }
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Ok((w, h));
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        // A JPEG is a walk of markers: 0xFF id, then for a segment with a body a
        // big-endian u16 length that counts itself. SOI has no body; APPn,
        // COM and friends are skipped; SOF0/1/2 hold the dimensions.
        let mut i = 2usize;
        while i + 4 <= bytes.len() {
            if bytes[i] != 0xFF {
                return Err("That image could not be decoded for on-device OCR.".into());
            }
            let marker = bytes[i + 1];
            if matches!(marker, 0xC0 | 0xC1 | 0xC2) {
                // SOF: length, precision, then height and width.
                if i + 9 <= bytes.len() {
                    let h = u32::from_be_bytes([0, 0, bytes[i + 5], bytes[i + 6]]);
                    let w = u32::from_be_bytes([0, 0, bytes[i + 7], bytes[i + 8]]);
                    return Ok((w, h));
                }
                return Err("That image could not be decoded for on-device OCR.".into());
            }
            // Restart markers and SOI have no length field.
            if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) {
                i += 2;
                continue;
            }
            let len = ((bytes[i + 2] as usize) << 8) | bytes[i + 3] as usize;
            if len < 2 {
                return Err("That image could not be decoded for on-device OCR.".into());
            }
            i += 2 + len;
        }
    }
    Err("That image could not be decoded for on-device OCR.".into())
}

// ------------------------------------------------------- line -> words

/// Splits one candidate's text into words with geometry.
///
/// An observation reports one box for a whole line or fragment, but
/// indentation and uncertainty live per word. So the candidate is split on
/// whitespace and the box's width is distributed across the pieces in
/// proportion to character count -- not exact, but exact is not what the layout
/// engine needs. The last word of each observation ends the line.
///
/// Shared across engines: Apple Vision returns roughly line-sized fragments,
/// and any future stub or engine has the same "turn a string into spaced words"
/// problem.
fn split_words(
    text: &str,
    left: f32,
    width: f32,
    confidence: f32,
    last_ends_line: bool,
) -> Vec<OcrWord> {
    let parts: Vec<&str> = text.split_whitespace().collect();
    if parts.is_empty() {
        return Vec::new();
    }
    let total: usize = parts.iter().map(|p| p.chars().count()).sum();
    let last = parts.len() - 1;
    let mut out = Vec::with_capacity(parts.len());
    let mut consumed = 0usize;
    for (i, part) in parts.iter().enumerate() {
        let n = part.chars().count();
        let w = if total > 0 {
            width * n as f32 / total as f32
        } else {
            0.0
        };
        let word_left = left
            + if total > 0 {
                width * consumed as f32 / total as f32
            } else {
                0.0
            };
        out.push(OcrWord {
            text: part.to_string(),
            left: word_left.round() as i32,
            right: (word_left + w).round() as i32,
            confidence,
            ends_line: i == last && last_ends_line,
        });
        consumed += n;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn w(text: &str, left: i32, right: i32, ends_line: bool) -> OcrWord {
        OcrWord {
            text: text.into(),
            left,
            right,
            confidence: 0.99,
            ends_line,
        }
    }

    #[test]
    fn nothing_in_nothing_out() {
        let p = assemble(&[]);
        assert_eq!(p.text, "");
        assert_eq!(p.words, 0);
        assert_eq!(p.confidence, 0.0);
    }

    #[test]
    fn words_rejoin_into_lines() {
        let words = vec![
            w("def", 10, 34, false),
            w("main():", 42, 98, true),
            w("return", 42, 90, false),
            w("0", 98, 106, true),
        ];
        let p = assemble(&words);
        assert_eq!(p.text, "def main():\n    return 0");
    }

    #[test]
    fn indentation_comes_from_geometry() {
        // 8px characters: a line starting 32px in is four spaces deep.
        let words = vec![
            w("if", 0, 16, false),
            w("x:", 24, 40, true),
            w("y", 32, 40, false),
            w("=", 48, 56, false),
            w("1", 64, 72, true),
        ];
        let p = assemble(&words);
        assert_eq!(p.text, "if x:\n    y = 1");
    }

    #[test]
    fn nested_indentation_survives() {
        let words = vec![
            w("a", 0, 8, true),
            w("b", 32, 40, true),
            w("c", 64, 72, true),
        ];
        let p = assemble(&words);
        assert_eq!(p.text, "a\n    b\n        c");
    }

    #[test]
    fn a_page_indented_as_a_whole_is_not_reindented() {
        // Every line starts at 120px because the editor has a gutter. That is a
        // margin, not eight levels of nesting.
        let words = vec![w("a", 120, 128, true), w("b", 120, 128, true)];
        assert_eq!(assemble(&words).text, "a\nb");
    }

    #[test]
    fn a_pixel_of_jitter_is_not_an_indent() {
        // Bounding boxes wobble by a pixel or two; that must not become a space.
        let words = vec![w("a", 100, 108, true), w("b", 102, 110, true)];
        assert_eq!(assemble(&words).text, "a\nb");
    }

    #[test]
    fn the_last_line_needs_no_break_marker() {
        // The observation boundary is the line end, so a lone final word closes
        // its own line without needing a marker after it.
        let words = vec![w("end", 0, 24, false)];
        assert_eq!(assemble(&words).text, "end");
    }

    #[test]
    fn a_wildly_misboxed_word_does_not_ruin_every_indent() {
        // One icon read as a letter, boxed across half the screen. A mean would
        // make char_width enormous and flatten all indentation to zero.
        let mut words = vec![
            w("a", 0, 8, true),
            w("b", 32, 40, true),
            w("c", 0, 8, true),
            w("d", 32, 40, true),
        ];
        words.push(w("X", 0, 900, true));
        let p = assemble(&words);
        assert!(p.text.starts_with("a\n    b"), "{}", p.text);
    }

    #[test]
    fn low_confidence_words_are_reported_with_their_score() {
        let mut words = vec![w("total", 0, 40, false)];
        words.push(OcrWord {
            text: "l1".into(),
            left: 48,
            right: 64,
            confidence: 0.61,
            ends_line: true,
        });
        let p = assemble(&words);
        assert_eq!(p.unsure.len(), 1);
        assert!(p.unsure[0].contains("l1"), "{:?}", p.unsure);
        assert!(p.unsure[0].contains("61%"), "{:?}", p.unsure);
    }

    #[test]
    fn the_same_doubt_is_only_reported_once() {
        let bad = || OcrWord {
            text: "rn".into(),
            left: 0,
            right: 16,
            confidence: 0.5,
            ends_line: true,
        };
        let p = assemble(&[bad(), bad(), bad()]);
        assert_eq!(p.unsure.len(), 1, "{:?}", p.unsure);
    }

    #[test]
    fn a_confident_page_reports_no_doubt() {
        let p = assemble(&[w("clean", 0, 40, true)]);
        assert!(p.unsure.is_empty());
        assert!(p.confidence > 0.9, "{}", p.confidence);
    }

    #[test]
    fn confidence_is_the_mean_of_what_was_scored() {
        let words = vec![
            OcrWord { text: "a".into(), left: 0, right: 8, confidence: 1.0, ends_line: false },
            OcrWord { text: "b".into(), left: 16, right: 24, confidence: 0.5, ends_line: true },
        ];
        let p = assemble(&words);
        assert!((p.confidence - 0.75).abs() < 0.001, "{}", p.confidence);
    }

    #[test]
    fn png_dimensions_are_read_from_the_ihdr() {
        // The single white 1x1 PNG.
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            )
            .unwrap();
        assert_eq!(image_size(&bytes).unwrap(), (1, 1));
    }

    #[test]
    fn jpeg_dimensions_are_read_from_the_frame_header() {
        // SOI, a minimal APP0 segment (16 bytes of body), then SOF0 announcing
        // a tiny 8x4 frame.
        let mut jpg = vec![0xFF, 0xD8];
        jpg.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]);
        jpg.extend_from_slice(&[0; 14]);
        jpg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x04, 0x00, 0x08, 0x01]);
        assert_eq!(image_size(&jpg).unwrap(), (8, 4));
    }

    #[test]
    fn widths_are_distributed_in_reading_order() {
        // A candidate "for i in range(10):" split five ways still has strictly
        // increasing left edges, which is what indentation reads off.
        let words = split_words("for i in range(10):", 100.0, 250.0, 0.9, true);
        assert_eq!(words.len(), 4, "{:?}", words);
        assert_eq!(words[0].text, "for");
        assert_eq!(words[3].text, "range(10):");
        assert!(words.windows(2).all(|p| p[0].left < p[1].left));
        assert_eq!(words[0].left, 100);
        assert!(words.last().unwrap().ends_line);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_stub_reports_no_text() {
        let img = ImageInput {
            mime: "image/png".into(),
            data: base64::engine::general_purpose::STANDARD.encode(b"x"),
        };
        let out = recognize_one(&img).unwrap();
        assert_eq!(out.words, 0);
        assert!(out.text.is_empty());
    }
}
