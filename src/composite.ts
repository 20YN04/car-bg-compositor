import sharp from "sharp";
import type { BBox } from "./bbox.js";
import type { CanvasSize, Config } from "./config.js";

export interface Placement {
  scale: number;
  x: number; // linkerkant van de geschaalde bbox op het canvas
  y: number; // bovenkant van de geschaalde bbox op het canvas
  width: number; // geschaalde bbox-breedte
  height: number; // geschaalde bbox-hoogte
  outOfCanvas: boolean; // deel van de auto valt buiten het canvas
}

/**
 * Puur mathematische plaatsing: schaal op bbox-breedte, horizontaal centreren,
 * verticaal uitlijnen zodat de grondlijn (niet bbox.bottom) exact op GROUND_Y
 * landt. Zo staat een SUV even hoog als een sportwagen.
 */
export function computePlacement(
  bbox: BBox,
  groundLine: number,
  canvas: CanvasSize,
  groundY: number,
  carWidthRatio: number,
): Placement {
  const bboxWidth = bbox.right - bbox.left + 1;
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const scale = (canvas.width * carWidthRatio) / bboxWidth;
  const width = bboxWidth * scale;
  const height = bboxHeight * scale;
  const x = (canvas.width - width) / 2;
  // +1: groundLine is een inclusieve pixelrij; de onderrand ervan moet op
  // GROUND_Y landen (anders staat elke auto één geschaalde pixel te laag)
  const y = groundY - (groundLine - bbox.top + 1) * scale;
  const outOfCanvas =
    x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height;
  return { scale, x, y, width, height, outOfCanvas };
}

function shadowSvg(
  canvas: CanvasSize,
  placement: Placement,
  groundY: number,
  cfg: Config,
): Buffer {
  const s = cfg.SHADOW;
  const cx = placement.x + placement.width / 2 + s.offsetX;
  const cy = groundY + s.offsetY;
  const rx = (placement.width * s.widthRatio) / 2;
  const ry = s.height / 2;
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black" fill-opacity="${s.opacity}"/>` +
      `</svg>`,
  );
}

export interface CompositeInput {
  rgba: Buffer; // raw RGBA van de cutout (origineel formaat)
  width: number;
  height: number;
  bbox: BBox;
  placement: Placement;
  backgroundPath: string;
}

/** Composite: achtergrond → schaduw (multiply) → auto. Schrijft JPEG-bytes. */
export async function compositeImage(
  input: CompositeInput,
  cfg: Config,
): Promise<Buffer> {
  const { rgba, width, height, bbox, placement, backgroundPath } = input;
  const canvas = cfg.CANVAS;

  const background = await sharp(backgroundPath)
    .resize(canvas.width, canvas.height, { fit: "cover" })
    .removeAlpha()
    .toBuffer();

  const shadow = await sharp(shadowSvg(canvas, placement, cfg.GROUND_Y, cfg))
    .blur(cfg.SHADOW.blur)
    .png()
    .toBuffer();

  const scaledW = Math.max(1, Math.round(placement.width));
  const scaledH = Math.max(1, Math.round(placement.height));
  let car = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({
      left: bbox.left,
      top: bbox.top,
      width: bbox.right - bbox.left + 1,
      height: bbox.bottom - bbox.top + 1,
    })
    .resize(scaledW, scaledH)
    .png()
    .toBuffer();

  // Sharp accepteert geen negatieve offsets: knip het zichtbare deel uit
  // wanneer de plaatsing (deels) buiten het canvas valt.
  let left = Math.round(placement.x);
  let top = Math.round(placement.y);
  const cropLeft = Math.max(0, -left);
  const cropTop = Math.max(0, -top);
  const visibleW = Math.min(scaledW - cropLeft, canvas.width - Math.max(0, left));
  const visibleH = Math.min(scaledH - cropTop, canvas.height - Math.max(0, top));
  if (visibleW <= 0 || visibleH <= 0) {
    throw new Error("auto valt volledig buiten het canvas");
  }
  if (cropLeft > 0 || cropTop > 0 || visibleW < scaledW || visibleH < scaledH) {
    car = await sharp(car)
      .extract({ left: cropLeft, top: cropTop, width: visibleW, height: visibleH })
      .png()
      .toBuffer();
    left = Math.max(0, left);
    top = Math.max(0, top);
  }

  return sharp(background)
    .composite([
      { input: shadow, blend: "multiply" },
      { input: car, left, top },
    ])
    .jpeg({ quality: cfg.JPEG_QUALITY })
    .toBuffer();
}

/**
 * Default achtergrond: verticale gradient lichtgrijs → wit, geen horizonlijn,
 * geen textuur. Verbergt perspectief-mismatch bij wisselende camerahoeken.
 */
export async function generateDefaultBackground(
  path: string,
  canvas: CanvasSize,
): Promise<void> {
  const svg = Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#e8e8e8"/>` +
      `<stop offset="1" stop-color="#ffffff"/>` +
      `</linearGradient></defs>` +
      `<rect width="100%" height="100%" fill="url(#g)"/>` +
      `</svg>`,
  );
  await sharp(svg).png().toFile(path);
}
