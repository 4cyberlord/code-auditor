"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { humanBytes } from "@/lib/image";
import type { ImageAsset } from "@/lib/store";

/**
 * Full-size look at a capture without leaving the app.
 *
 * The thumbnails are 78px, which is enough to tell two screenshots apart and not
 * nearly enough to check that the thing you meant to grab is actually legible in
 * frame -- which is the question you have right before spending four API calls.
 */
export default function ImagePreview({
  images,
  index,
  onClose,
  onNavigate,
  onRemove,
}: {
  images: ImageAsset[];
  index: number;
  onClose: () => void;
  onNavigate: (next: number) => void;
  onRemove: (index: number) => void;
}) {
  const image = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (images.length < 2) return;
      if (e.key === "ArrowRight") onNavigate((index + 1) % images.length);
      if (e.key === "ArrowLeft") onNavigate((index - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, images.length, onClose, onNavigate]);

  // The image can be removed from underneath us by the delete button.
  if (!image) return null;

  // InputBar lives in a transformed workspace panel. A fixed-position child of
  // that panel is fixed to the bottom bar rather than the window, so mount the
  // viewer at document level where it can cover and center over the whole app.
  return createPortal(
    <div
      className="scrim preview-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${image.name}`}
    >
      <figure className="preview">
        <header>
          <span className="preview-name" title={image.name}>
            {image.name}
          </span>
          <span className="preview-meta">
            {humanBytes(image.bytes)}
            {images.length > 1 && ` · ${index + 1} of ${images.length}`}
          </span>
          <span className="spacer" />
          <button
            className="btn tiny danger"
            onClick={() => {
              const last = images.length <= 1;
              onRemove(index);
              // Removing the last one leaves nothing to look at; otherwise stay
              // put, which now shows whatever shifted into this slot.
              if (last) onClose();
              else if (index >= images.length - 1) onNavigate(index - 1);
            }}
          >
            Remove
          </button>
          <button className="btn tiny" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="preview-stage">
          {images.length > 1 && (
            <button
              className="preview-arrow"
              aria-label="Previous image"
              onClick={() => onNavigate((index - 1 + images.length) % images.length)}
            >
              {"‹"}
            </button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image.dataUrl} alt={image.name} />
          {images.length > 1 && (
            <button
              className="preview-arrow right"
              aria-label="Next image"
              onClick={() => onNavigate((index + 1) % images.length)}
            >
              {"›"}
            </button>
          )}
        </div>

        <figcaption>
          Esc closes{images.length > 1 ? " · arrow keys move between captures" : ""}
        </figcaption>
      </figure>
    </div>,
    document.body
  );
}
