import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import type { PlateConfig } from "./config.js";
import { ensureFalKey } from "./mask.js";

export interface PlateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Point {
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

async function uploadImage(bytes: Buffer, name: string): Promise<string> {
  ensureFalKey();
  const file = new File([new Uint8Array(bytes)], name, { type: "image/jpeg" });
  return fal.storage.upload(file);
}

/** Florence-2 grounding: boxen voor een tekstprompt, gecachet. */
export async function florenceBoxes(
  imageBytes: Buffer,
  prompt: string,
  cacheSuffix: string,
  modelId: string,
  cacheDir: string,
  useCache: boolean,
): Promise<PlateBox[]> {
  const hash = createHash("sha256")
    .update(imageBytes)
    .update(prompt)
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.${cacheSuffix}.json`);
  if (useCache && existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8")) as PlateBox[];
  }
  const imageUrl = await uploadImage(imageBytes, `${cacheSuffix}.jpg`);
  const result = await fal.subscribe(modelId, {
    input: { image_url: imageUrl, text_input: prompt },
  });
  const data = result.data as {
    results?: { bboxes?: { x: number; y: number; w: number; h: number }[] };
  };
  const boxes: PlateBox[] = (data.results?.bboxes ?? []).map((b) => ({
    x: b.x, y: b.y, w: b.w, h: b.h,
  }));
  await writeFile(cachePath, JSON.stringify(boxes));
  return boxes;
}

/**
 * Strak plaatkader voor de lakcorrectie-uitsluiting: exact zo groot als de
 * plaat zelf. De rauwe Florence-box pakt geregeld de hele houderzone (of
 * meer), en een te ruime uitsluiting laat een rechthoek óngecorrigeerde lak
 * rond de plaat staan. Voorkeursroute: SAM2-vlak → bbox van het quad.
 * Fallback: de detectiebox verticaal geklemd op plaatverhouding.
 */
export async function tightPlateBox(
  imageBytes: Buffer,
  cfg: PlateConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<PlateBox | null> {
  const meta = await sharp(imageBytes).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W === 0 || H === 0) return null;
  const boxes = await detectPlateBoxes(imageBytes, cfg, cacheDir, useCache);
  const box = boxes
    .filter((b) => b.w / Math.max(1, b.h) >= 1.2 && b.w / Math.max(1, b.h) <= 9)
    .filter((b) => b.y + b.h / 2 > H * 0.5)
    .sort((a, b) => b.w * b.h - a.w * a.h)[0];
  if (!box) return null;
  try {
    const maskPng = await segmentByBox(imageBytes, box, cfg, cacheDir, useCache);
    const raw = await sharp(maskPng)
      .resize(W, H, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    const quad = plateQuadFromMask(
      new Uint8Array(raw.buffer, raw.byteOffset, W * H), W, H, box,
    );
    if (quad) {
      const xs = [quad.tl.x, quad.tr.x, quad.bl.x, quad.br.x];
      const ys = [quad.tl.y, quad.tr.y, quad.bl.y, quad.br.y];
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
  } catch {
    // box-fallback hieronder
  }
  if (box.h > box.w / 3.2) {
    const nh = box.w / 3.2;
    return { x: box.x, y: box.y + (box.h - nh) / 2, w: box.w, h: nh };
  }
  return box;
}

/** Plaathouder-boxen in het beeld. */
export async function detectPlateBoxes(
  imageBytes: Buffer,
  cfg: PlateConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<PlateBox[]> {
  return florenceBoxes(
    imageBytes, cfg.detectPrompt, "plates", cfg.detectionModelId, cacheDir, useCache,
  );
}

/** SAM2-masker voor een box-prompt, gecachet. */
async function segmentByBox(
  imageBytes: Buffer,
  box: PlateBox,
  cfg: PlateConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(imageBytes)
    .update(JSON.stringify(box))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.segmask.png`);
  if (useCache && existsSync(cachePath)) {
    return readFile(cachePath);
  }
  const imageUrl = await uploadImage(imageBytes, "segment.jpg");
  const result = await fal.subscribe(cfg.segmentModelId, {
    input: {
      image_url: imageUrl,
      box_prompts: [{
        x_min: Math.round(box.x),
        y_min: Math.round(box.y),
        x_max: Math.round(box.x + box.w),
        y_max: Math.round(box.y + box.h),
      }],
      apply_mask: false,
      output_format: "png",
    },
  });
  const data = result.data as { image?: { url?: string } };
  if (!data.image?.url) {
    throw new Error(
      `SAM2 gaf geen masker terug: ${JSON.stringify(result.data).slice(0, 300)}`,
    );
  }
  const response = await fetch(data.image.url);
  if (!response.ok) {
    throw new Error(`download segmentmasker mislukt: HTTP ${response.status}`);
  }
  const mask = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, mask);
  return mask;
}

