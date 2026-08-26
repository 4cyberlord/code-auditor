//! Text recognition via `VNRecognizeTextRequest`.
//!
//! Everything Objective-C is localised here. The objects are created fresh for
//! each image and never leave this function, so no reference can outlive or
//! alias across a thread; the only errors the framework can report are looked
//! at before the results are trusted.
//!
//! Two of the configuration choices are worth stating, because the defaults
//! are not the same as what a transcription of a screen full of code wants:
//!
//! - **Language correction is off.** What NLP correction does is "fix" what it
//!   read into something more likely, which is exactly wrong for transcribing
//!   code: it will "correct" an identifier, or a bug. Raw recognition is what
//!   "transcribe, don't fix" means.
//! - **Automatic language detection is on.** Code screenshots are English plus
//!   symbols, but a mixed screen -- an error message in another language, say --
//!   reads better when the engine picks the script. `recognitionLanguages` is
//!   deliberately left alone, because setting it fights the detection.

use objc2_foundation::{NSArray, NSData, NSDictionary};
use objc2_vision::{
    VNImageOption, VNImageRectForNormalizedRect, VNImageRequestHandler, VNRecognizeTextRequest,
    VNRequest, VNRequestTextRecognitionLevel,
};

use super::{OcrWord, split_words};

/// base64 -> bytes. The app's own capture path encodes losslessly, so a decode
/// failure here is a corrupt payload rather than a user mistake, and "could
/// not decode" is what both should get.
pub(super) fn decode(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "That image could not be decoded for on-device OCR.".to_string())
}

/// Runs one recognition pass over `bytes` (an image `image_size` has already
/// read the dimensions of) and returns its words.
pub(super) fn recognize(bytes: &[u8], img_w: u32, img_h: u32) -> Result<Vec<OcrWord>, String> {
    let data = NSData::from_vec(bytes.to_vec());

    let req = VNRecognizeTextRequest::new();
    req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    req.setUsesLanguageCorrection(false);
    req.setAutomaticallyDetectsLanguage(true);

    let options: objc2::rc::Retained<NSDictionary<VNImageOption, objc2::runtime::AnyObject>> =
        NSDictionary::new();
    let handler = VNImageRequestHandler::initWithData_options(
        objc2::AllocAnyThread::alloc(),
        &data,
        &options,
    );

    // The request is fresh per image and never leaves this thread, which is
    // what makes the synchronous `performRequests` sound. The supertype cast
    // can fail in principle but not here: the class being downcast to is one
    // this one is an instance of by construction.
    let requests = NSArray::from_retained_slice(&[objc2::rc::Retained::downcast::<VNRequest>(
        req.clone(),
    )
    .expect("the class being downcast to is a superclass of the one we started with")]);
    handler
        .performRequests_error(&requests)
        .map_err(|e| format!("On-device text recognition failed: {}", e))?;

    let observations = req.results().unwrap_or_default();
    let mut out: Vec<OcrWord> = Vec::new();
    for obs in observations.iter() {
        // The top candidate is what we transcribe; the engine's runners-up are
        // not interesting here.
        let cands = obs.topCandidates(1);
        // `NSArray`'s first-element accessor is `firstObject_unchecked`; its
        // unsafety is a mutated-while-borrowed reference, which cannot happen
        // here because the array is a fresh result owned by this loop.
        let cand = match unsafe { cands.firstObject_unchecked() } {
            Some(c) => c,
            None => continue,
        };
        let text = cand.string().to_string();
        // `boundingBox` is normalized (0..1) against the image with the origin
        // at the lower-left, which is meaningless to anything that expects
        // pixel coordinates. `VNImageRectForNormalizedRect` converts it, origin
        // included, and rounds to whole pixels.
        let r = unsafe {
            VNImageRectForNormalizedRect(obs.boundingBox(), img_w as usize, img_h as usize)
        };
        out.extend(split_words(
            &text,
            r.origin.x as f32,
            r.size.width as f32,
            cand.confidence(),
            true,
        ));
    }
    Ok(out)
}
