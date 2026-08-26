//! An image on its way to a model or a transcriber.
//!
//! In its own module rather than inside [`crate::providers`] so `vision` can
//! use it without pulling every model type in.
//!
//! Everything Objective-C is localised to `vision`'s engine module, which
//! creates its objects fresh per image, checks the engine's error surface
//! before trusting results, and never lets a reference outlive the call.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ImageInput {
    /// e.g. "image/png"
    pub mime: String,
    /// raw base64, no `data:` prefix
    pub data: String,
}