/**
 * Schat de vier hoekpunten van het plaatvlak uit een SAM2-masker.
 * Parallellogram-benadering: per kolom binnen de (ruime) detectiebox de
 * bovenste/onderste maskerpixel; de eerste en laatste kolomclusters geven
 * de linker- en rechterrand. Puur geometrie — geen generatieve stap.
 */
export function plateQuadFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  box: PlateBox,
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
  // echte plaathouders (recht tot schuin aangesneden) vallen hier ruim
  // binnen; een mislukte segmentatie (bumper, grille) valt erbuiten
  if (aspect < 1.5 || aspect > 9) return null;
  return { tl, tr, bl, br };
}

/**
 * Affine plaatsing van een W×H-asset op het quad-vlak: sharp's affine is
 * x' = a·x + b·y, y' = c·x + d·y. De asset-basisvectoren worden op de
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

export interface MountResult {
  image: Buffer;
  mounted: boolean;
  reason?: string;
}

/**
 * Monteert het Carredo-plaatasset deterministisch op de plaathouder in het
 * gegenereerde beeld. De tekst en het logo op de plaat mogen nooit uit het
 * model komen — leesbare tekens hertekenen gaat altijd mis. Daarom:
 * Florence vindt de houder, SAM2 geeft het plaatvlak, en het asset wordt er
 * met een affine warp op gelegd, in het perspectief van de bumper.
 *
 * Montage-look: het asset draagt het licht van het vlak waar het op hangt
 * (luminantie-sample boven de plaat), krijgt een smalle slagschaduw (een
 * plaat staat millimeters vóór de bumper) en een fractie blur zodat de rand
 * dezelfde scherpte heeft als de foto.
 */
