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

export interface Point {
  x: number;
  y: number;
}

/** Parallellogram-benadering van het plaatvlak (tl/tr/bl/br). */
export interface PlateQuad {
  tl: Point;
  tr: Point;
  bl: Point;
  br: Point;
}

/** Plaatdoel voor anonimisatie: canvasregio + optioneel het plaatvlak. */
export interface PlateTarget {
  region: CanvasRect;
  quad?: PlateQuad; // canvascoördinaten; zonder quad valt de badge terug op de rechte fit
}

/**
 * Schat de vier hoekpunten van de plaat uit een SAM2-masker (bron-space).
 * Parallellogram-benadering: per kolom binnen de (ruime) detectiebox de
 * bovenste/onderste maskerpixel; de eerste en laatste kolomclusters geven de
 * linker- en rechterrand. Puur geometrie — geen generatieve stap.
 */
export function plateQuadFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  box: DetectedPlate,
  threshold = 128,
): PlateQuad | null {
  const mx = Math.round(box.w * 0.15);
  const my = Math.round(box.h * 0.4);
  const x0 = Math.max(0, Math.round(box.x) - mx);
  const x1 = Math.min(width - 1, Math.round(box.x + box.w) + mx);
  const y0 = Math.max(0, Math.round(box.y) - my);
  const y1 = Math.min(height - 1, Math.round(box.y + box.h) + my);
  const cols: { x: number; top: number; bot: number }[] = [];
  for (let x = x0; x <= x1; x++) {
    let top = -1;
    let bot = -1;
    for (let y = y0; y <= y1; y++) {
      if ((mask[y * width + x] ?? 0) > threshold) {
        if (top < 0) top = y;
        bot = y;
      }
    }
    if (top >= 0 && bot - top >= 2) cols.push({ x, top, bot });
  }
  if (cols.length < Math.max(8, box.w * 0.5)) return null;
  const k = Math.max(2, Math.round(cols.length * 0.06));
  const mean = (arr: typeof cols, f: (c: (typeof cols)[number]) => number) =>
    arr.reduce((s, c) => s + f(c), 0) / arr.length;
  const left = cols.slice(0, k);
  const right = cols.slice(-k);
  const tl = { x: mean(left, (c) => c.x), y: mean(left, (c) => c.top) };
  const bl = { x: mean(left, (c) => c.x), y: mean(left, (c) => c.bot) };
  const tr = { x: mean(right, (c) => c.x), y: mean(right, (c) => c.top) };
  const br = { x: mean(right, (c) => c.x), y: mean(right, (c) => c.bot) };
  const w = tr.x - tl.x;
  const hL = bl.y - tl.y;
  const hR = br.y - tr.y;
  if (w < 8 || hL < 4 || hR < 4) return null;
  const aspect = w / ((hL + hR) / 2);
  // echte platen (recht tot schuin aangesneden) vallen hier ruim binnen;
  // een mislukte segmentatie (bumper, grille) valt erbuiten
  if (aspect < 1.5 || aspect > 9) return null;
  return { tl, tr, bl, br };
}

/**
 * Quad opblazen rond zijn zwaartepunt (dekmarge voor de badge). Verticaal
 * apart instelbaar: SAM2 onderschat de plaathoogte vaak net (frame/onderrand
 * buiten het masker) en dan piept de originele plaat onder de badge uit.
 */
export function inflateQuad(q: PlateQuad, fx: number, fy = fx): PlateQuad {
  const cx = (q.tl.x + q.tr.x + q.bl.x + q.br.x) / 4;
  const cy = (q.tl.y + q.tr.y + q.bl.y + q.br.y) / 4;
  const grow = (p: Point): Point => ({
    x: cx + (p.x - cx) * fx,
    y: cy + (p.y - cy) * fy,
  });
  return { tl: grow(q.tl), tr: grow(q.tr), bl: grow(q.bl), br: grow(q.br) };
}

/**
 * Affine plaatsing van een W×H-badge op het quad-vlak: sharp's affine is
 * x' = a·x + b·y, y' = c·x + d·y. De badge-basisvectoren worden op de
 * quad-randen (tl→tr en tl→bl) gelegd; br volgt uit het parallellogram.
 */
export function affinePlacementForQuad(
  q: PlateQuad,
  w: number,
  h: number,
): { matrix: [number, number, number, number]; left: number; top: number } {
  const u = { x: (q.tr.x - q.tl.x) / w, y: (q.tr.y - q.tl.y) / w };
  const v = { x: (q.bl.x - q.tl.x) / h, y: (q.bl.y - q.tl.y) / h };
  const corners = [
    q.tl,
    q.tr,
    q.bl,
    { x: q.tl.x + u.x * w + v.x * h, y: q.tl.y + u.y * w + v.y * h },
  ];
  return {
    matrix: [u.x, v.x, u.y, v.y],
    left: Math.round(Math.min(...corners.map((c) => c.x))),
    top: Math.round(Math.min(...corners.map((c) => c.y))),
  };
}

