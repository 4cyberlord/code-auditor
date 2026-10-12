"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { assetsFromBlob, assetsFromClipboard, assetsFromDataTransfer } from "@/lib/image";
import { useStore, type ImageAsset } from "@/lib/store";
import "./StoryStripIntake.css";

interface Props { onContinue: () => void; }

export default function StoryStripIntake({ onContinue }: Props) {
  const images = useStore((s) => s.images);
  const addImages = useStore((s) => s.addImages);
  const removeImage = useStore((s) => s.removeImage);
  const limit = useStore((s) => s.settings.maxImages);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const ingest = useCallback(async (assetsPromise: Promise<ImageAsset[]>) => {
    try {
      const assets = await assetsPromise;
      if (!assets.length) throw new Error("No readable images were found.");
      const dropped = addImages(assets);
      setError(dropped ? `Image limit reached: ${dropped} could not be added (maximum ${limit}).` : null);
    } catch (cause) {
      setError(`Unable to add image: ${String(cause)}`);
    }
  }, [addImages, limit]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const hasImage = Array.from(event.clipboardData?.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/")
      );
      if (!hasImage) return;
      event.preventDefault();
      void ingest(assetsFromClipboard(event));
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [ingest]);

  const tiles = Array.from({ length: Math.min(limit, Math.max(4, images.length + (images.length < limit ? 1 : 0))) });
  const activePreview = preview === null ? null : images[preview];

  return (
    <main
      className="story-intake"
      aria-label="Screenshot intake"
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void ingest(assetsFromDataTransfer(event.dataTransfer));
      }}
      data-dragging={dragging}
    >
      <header className="story-intake-heading">
        <div>
          <h1>Council</h1>
          <p>Arrange your captures before analysis.</p>
        </div>
        <span className="story-intake-count">{images.length} {images.length === 1 ? "capture" : "captures"} ready</span>
      </header>

      <div className="story-intake-grid" data-count={tiles.length}>
        {tiles.map((_, index) => {
          const image = images[index];
          return (
            <div className="story-intake-tile" key={index} data-filled={Boolean(image)}>
              {image ? (
                <>
                  <button className="story-intake-image" type="button" onClick={() => setPreview(index)} aria-label={`Preview capture ${index + 1}`}>
                    <img src={image.dataUrl} alt={image.name || `Capture ${index + 1}`} />
                    <span className="story-intake-number">{String(index + 1).padStart(2, "0")}</span>
                  </button>
                  <button className="story-intake-remove" type="button" aria-label={`Remove capture ${index + 1}`} onClick={() => removeImage(index)}>×</button>
                </>
              ) : (
                <button className="story-intake-placeholder" type="button" onClick={() => picker.current?.click()} aria-label="Add screenshot">
                  <span className="story-intake-plus">+</span>
                  <span>Add screenshot</span>
                  <small>Paste or drop an image</small>
                  <span className="story-intake-number">{String(index + 1).padStart(2, "0")}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="story-intake-error" role="alert">{error}</p>}
      <footer className="story-intake-footer">
        <span>More images can be added afterward.</span>
        <div className="story-intake-actions">
          <button type="button" className="story-intake-secondary" disabled={images.length >= limit} onClick={() => picker.current?.click()}>Add images</button>
          <button type="button" className="story-intake-primary" disabled={!images.length} onClick={onContinue}>Review these <span aria-hidden="true">→</span></button>
        </div>
      </footer>
      <input ref={picker} hidden type="file" accept="image/*" multiple
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void ingest(Promise.all(files.map((file) => assetsFromBlob(file))).then((groups) => groups.flat()));
        }}
      />
      {activePreview && (
        <div className="story-intake-lightbox" role="dialog" aria-modal="true" aria-label="Screenshot preview" onClick={() => setPreview(null)}>
          <button type="button" onClick={() => setPreview(null)} aria-label="Close preview">Close ×</button>
          <img src={activePreview.dataUrl} alt={activePreview.name} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </main>
  );
}
