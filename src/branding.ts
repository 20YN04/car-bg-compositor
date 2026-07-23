import { existsSync } from "node:fs";
import sharp from "sharp";
import type { BrandingConfig, CanvasSize } from "./config.js";

/**
 * Carredo-logo rechtsonder: een eigen logo-afbeelding (logoPath) of anders
 * een getekend wordmark. Puur een overlay op het eindbeeld.
 */
export async function applyBranding(
  compositedPng: Buffer,
  canvas: CanvasSize,
  cfg: BrandingConfig,
): Promise<Buffer> {
  if (!cfg.enabled) return compositedPng;

  let overlay: Buffer;
  let left: number;
  let top: number;
  if (cfg.logoPath && existsSync(cfg.logoPath)) {
    const targetW = Math.round(canvas.width * 0.12);
    overlay = await sharp(cfg.logoPath)
      .resize(targetW, null, { fit: "inside" })
      .png()
      .toBuffer();
    const meta = await sharp(overlay).metadata();
    left = canvas.width - cfg.margin - (meta.width ?? targetW);
    top = canvas.height - cfg.margin - (meta.height ?? Math.round(targetW / 3));
  } else {
    const w = Math.round(cfg.text.length * cfg.fontSize * 0.75 + 40);
    const h = Math.round(cfg.fontSize * 1.5);
    overlay = Buffer.from(
      `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<text x="${w - 4}" y="${h / 2}" font-family="Arial, sans-serif" font-weight="bold"` +
        ` font-size="${cfg.fontSize}" letter-spacing="${Math.round(cfg.fontSize * 0.18)}"` +
        ` fill="#3a3a3a" fill-opacity="${cfg.opacity}" text-anchor="end"` +
        ` dominant-baseline="central">${cfg.text}</text>` +
        `</svg>`,
    );
    left = canvas.width - cfg.margin - w;
    top = canvas.height - cfg.margin - h;
  }

  return sharp(compositedPng)
    .composite([{ input: overlay, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toBuffer();
}
