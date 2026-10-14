"use client";

import type { ImageAsset } from "@/lib/store";
import { createPortal } from "react-dom";

/** The deliberate pause between capture and any model work. */
export default function CaptureReview({
  images,
  maxImages,
  onContinue,
  onRemove,
  onOpen,
  onCapture,
}: {
  images: ImageAsset[];
  maxImages: number;
  onContinue: () => void;
  onRemove: (index: number) => void;
  onOpen: (index: number) => void;
  onCapture: (kind: "screen" | "region") => void;
}) {
  const visible = images.slice(0, maxImages);
  if (!visible.length) return null;

  if (typeof document === "undefined") return null;

  return createPortal(
    <section className="capture-review" role="dialog" aria-modal="true" aria-label="Review captures">
      <div className="capture-review-window">
        <header className="capture-review-head">
          <span className="capture-review-brand">Council</span>
          <span>{visible.length} {visible.length === 1 ? "capture" : "captures"} ready</span>
        </header>

        <div className="capture-story" aria-label="Captured images">
          {visible.map((image, index) => (
            <article className={`capture-story-image capture-story-image-${index + 1}`} key={`${image.name}-${index}`}>
              <button
                className="capture-story-open"
                type="button"
                onClick={() => onOpen(index)}
                aria-label={`Open ${image.name}`}
              >
                <img src={image.dataUrl} alt={image.name} />
              </button>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <button
                className="capture-story-remove"
                type="button"
                onClick={() => onRemove(index)}
                aria-label={`Remove ${image.name}`}
              >
                ×
              </button>
            </article>
          ))}
        </div>

        <footer className="capture-review-foot">
          <div className="capture-review-add">
            <span>Nothing has been sent to a model.</span>
            {visible.length < maxImages && (
              <span className="capture-review-buttons">
                <button type="button" onClick={() => onCapture("screen")}>Add screen</button>
                <button type="button" onClick={() => onCapture("region")}>Add region</button>
              </span>
            )}
          </div>
          <button className="capture-review-continue" type="button" onClick={onContinue}>
            Continue with {visible.length}
          </button>
        </footer>
      </div>
    </section>,
    document.body
  );
}
