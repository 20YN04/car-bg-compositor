import sharp from "sharp";
import type { BBox, ContactCluster } from "./bbox.js";
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

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Beeldt een rechthoek in broncoördinaten (bv. een gedetecteerde nummerplaat)
 * af op canvascoördinaten, via dezelfde crop+schaal als de auto zelf.
 */
export function mapRectToCanvas(
  rect: { x: number; y: number; w: number; h: number },
  bbox: BBox,
  placement: Placement,
): CanvasRect {
  return {
    x: placement.x + (rect.x - bbox.left) * placement.scale,
    y: placement.y + (rect.y - bbox.top) * placement.scale,
    width: rect.w * placement.scale,
    height: rect.h * placement.scale,
  };
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

export interface ShadowEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * Contactschaduw per wielcontact-cluster: elke cluster krijgt een ellips op
 * zijn eigen (geschaalde) contacthoogte, zodat bij een 3/4-view zowel het
 * nabije als het verre wiel geaard oogt in plaats van te zweven boven één
 * vaste ellips op GROUND_Y.
 */
export function buildContactShadows(
  clusters: ContactCluster[],
  bbox: BBox,
  placement: Placement,
  cfg: Config,
): ShadowEllipse[] {
  return clusters.map((c) => {
    const centerX = (c.x0 + c.x1) / 2;
    const clusterWidth = (c.x1 - c.x0 + 1) * placement.scale;
    return {
      cx: placement.x + (centerX - bbox.left) * placement.scale,
      cy:
        placement.y +
        (c.y - bbox.top + 1) * placement.scale +
        cfg.SHADOW.offsetY,
      rx: (clusterWidth / 2) * 1.4,
      ry: cfg.SHADOW.height * 0.35,
    };
  });
}

function shadowSvg(
  canvas: CanvasSize,
  placement: Placement,
  groundY: number,
  cfg: Config,
  contacts: ShadowEllipse[],
): Buffer {
  const s = cfg.SHADOW;
  const cx = placement.x + placement.width / 2 + s.offsetX;
  const cy = groundY + s.offsetY;
  const rx = (placement.width * s.widthRatio) / 2;
  const ry = s.height / 2;
  // met contactclusters wordt de brede ellips een zachte ambient-schaduw en
  // dragen de clusters het eigenlijke contact; zonder clusters (fallback)
  // blijft het oude gedrag: één ellips op volle sterkte
  const ambientOpacity = contacts.length > 0 ? s.opacity * 0.55 : s.opacity;
  const shapes = [
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black" fill-opacity="${ambientOpacity}"/>`,
    ...contacts.map(
      (c) =>
        `<ellipse cx="${c.cx}" cy="${c.cy}" rx="${c.rx}" ry="${c.ry}" fill="black" fill-opacity="${s.opacity}"/>`,
    ),
  ].join("");
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`,
  );
}

export interface CompositeInput {
  rgba: Buffer; // raw RGBA van de cutout (origineel formaat)
  width: number;
  height: number;
  bbox: BBox;
  placement: Placement;
  backgroundPath: string;
  plates?: CanvasRect[]; // nummerplaten in canvascoördinaten, overlay met plateText
  plateText?: string;
  contactShadows?: ShadowEllipse[]; // per wielcontact, uit buildContactShadows
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

  const shadow = await sharp(
    shadowSvg(canvas, placement, cfg.GROUND_Y, cfg, input.contactShadows ?? []),
  )
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

  const layers: sharp.OverlayOptions[] = [
    { input: shadow, blend: "multiply" },
    { input: car, left, top },
  ];
  if (input.plates && input.plates.length > 0 && input.plateText) {
    layers.push({ input: plateSvg(canvas, input.plates, input.plateText) });
  }

  return sharp(background)
    .composite(layers)
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