/**
 * Zet gedetecteerde plaatboxen (broncoördinaten) om naar canvasregio's:
 * alleen platen die op de gemaskeerde auto liggen, met dekmarge, gemapt via
 * dezelfde crop+schaal als de auto en geklemd op het canvas.
 */
/** Plausibiliteitsfilters: plaatformaat + ligt op de gemaskeerde auto. */
export function plausiblePlatesOnCar(
  detected: DetectedPlate[],
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  alphaThreshold: number,
): DetectedPlate[] {
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
    });
}

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
  return plausiblePlatesOnCar(detected, alpha, width, height, bbox, alphaThreshold)
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
  feather = 0,
): Promise<sharp.OverlayOptions> {
  let patch = sharp(compositedPng)
    .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
    .blur(sigma);
  if (feather > 0) {
    // rand van de patch laten uitvloeien in het scherpe beeld: zonder feather
    // tekent de blurzone zich als rechthoekige veeg af rond de badge. De
    // volledig dekkende kern blijft ruim groter dan de gedetecteerde plaat.
    const f = Math.max(2, Math.min(feather, Math.floor(Math.min(r.width, r.height) / 4)));
    const mask = Buffer.from(
      `<svg width="${r.width}" height="${r.height}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect x="${f}" y="${f}" width="${r.width - 2 * f}" height="${r.height - 2 * f}"` +
        ` rx="${f}" fill="white"/>` +
        `</svg>`,
    );
    const feathered = await sharp(mask).blur(f / 2).png().toBuffer();
    patch = patch.composite([{ input: feathered, blend: "dest-in" }]);
  }
  const input = await patch.png().toBuffer();
  return { input, left: r.x, top: r.y };
}

/**
 * CARREDO-badge zoals op de live carredo-beelden: donkere plaat, dunne lichte
 * rand, wit wordmark — geen EU-band. Valt visueel weg in de plaatuitsparing.
 */
function carredoPlateSvg(w: number, h: number, text: string): Buffer {
  const r = Math.max(2, Math.round(h * 0.16));
  const stroke = Math.max(1.5, h * 0.06);
  const inset = stroke * 1.6;
  const fontSize = Math.min(
    h * 0.56,
    (w * 0.72) / (Math.max(1, text.length) * 0.62),
  );
  return Buffer.from(
    `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${w}" height="${h}" rx="${r}" fill="#0c0e12"/>` +
      `<rect x="${inset}" y="${inset}" width="${w - inset * 2}" height="${h - inset * 2}"` +
      ` rx="${Math.max(1, r - inset)}" fill="none" stroke="#e9ecef" stroke-width="${stroke}"/>` +
      `<text x="${w / 2}" y="${h / 2}" font-family="Arial, sans-serif"` +
      ` font-weight="bold" font-size="${fontSize}" letter-spacing="${fontSize * 0.1}"` +
      ` fill="#f4f5f7" text-anchor="middle" dominant-baseline="central">${text}</text>` +
      `</svg>`,
  );
}

/**
 * Past de badge in de gedetecteerde zone. De verhouding volgt de regio zelf
 * (geklemd op plaatachtige 3.4–5.2:1) zodat de badge de zone maximaal dekt —
 * bij schuine platen is de axis-aligned box hoger dan een strikte
 * EU-verhouding toelaat en bleef de originele plaat anders zichtbaar.
 */
