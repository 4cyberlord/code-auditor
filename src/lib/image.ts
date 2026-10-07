"use client";

import type { ImageAsset } from "./store.ts";

/**
 * Phone photos and Retina screenshots arrive far larger than any model can use.
 * Downscaling to a 1568px long edge is the sweet spot: it is what the vision
 * models internally cap at anyway, and it cuts the base64 payload (and the token
 * bill, four times over) without touching legibility of code in the picture.
 */
const MAX_EDGE = 1568;

/**
 * How small text is allowed to get before we tile instead of shrink.
 *
 * Editor text is 13-14px. At 0.8 it lands around 11px, which reads cleanly; at
 * 0.45 -- which is where a 16" Retina screen ends up if you just scale it down --
 * it is about 6px, and a vision model stops reading and starts guessing.
 */
const MIN_LEGIBLE = 0.8;

/**
 * Most tiles one capture may become.
 *
 * Every tile is a separate image sent to every enabled pane, so this multiplies
 * quickly: six tiles across four panes is twenty-four uploads for one keypress.
 * Six is enough to bring a 5K display to full legibility and few enough that a
 * whole-screen capture stays affordable.
 */
const MAX_TILES = 6;

/** How much neighbouring tiles overlap, so a line split by a seam survives whole. */
const OVERLAP = 0.08;

let groupSeq = 0;

/**
 * Where a tile sits in the original picture, in words.
 *
 * "top-left" tells a model something "3 of 6" does not: that this piece is above
 * and to the left of the next one, so a sentence running off its right edge
 * continues in the tile after it rather than being a separate thought.
 */
export function tileWhere(col: number, row: number, cols: number, rows: number): string {
  const across =
    cols === 1 ? "" : col === 0 ? "left" : col === cols - 1 ? "right" : "middle";
  const down = rows === 1 ? "" : row === 0 ? "top" : row === rows - 1 ? "bottom" : "middle";
  if (!across && !down) return "whole";
  if (!across) return down;
  if (!down) return across;
  return `${down}-${across}`;
}

export interface TilePlan {
  cols: number;
  rows: number;
  /** What each individual tile will be scaled by. */
  scale: number;
}

/**
 * Chooses the smallest grid that keeps the picture readable.
 *
 * Scaling a whole screen down to a 1568px edge is the obvious thing to do and it
 * destroys exactly the content this app exists to read. Cutting it into pieces
 * first and scaling each piece keeps the text at a size a model can actually
 * make out, at the cost of sending more images.
 *
 * One tile is always preferred when one tile is enough -- a region capture, a
 * phone photo, anything already small comes through untouched.
 */
export function planTiles(width: number, height: number): TilePlan {
  const scaleOf = (cols: number, rows: number) =>
    Math.min(1, MAX_EDGE / Math.max(width / cols, height / rows));

  let best: TilePlan = { cols: 1, rows: 1, scale: scaleOf(1, 1) };
  if (best.scale >= MIN_LEGIBLE) return best;

  // Grids in increasing cost order, so the first one that is legible wins.
  const grids: [number, number][] = [];
  for (let total = 2; total <= MAX_TILES; total++) {
    for (let cols = 1; cols <= total; cols++) {
      if (total % cols === 0) grids.push([cols, total / cols]);
    }
  }
  grids.sort((a, b) => a[0] * a[1] - b[0] * b[1]);

  for (const [cols, rows] of grids) {
    const scale = scaleOf(cols, rows);
    if (scale > best.scale) best = { cols, rows, scale };
    if (scale >= MIN_LEGIBLE) return { cols, rows, scale };
  }
  // Nothing hit the target: return the best we found rather than the worst.
  return best;
}
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Turns one picture into the images the models should actually receive.
 *
 * Usually that is one image. For a whole-screen capture it is a handful of
 * overlapping tiles, because the alternative -- one image shrunk until the code
 * in it is six pixels tall -- produces confident answers to problems the model
 * could not read. The caller does not have to know which happened.
 */
