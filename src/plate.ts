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
  const carArea = (bbox.right - bbox.left + 1) * (bbox.bottom - bbox.top + 1);
  const carWidth = bbox.right - bbox.left + 1;
  return detected
    // Florence plakt de prompt bij afwezigheid van een plaat soms op de hele
    // auto; een echte plaat beslaat maar een fractie van het autosilhouet
    .filter((p) => p.w * p.h <= 0.04 * carArea && p.w <= 0.35 * carWidth)
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

/**
 * Dekmasker voor de originele plaat + frame: de regio wordt geblurd zodat de
 * omgeving (bumperkleuren, overgangen) exact behouden blijft — geen
 * kleurpatch die als sticker opvalt.
 */
async function blurOverlay(
  compositedPng: Buffer,
  r: CanvasRect,
  sigma: number,
): Promise<sharp.OverlayOptions> {
  const input = await sharp(compositedPng)
    .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
    .blur(sigma)
    .png()
    .toBuffer();
  return { input, left: r.x, top: r.y };
}

/** CARREDO-plaat in EU-verhouding: blauwe band, rand, afgeronde hoeken. */
function carredoPlateSvg(w: number, h: number, text: string): Buffer {
  const band = Math.max(6, Math.round(w * 0.08));
  const r = Math.max(2, Math.round(h * 0.14));
  const stroke = Math.max(1.5, h * 0.05);
  const fontSize = Math.min(
    h * 0.68,
    ((w - band) * 0.82) / (Math.max(1, text.length) * 0.62),
  );
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="${stroke / 2}" y="${stroke / 2}" width="${w - stroke}" height="${h - stroke}"` +
      ` rx="${r}" fill="#f8f9fa" stroke="#16213e" stroke-width="${stroke}"/>` +
      `<path d="M ${stroke / 2} ${r} A ${r} ${r} 0 0 1 ${r} ${stroke / 2}` +
      ` L ${band} ${stroke / 2} L ${band} ${h - stroke / 2} L ${r} ${h - stroke / 2}` +
      ` A ${r} ${r} 0 0 1 ${stroke / 2} ${h - r} Z" fill="#003399"/>` +
      `<text x="${band + (w - band) / 2}" y="${h / 2}" font-family="Arial, sans-serif"` +
      ` font-weight="bold" font-size="${fontSize}" letter-spacing="${fontSize * 0.06}"` +
      ` fill="#16213e" text-anchor="middle" dominant-baseline="central">${text}</text>` +
      `</svg>`,
  );
}

/** Past de plaat in EU-verhouding (≈4.6:1) binnen de gedetecteerde zone. */
export function fitPlateInRegion(
  r: CanvasRect,
): { left: number; top: number; width: number; height: number } {
  const aspect = 4.6;
  let width = r.width * 0.94;
  let height = width / aspect;
  if (height > r.height * 0.94) {
    height = r.height * 0.94;
    width = height * aspect;
  }
  return {
    left: Math.round(r.x + (r.width - width) / 2),
    top: Math.round(r.y + (r.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
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
    const overlays: sharp.OverlayOptions[] = [];
    for (const r of regions) {
      // eerst de originele plaat + frame laten wegvallen (blur behoudt de
      // omgevingskleuren), dán de plaat in echte EU-verhouding
      overlays.push(await blurOverlay(compositedPng, r, plateCfg.blurSigma));
      const fit = fitPlateInRegion(r);
      if (plateCfg.overlayPath && existsSync(plateCfg.overlayPath)) {
        overlays.push({
          input: await sharp(plateCfg.overlayPath)
            .resize(fit.width, fit.height, { fit: "fill" })
            .png()
            .toBuffer(),
          left: fit.left,
          top: fit.top,
        });
      } else {
        overlays.push({
          input: carredoPlateSvg(fit.width, fit.height, plateText),
          left: fit.left,
          top: fit.top,
        });
      }
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
