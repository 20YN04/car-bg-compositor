import { existsSync } from "node:fs";
import sharp from "sharp";
import type { BBox } from "./bbox.js";
import {
  mapRectToCanvas,
  type CanvasRect,
  type Placement,
} from "./composite.js";
import type { CanvasSize, PlateConfig } from "./config.js";

export type PlateStatus = "blurred" | "replaced" | "none" | "off";

export interface DetectedPlate {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Zet gedetecteerde plaatboxen (broncoördinaten) om naar canvasregio's:
 * alleen platen die op de gemaskeerde auto liggen, met dekmarge, gemapt via
 * dezelfde crop+schaal als de auto en geklemd op het canvas.
 */
export function computePlateRegions(
  detected: DetectedPlate[],
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  placement: Placement,
  canvas: CanvasSize,
  alphaThreshold: number,
): CanvasRect[] {
  return detected
    .filter((p) => {
      const cx = Math.round(p.x + p.w / 2);
      const cy = Math.round(p.y + p.h / 2);
      return (
        cx >= 0 && cx < width && cy >= 0 && cy < height &&
        (alpha[cy * width + cx] ?? 0) > alphaThreshold
      );
    })
    // kleine marge zodat de originele plaat gegarandeerd volledig bedekt is
    .map((p) => ({
      x: p.x - p.w * 0.05,
      y: p.y - p.h * 0.04,
      w: p.w * 1.1,
      h: p.h * 1.08,
    }))
    .map((p) => mapRectToCanvas(p, bbox, placement))
    .map((r) => {
      const x = Math.max(0, Math.round(r.x));
      const y = Math.max(0, Math.round(r.y));
      return {
        x,
        y,
        width: Math.min(canvas.width - x, Math.round(r.width)),
        height: Math.min(canvas.height - y, Math.round(r.height)),
      };
    })
    .filter((r) => r.width >= 8 && r.height >= 4);
}

function plateSvg(canvas: CanvasSize, plates: CanvasRect[], text: string): Buffer {
  const shapes = plates
    .map((p) => {
      const r = Math.min(p.width, p.height) * 0.08;
      // librsvg ondersteunt textLength niet betrouwbaar: fontgrootte zelf
      // passend maken (Arial bold ≈ 0.62 × fontSize per teken)
      const fontSize = Math.min(
        p.height * 0.62,
        (p.width * 0.85) / (Math.max(1, text.length) * 0.62),
      );
      const cx = p.x + p.width / 2;
      const cy = p.y + p.height / 2;
      return (
        `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${r}"` +
        ` fill="#f4f4f4" stroke="#1a1a1a" stroke-width="${Math.max(1, p.height * 0.04)}"/>` +
        `<text x="${cx}" y="${cy}" font-family="Arial, sans-serif" font-weight="bold"` +
        ` font-size="${fontSize}" fill="#1a1a1a" text-anchor="middle"` +
        ` dominant-baseline="central">${text}</text>`
      );
    })
    .join("");
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`,
  );
}

/**
 * Anonimiseert de plaatregio's in het gecomponeerde beeld (PNG-buffer, vóór
 * JPEG-encoding). Puur mathematisch: blur/mosaic van de regio zelf, of een
 * overlay — geen generatieve bewerking.
 */
export async function anonymizePlates(
  compositedPng: Buffer,
  regions: CanvasRect[],
  canvas: CanvasSize,
  plateCfg: PlateConfig,
  plateText: string,
): Promise<{ image: Buffer; status: PlateStatus }> {
  if (plateCfg.mode === "off") return { image: compositedPng, status: "off" };
  if (regions.length === 0) return { image: compositedPng, status: "none" };

  if (plateCfg.mode === "replace") {
    let overlays: sharp.OverlayOptions[];
    if (plateCfg.overlayPath && existsSync(plateCfg.overlayPath)) {
      overlays = await Promise.all(
        regions.map(async (r) => ({
          input: await sharp(plateCfg.overlayPath)
            .resize(r.width, r.height, { fit: "fill" })
            .png()
            .toBuffer(),
          left: r.x,
          top: r.y,
        })),
      );
    } else {
      overlays = [{ input: plateSvg(canvas, regions, plateText) }];
    }
    const image = await sharp(compositedPng).composite(overlays).png().toBuffer();
    return { image, status: "replaced" };
  }

  // mode 'blur': regio extraheren, onherkenbaar maken en terugplakken
  const overlays: sharp.OverlayOptions[] = await Promise.all(
    regions.map(async (r) => {
      const region = sharp(compositedPng).extract({
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
      });
      const input =
        plateCfg.style === "mosaic"
          ? await region
              .resize(Math.max(2, Math.round(r.width / 12)), null, { kernel: "nearest" })
              .resize(r.width, r.height, { kernel: "nearest", fit: "fill" })
              .png()
              .toBuffer()
          : await region.blur(plateCfg.blurSigma).png().toBuffer();
      return { input, left: r.x, top: r.y };
    }),
  );
  const image = await sharp(compositedPng).composite(overlays).png().toBuffer();
  return { image, status: "blurred" };
}