export function fitPlateInRegion(
  r: CanvasRect,
): { left: number; top: number; width: number; height: number } {
  const aspect = Math.min(5.2, Math.max(3.4, r.width / r.height));
  let width = r.width * 0.97;
  let height = width / aspect;
  if (height > r.height * 0.97) {
    height = r.height * 0.97;
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
/**
 * Quad-pad: blur die de plaatvorm volgt + badge die met een affine warp op
 * het plaatvlak ligt. De badge krijgt zo het perspectief van de bumper in
 * plaats van als rechte sticker over de foto te hangen.
 */
async function quadOverlays(
  compositedPng: Buffer,
  quad: PlateQuad,
  region: CanvasRect,
  canvas: CanvasSize,
  plateCfg: PlateConfig,
  plateText: string,
): Promise<sharp.OverlayOptions[] | null> {
  // bescheiden veiligheidsmarge rond het plaatvlak: de badge dekt de plaat,
  // de blur vangt alleen de quad-randen op. Bewust géén regiobrede blur —
  // de detectiebox bevat vaak niet-gevoelige omgeving (lege plaathouder,
  // dealerstrip) en die wegsmeren geeft een witte gloed rond de badge
  const ySpan =
    Math.max(quad.bl.y, quad.br.y) - Math.min(quad.tl.y, quad.tr.y);
  const blurQuad = inflateQuad(quad, 1.3, 1.5);
  const xs = [blurQuad.tl.x, blurQuad.tr.x, blurQuad.bl.x, blurQuad.br.x];
  const ys = [blurQuad.tl.y, blurQuad.tr.y, blurQuad.bl.y, blurQuad.br.y];
  const bx = Math.max(0, Math.floor(Math.min(...xs)));
  const by = Math.max(0, Math.floor(Math.min(...ys)));
  const bw = Math.min(canvas.width, Math.ceil(Math.max(...xs))) - bx;
  const bh = Math.min(canvas.height, Math.ceil(Math.max(...ys))) - by;
  if (bw < 8 || bh < 4) return null;

  // blur-patch in de bbox van het opgeblazen quad, dest-in een gefeatherde
  // polygon zodat de veeg de plaatvorm volgt en in het scherpe beeld uitvloeit
  const sigma = Math.max(plateCfg.blurSigma, Math.min(bw, bh) / 5);
  const feather = Math.max(2, Math.round(Math.min(bw, bh) * 0.12));
  const poly = [blurQuad.tl, blurQuad.tr, blurQuad.br, blurQuad.bl]
    .map((p) => `${(p.x - bx).toFixed(1)},${(p.y - by).toFixed(1)}`)
    .join(" ");
  const polyMask = await sharp(
    Buffer.from(
      `<svg width="${bw}" height="${bh}" xmlns="http://www.w3.org/2000/svg">` +
        `<polygon points="${poly}" fill="white"/></svg>`,
    ),
  )
    .blur(feather / 2)
    .png()
    .toBuffer();
  // licht dimmen: een uitgesmeerde witte plaat gloeit anders door de blur
  // heen; gedimd leest de zone als schaduw in de plaatuitsparing
  const blurPatch = await sharp(compositedPng)
    .extract({ left: bx, top: by, width: bw, height: bh })
    .blur(sigma)
    .linear([0.82, 0.82, 0.82, 1], [0, 0, 0, 0])
    .composite([{ input: polyMask, blend: "dest-in" }])
    .png()
    .toBuffer();

  // badge op het plaatvlak: renderen op de quad-maat en affine warpen.
  // verticaal groeit de badge tot hij de detectieregio dekt, geklemd op een
  // plaatachtige verhouding (≥3.4:1): dekt een te laag SAM2-quad (03) zonder
  // op een te hoge detectiebox (01) tot een reuzensticker te ontsporen
  const wSpan = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const targetY = Math.min(region.height * 0.95, wSpan / 3.4);
  const badgeFy = ySpan > 0 ? Math.max(1.18, targetY / ySpan) : 1.18;
  const badgeQuad = inflateQuad(quad, 1.05, badgeFy);
  const w = Math.max(
    8,
    Math.round(Math.hypot(badgeQuad.tr.x - badgeQuad.tl.x, badgeQuad.tr.y - badgeQuad.tl.y)),
  );
  const h = Math.max(
    4,
    Math.round(
      (badgeQuad.bl.y - badgeQuad.tl.y + (badgeQuad.br.y - badgeQuad.tr.y)) / 2,
    ),
  );
  const flat =
    plateCfg.overlayPath && existsSync(plateCfg.overlayPath)
      ? await sharp(plateCfg.overlayPath).resize(w, h, { fit: "fill" }).png().toBuffer()
      : await sharp(carredoPlateSvg(w, h, plateText)).png().toBuffer();
  const place = affinePlacementForQuad(badgeQuad, w, h);
  const warped = await sharp(flat)
    .affine(place.matrix, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      interpolator: "bicubic",
    })
    .png()
    .toBuffer();
  return [
    { input: blurPatch, left: bx, top: by },
    { input: warped, left: Math.max(0, place.left), top: Math.max(0, place.top) },
  ];
}

export async function anonymizePlates(
  compositedPng: Buffer,
  targets: PlateTarget[],
  canvas: CanvasSize,
  plateCfg: PlateConfig,
  plateText: string,
): Promise<{ image: Buffer; status: PlateStatus }> {
  if (plateCfg.mode === "off") return { image: compositedPng, status: "off" };
  if (targets.length === 0) return { image: compositedPng, status: "none" };

  if (plateCfg.mode === "replace") {
    const overlays: sharp.OverlayOptions[] = [];
    for (const t of targets) {
      if (t.quad) {
        const viaQuad = await quadOverlays(
          compositedPng, t.quad, t.region, canvas, plateCfg, plateText,
        );
        if (viaQuad) {
          overlays.push(...viaQuad);
          continue;
        }
      }
      // fallback zonder plaatvlak: rechte badge in de detectieregio.
      // de volledige regio blurren blijft de dekgarantie; sigma schaalt mee
      // met de regio en de feather blijft smal zodat de uitvloeiende rand
      // nooit over de plaat zelf valt
      const r = t.region;
      const sigma = Math.max(plateCfg.blurSigma, Math.min(r.width, r.height) / 5);
      overlays.push(
        await blurOverlay(
          compositedPng, r, sigma,
          Math.round(Math.min(r.width, r.height) * 0.1),
        ),
      );
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
    targets.map(async ({ region: r }) => {
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