export async function mountPlate(
  imageJpeg: Buffer,
  cfg: PlateConfig,
  cacheDir: string,
  useCache: boolean,
  /**
   * Bbox van de auto. Zonder deze grens landde de plaat op de BMW half naast
   * de bumper in de achtergrond: de detectie pakt op een blanco houder soms
   * een verkeerde zone (2026-08-03). Met de omtrek erbij kunnen we eisen dat
   * de plaat binnen de auto valt en niet breder is dan een echte plaat.
   */
  carBounds?: { left: number; top: number; width: number; height: number } | null,
): Promise<MountResult> {
  if (!existsSync(cfg.assetPath)) {
    return { image: imageJpeg, mounted: false, reason: `asset ontbreekt: ${cfg.assetPath}` };
  }
  const meta = await sharp(imageJpeg).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) {
    return { image: imageJpeg, mounted: false, reason: "beeld niet leesbaar" };
  }

  let boxes: PlateBox[];
  try {
    boxes = await detectPlateBoxes(imageJpeg, cfg, cacheDir, useCache);
  } catch (err) {
    return {
      image: imageJpeg,
      mounted: false,
      reason: `plaatdetectie mislukt: ${err instanceof Error ? err.message : err}`,
    };
  }
  // plausibel: plaatachtige verhouding, bescheiden oppervlak, onderste
  // beeldhelft (de houder zit op de bumper, niet in de grille of het dak)
  const candidates = boxes
    .filter((b) => b.w / Math.max(1, b.h) >= 1.5 && b.w / Math.max(1, b.h) <= 9)
    .filter((b) => (b.w * b.h) / (width * height) < 0.05)
    .filter((b) => b.y + b.h / 2 > height * 0.5)
    // binnen de auto blijven, en niet breder dan een echte plaat: een
    // Europese plaat is ~52 cm op een auto van ~1.9 m, dus hooguit een
    // derde van de koetsbreedte in beeld
    .filter((b) => {
      if (!carBounds) return true;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const inside =
        cx >= carBounds.left && cx <= carBounds.left + carBounds.width &&
        cy >= carBounds.top && cy <= carBounds.top + carBounds.height;
      return inside && b.w <= carBounds.width / 3;
    })
    .sort((a, b) => b.w * b.h - a.w * a.h);
  const box = candidates[0];
  if (!box) {
    return { image: imageJpeg, mounted: false, reason: "geen plaathouder gedetecteerd" };
  }

  // plaatvlak via SAM2; zonder bruikbaar quad valt de montage terug op de
  // rechte detectiebox — beter een vlakke plaat dan geen plaat
  let quad: PlateQuad | null = null;
  try {
    const maskPng = await segmentByBox(imageJpeg, box, cfg, cacheDir, useCache);
    const raw = await sharp(maskPng)
      .resize(width, height, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer();
    quad = plateQuadFromMask(
      new Uint8Array(raw.buffer, raw.byteOffset, width * height), width, height, box,
    );
  } catch {
    // stil: de box-fallback hieronder vangt het op
  }
  if (!quad) {
    quad = {
      tl: { x: box.x, y: box.y },
      tr: { x: box.x + box.w, y: box.y },
      bl: { x: box.x, y: box.y + box.h },
      br: { x: box.x + box.w, y: box.y + box.h },
    };
  }

  // het asset behoudt zijn eigen verhouding en moet de gegenereerde plaat
  // VOLLEDIG bedekken — het model tekent er soms een EU-band of landletter
  // bij, en die mag nooit naast het asset blijven uitsteken. Daarom wordt
  // de badge opgebouwd vanuit de detectiebox (dekking), met de
  // randrichtingen van het SAM2-vlak (perspectief): centrum op de box,
  // breedte ruim over de box heen, hoogte volgt het asset
  const asset = await readFile(cfg.assetPath);
  const assetMeta = await sharp(asset).metadata();
  const assetAspect = (assetMeta.width ?? 1220) / (assetMeta.height ?? 290);
  const wSpan = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const ySpan =
    Math.max(quad.bl.y, quad.br.y) - Math.min(quad.tl.y, quad.tr.y);
  const norm = (dx: number, dy: number): Point => {
    const len = Math.max(1e-6, Math.hypot(dx, dy));
    return { x: dx / len, y: dy / len };
  };
  const u = norm(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const v = norm(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // breed genoeg voor de boxbreedte én (via de asset-verhouding) de
  // boxhoogte — dan is de hele gegenereerde plaat per constructie bedekt
  const W = Math.max(box.w * 1.06, box.h * assetAspect * 1.04);
  const H = W / assetAspect;
  const badgeQuad: PlateQuad = {
    tl: { x: cx - (u.x * W) / 2 - (v.x * H) / 2, y: cy - (u.y * W) / 2 - (v.y * H) / 2 },
    tr: { x: cx + (u.x * W) / 2 - (v.x * H) / 2, y: cy + (u.y * W) / 2 - (v.y * H) / 2 },
    bl: { x: cx - (u.x * W) / 2 + (v.x * H) / 2, y: cy - (u.y * W) / 2 + (v.y * H) / 2 },
    br: { x: cx + (u.x * W) / 2 + (v.x * H) / 2, y: cy + (u.y * W) / 2 + (v.y * H) / 2 },
  };

  const w = Math.max(
    8,
    Math.round(Math.hypot(badgeQuad.tr.x - badgeQuad.tl.x, badgeQuad.tr.y - badgeQuad.tl.y)),
  );
  const h = Math.max(4, Math.round(w / assetAspect));
  const flat = await sharp(asset).resize(w, h, { fit: "fill" }).png().toBuffer();

  // lokale belichting van het vlak boven de plaat
  let lit = flat;
  const stripH = Math.max(4, Math.round(ySpan * 0.5));
  const sx = Math.max(0, Math.floor(Math.min(quad.tl.x, quad.bl.x)));
  const sw = Math.min(width - sx, Math.max(8, Math.ceil(wSpan)));
  const sy = Math.max(0, Math.floor(Math.min(quad.tl.y, quad.tr.y)) - stripH);
  if (sw >= 8 && sy + stripH <= height) {
    const strip = await sharp(imageJpeg)
      .extract({ left: sx, top: sy, width: sw, height: stripH })
      .greyscale()
      .stats();
    const factor = Math.min(1.05, Math.max(0.7, (strip.channels[0]?.mean ?? 170) / 170));
    lit = await sharp(flat)
      .linear([factor, factor, factor, 1], [0, 0, 0, 0])
      .png()
      .toBuffer();
  }

  const place = affinePlacementForQuad(badgeQuad, w, h);
  const warped = await sharp(lit)
    .affine(place.matrix, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      interpolator: "bicubic",
    })
    .blur(0.4)
    .png()
    .toBuffer();

  // slagschaduw: badge-polygon 2-3px verschoven, geblurd
  const xs = [badgeQuad.tl.x, badgeQuad.tr.x, badgeQuad.bl.x, badgeQuad.br.x];
  const ys = [badgeQuad.tl.y, badgeQuad.tr.y, badgeQuad.bl.y, badgeQuad.br.y];
  const bx = Math.max(0, Math.floor(Math.min(...xs)) - 6);
  const by = Math.max(0, Math.floor(Math.min(...ys)) - 6);
  const bw = Math.min(width, Math.ceil(Math.max(...xs)) + 6) - bx;
  const bh = Math.min(height, Math.ceil(Math.max(...ys)) + 6) - by;
  const shPoly = [badgeQuad.tl, badgeQuad.tr, badgeQuad.br, badgeQuad.bl]
    .map((p) => `${(p.x - bx + 2).toFixed(1)},${(p.y - by + 3).toFixed(1)}`)
    .join(" ");
  const shadow = await sharp(
    Buffer.from(
      `<svg width="${bw}" height="${bh}" xmlns="http://www.w3.org/2000/svg">` +
        `<polygon points="${shPoly}" fill="black" fill-opacity="0.38"/></svg>`,
    ),
  )
    .blur(2.2)
    .png()
    .toBuffer();

  // Eerst het oude plaatvlak dichtschilderen, dan pas het asset erop. Zonder
  // die stap schemeren restanten van de plaat die het model zélf tekende door
  // langs de randen — verkeerde letters, een blauwe EU-band die er niet hoort.
  // Zo hoeft een mislukte modelplaat ook nooit meer een poging te kosten: we
  // maken er eenvoudig eerst een blanco houder van (Yentl, 2026-08-03).
  const blankPoly = [badgeQuad.tl, badgeQuad.tr, badgeQuad.br, badgeQuad.bl]
    .map((p) => `${(p.x - bx).toFixed(1)},${(p.y - by).toFixed(1)}`)
    .join(" ");
  const blank = await sharp(
    Buffer.from(
      `<svg width="${bw}" height="${bh}" xmlns="http://www.w3.org/2000/svg">` +
        `<polygon points="${blankPoly}" fill="#f2f2f0" stroke="#f2f2f0" ` +
        `stroke-width="6"/></svg>`,
    ),
  )
    .blur(0.6)
    .png()
    .toBuffer();

  const image = await sharp(imageJpeg)
    .composite([
      { input: shadow, left: bx, top: by },
      { input: blank, left: bx, top: by },
      { input: warped, left: Math.max(0, place.left), top: Math.max(0, place.top) },
    ])
    .jpeg({ quality: 96 })
    .toBuffer();
  return { image, mounted: true };
}
