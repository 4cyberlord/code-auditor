//! No on-device transcriber on this platform.
//!
//! Vision is an Apple framework, so off macOS there is nothing to call. The
//! honest thing to do is to return no words: that is exactly the "this was not
//! a picture of text" signal the frontend already falls back to a vision model
//! on, so an unsupported platform degrades to the model path rather than
//! failing.

/// base64 -> bytes. Nothing to decode here; there is no engine to feed.
pub(super) fn decode(_data: &str) -> Result<Vec<u8>, String> {
    Ok(Vec::new())
}

/// Recognizes nothing.
pub(super) fn recognize(
    _bytes: &[u8],
    _img_w: u32,
    _img_h: u32,
) -> Result<Vec<super::OcrWord>, String> {
    Ok(Vec::new())
}