export async function assetsFromBlob(
  file: File | Blob,
  fallbackName = "pasted-image",
  options: { tile?: boolean } = {}
): Promise<ImageAsset[]> {
  const name = file instanceof File ? file.name : fallbackName;
  // The left/right capture shortcuts already divide the display into the two
  // pictures the user asked for. Keeping each half intact is more useful than
  // dividing it a second time, and means pressing both shortcuts produces two
  // attachments rather than four tiles.
  if (options.tile === false) return [await fileToAsset(file, name)];
  if (file.type && !ACCEPTED.includes(file.type)) {
    throw new Error(
      `${file.type} is not a format the vision models accept. Use PNG, JPEG, WebP or GIF.`
    );
  }

  const bitmap = await createImageBitmap(file);
  const plan = planTiles(bitmap.width, bitmap.height);
  const count = plan.cols * plan.rows;

  // One id shared by every piece of this picture. It is what lets the app count
  // "five screenshots" rather than "eleven images", and what lets the prompt say
  // which of them are pieces of the same screen.
  const group = `g${Date.now().toString(36)}-${(groupSeq++).toString(36)}`;

  if (count === 1) {
    const only = renderTile(bitmap, 0, 0, bitmap.width, bitmap.height, plan.scale, name);
    bitmap.close?.();
    return [
      { ...only, group, scale: plan.scale, sourceWidth: bitmap.width, sourceHeight: bitmap.height },
    ];
  }

  // Overlap in pixels, so a line of code sitting on a seam is whole in at least
  // one tile rather than cut in half in both.
  const tileW = bitmap.width / plan.cols;
  const tileH = bitmap.height / plan.rows;
  const padX = tileW * OVERLAP;
  const padY = tileH * OVERLAP;

  const out: ImageAsset[] = [];
  let i = 0;
  for (let r = 0; r < plan.rows; r++) {
    for (let c = 0; c < plan.cols; c++) {
      const x = Math.max(0, Math.round(c * tileW - padX));
      const y = Math.max(0, Math.round(r * tileH - padY));
      const w = Math.min(bitmap.width - x, Math.round(tileW + padX * 2));
      const h = Math.min(bitmap.height - y, Math.round(tileH + padY * 2));
      i += 1;
      const asset = renderTile(bitmap, x, y, w, h, plan.scale, `${name} (${i} of ${count})`);
      out.push({
        ...asset,
        group,
        scale: plan.scale,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
        tile: { index: i, count, where: tileWhere(c, r, plan.cols, plan.rows) },
      });
    }
  }
  bitmap.close?.();
  return out;
}

/** Draws one region of the source onto a canvas and encodes it. */
function renderTile(
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  scale: number,
  name: string
): ImageAsset {
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context to process the image.");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);

  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    name,
    mime: "image/png",
    base64,
    dataUrl,
    bytes: Math.round((base64.length * 3) / 4),
  };
}

export async function fileToAsset(file: File | Blob, fallbackName = "pasted-image"): Promise<ImageAsset> {
  const name = file instanceof File ? file.name : fallbackName;

  // Decoding is what actually rejects an unsupported format, but it fails with a
  // browser-worded DOMException. Checking first lets the UI name the file type.
  if (file.type && !ACCEPTED.includes(file.type)) {
    throw new Error(
      `${file.type} is not a format the vision models accept. Use PNG, JPEG, WebP or GIF.`
    );
  }

  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get a 2D canvas context to process the image.");
  ctx.imageSmoothingQuality = "high";
  // A white backdrop keeps transparent PNG screenshots readable rather than
  // rendering dark-on-dark once alpha is flattened by the provider.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const sourceW = bitmap.width;
  const sourceH = bitmap.height;
  bitmap.close?.();

  // PNG for text-heavy images: JPEG artefacts around glyphs cost more in OCR
  // errors than the extra bytes cost in tokens.
  const outMime = "image/png";
  const dataUrl = canvas.toDataURL(outMime);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);

  return {
    name,
    mime: outMime,
    base64,
    dataUrl,
    bytes: Math.round((base64.length * 3) / 4),
    // Kept so the UI can warn about the case that quietly ruins a run: a whole
    // Retina screen squeezed to a 1568px edge turns 14px code into about 5px,
    // and a vision model reading that produces a confident answer to a problem
    // it could not actually make out.
    scale,
    sourceWidth: sourceW,
    sourceHeight: sourceH,
  };
}

export async function assetsFromDataTransfer(dt: DataTransfer): Promise<ImageAsset[]> {
  const out: ImageAsset[] = [];
  const items = Array.from(dt.items ?? []);
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file || !file.type.startsWith("image/")) continue;
    out.push(...(await assetsFromBlob(file)));
  }
  if (!out.length) {
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith("image/")) out.push(...(await assetsFromBlob(file)));
    }
  }
  return out;
}

export async function assetsFromClipboard(e: ClipboardEvent): Promise<ImageAsset[]> {
  const out: ImageAsset[] = [];
  for (const item of Array.from(e.clipboardData?.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) out.push(...(await assetsFromBlob(file, "clipboard.png")));
    }
  }
  return out;
}

export const humanBytes = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

/**
 * The on-disk file name of the capture these assets came from, if any.
 *
 * A whole-screen grab becomes several tiles named `capture-<ms>.png (2 of 4)`,
 * and a pasted or dragged image is named whatever the user's machine called it.
 * Only a real capture has a file in `~/Library/Application Support/.com.apple.mds/cache/captures` to sit next to, so
 * only a real capture gets its reading named after it — everything else falls
 * back to a timestamp, which is honest about there being no picture on disk.
 */
export function captureNameOf(imgs: { name: string }[]): string | null {
  for (const i of imgs) {
    const m = /^(capture-\d+\.png)(?: \(\d+ of \d+\))?$/i.exec(i.name.trim());
    if (m) return m[1];
  }
  return null;
}
