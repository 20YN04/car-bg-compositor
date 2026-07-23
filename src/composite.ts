import sharp from "sharp";
import type { BBox, ContactCluster } from "./bbox.js";
import type { BackgroundProfile, CanvasSize, Config } from "./config.js";

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
    const ry = cfg.SHADOW.height * 0.3;
    return {
      cx: placement.x + (centerX - bbox.left) * placement.scale,
      // iets onder het contactpunt zodat de donkere poel zichtbaar blijft
      // onder de band in plaats van erachter te verdwijnen
      cy:
        placement.y +
        (c.y - bbox.top + 1) * placement.scale +
        cfg.SHADOW.offsetY +
        ry * 0.4,
      rx: (clusterWidth / 2) * 1.6,
      ry,
    };
  });
}

function ambientShadowSvg(
  canvas: CanvasSize,
  placement: Placement,
  groundY: number,
  cfg: Config,
  hasContacts: boolean,
  profile: BackgroundProfile,
): Buffer {
  const s = cfg.SHADOW;
  // schaduw verschuift van het licht weg: lichtDirX < 0 (licht van links)
  // duwt de schaduw naar rechts
  const lightShift = -profile.lightDirX;
  const cx =
    placement.x + placement.width / 2 + s.offsetX + lightShift * placement.width * 0.05;
  const cy = groundY + s.offsetY;
  const rx = (placement.width * s.widthRatio) / 2;
  const ry = s.height / 2;
  // met contactclusters wordt de brede ellips een zachte ambient-schaduw en
  // draagt de aparte contactlaag het eigenlijke contact; zonder clusters
  // (fallback) blijft het oude gedrag: één ellips op volle sterkte
  const ambientOpacity = hasContacts ? s.opacity * 0.55 : s.opacity;
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black" fill-opacity="${ambientOpacity}"/>` +
      `</svg>`,
  );
}

function contactShadowSvg(
  canvas: CanvasSize,
  cfg: Config,
  contacts: ShadowEllipse[],
  profile: BackgroundProfile,
): Buffer {
  const s = cfg.SHADOW;
  const lightShift = -profile.lightDirX;
  // zachte poel per wiel: donkerst op het contactpunt, radiaal uitvloeiend —
  // geen harde ellipsrand. Dit verankert de band visueel op de vloer en
  // vangt de zachte maskertaper bij het contactpunt op.
  const opacity = Math.min(0.7, s.opacity * 1.5);
  const defs = contacts
    .map(
      (_, i) =>
        `<radialGradient id="cs${i}" cx="50%" cy="50%" r="50%">` +
        `<stop offset="0%" stop-color="black" stop-opacity="${opacity}"/>` +
        `<stop offset="45%" stop-color="black" stop-opacity="${(opacity * 0.55).toFixed(3)}"/>` +
        `<stop offset="100%" stop-color="black" stop-opacity="0"/>` +
        `</radialGradient>`,
    )
    .join("");
  const shapes = contacts
    .map(
      (c, i) =>
        `<ellipse cx="${c.cx + lightShift * c.ry * 1.5}" cy="${c.cy}" rx="${c.rx * 1.25}" ry="${c.ry * 1.4}"` +
        ` fill="url(#cs${i})"/>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs>${defs}</defs>${shapes}</svg>`,
  );
}

export interface ReflectionRect {
  left: number; // positie op het canvas
  top: number;
  width: number;
  height: number; // zichtbare (geklemde) hoogte
}

/** Geometrie van de vloerreflectie: gespiegeld vanaf de contactlijn omlaag. */
export function computeReflectionRect(
  placement: Placement,
  contactY: number,
  canvas: CanvasSize,
  reflectionHeightRatio: number,
): ReflectionRect | null {
  const height = Math.round(placement.height * reflectionHeightRatio);
  const left = Math.max(0, Math.round(placement.x));
  const width = Math.min(
    Math.round(placement.width),
    canvas.width - left,
  );
  const visibleHeight = Math.min(height, canvas.height - contactY);
  if (visibleHeight <= 2 || width <= 0) return null;
  return { left, top: contactY, width, height: visibleHeight };
}

export interface CompositeInput {
  rgba: Buffer; // raw RGBA van de cutout (origineel formaat)
  width: number;
  height: number;
  bbox: BBox;
  placement: Placement;
  backgroundPath: string;
  contactShadows?: ShadowEllipse[]; // per wielcontact, uit buildContactShadows
  profile: BackgroundProfile;
  contactY: number; // canvas-y van de contactlijn (voor de vloerreflectie)
}

/**
 * Composite: achtergrond → schaduw (multiply) → auto. Geeft een PNG-buffer
 * terug zodat de plaat-anonimisatie verliesvrij kan volgen; de aanroeper
 * encodeert daarna éénmalig naar JPEG.
 */
export async function compositeImage(
  input: CompositeInput,
  cfg: Config,
): Promise<Buffer> {
  const { rgba, width, height, bbox, placement, backgroundPath } = input;
  const canvas = cfg.CANVAS;

  const p = input.profile;
  let bgPipe = sharp(backgroundPath)
    .resize(canvas.width, canvas.height, { fit: "cover" })
    .removeAlpha();
  // toon: referentielook is een tikje donkerder/warmer — puur per-kanaal gain
  if (p.toneBrightness !== 1 || p.toneWarmth !== 0) {
    bgPipe = bgPipe.linear(
      [
        p.toneBrightness * (1 + p.toneWarmth),
        p.toneBrightness,
        p.toneBrightness * (1 - p.toneWarmth),
      ],
      [0, 0, 0],
    );
  }
  // zachte gloed/hotspot achter de auto (screen) + lichte hoekvignette
  const glowCx = placement.x + placement.width / 2;
  const glowCy = input.contactY - placement.height * 0.45;
  const atmosphere = Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs>` +
      `<radialGradient id="glow" cx="50%" cy="50%" r="50%">` +
      `<stop offset="0%" stop-color="white" stop-opacity="${p.glowStrength}"/>` +
      `<stop offset="100%" stop-color="white" stop-opacity="0"/>` +
      `</radialGradient>` +
      `</defs>` +
      `<ellipse cx="${glowCx}" cy="${glowCy}" rx="${placement.width * 0.85}" ry="${placement.height * 0.8}" fill="url(#glow)"/>` +
      `</svg>`,
  );
  const vignette = Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs>` +
      `<radialGradient id="vig" cx="50%" cy="46%" r="72%">` +
      `<stop offset="0%" stop-color="black" stop-opacity="0"/>` +
      `<stop offset="70%" stop-color="black" stop-opacity="0"/>` +
      `<stop offset="100%" stop-color="black" stop-opacity="${p.vignetteStrength}"/>` +
      `</radialGradient>` +
      `</defs>` +
      `<rect width="100%" height="100%" fill="url(#vig)"/>` +
      `</svg>`,
  );
  const background = await bgPipe
    .composite([
      { input: atmosphere, blend: "screen" },
      { input: vignette, blend: "multiply" },
    ])
    .toBuffer();

  const contacts = input.contactShadows ?? [];
  const shadow = await sharp(
    ambientShadowSvg(
      canvas, placement, input.contactY, cfg, contacts.length > 0, input.profile,
    ),
  )
    .blur(cfg.SHADOW.blur * input.profile.lightSoftness)
    .png()
    .toBuffer();
  const contactShadow =
    contacts.length > 0
      ? await sharp(contactShadowSvg(canvas, cfg, contacts, input.profile))
          .blur(3)
          .png()
          .toBuffer()
      : null;

  const scaledW = Math.max(1, Math.round(placement.width));
  const scaledH = Math.max(1, Math.round(placement.height));
  let carPipe = sharp(rgba, { raw: { width, height, channels: 4 } })
    .extract({
      left: bbox.left,
      top: bbox.top,
      width: bbox.right - bbox.left + 1,
      height: bbox.bottom - bbox.top + 1,
    })
    .resize(scaledW, scaledH);
  // het her-schalen verzacht; een milde sharpen houdt de outline en details strak
  if (cfg.CAR_SHARPEN_SIGMA > 0) {
    carPipe = carPipe.sharpen({ sigma: cfg.CAR_SHARPEN_SIGMA });
  }
  let car = await carPipe.png().toBuffer();

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

  const layers: sharp.OverlayOptions[] = [{ input: shadow, blend: "multiply" }];
  if (contactShadow) layers.push({ input: contactShadow, blend: "multiply" });

  // vloerreflectie: verticaal gespiegelde uitsnede onder de contactlijn met
  // snelle opacity-fade — puur flip + gradientmasker + blur
  const rect = computeReflectionRect(
    placement, input.contactY, canvas, input.profile.reflectionHeightRatio,
  );
  if (rect && input.profile.floorReflectivity > 0.01) {
    const meta = await sharp(car).metadata();
    const cropW = Math.min(rect.width, meta.width ?? rect.width);
    const cropH = Math.min(rect.height, meta.height ?? rect.height);
    const gradient = Buffer.from(
      `<svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="white" stop-opacity="${input.profile.floorReflectivity}"/>` +
        `<stop offset="1" stop-color="white" stop-opacity="0"/>` +
        `</linearGradient></defs>` +
        `<rect width="100%" height="100%" fill="url(#g)"/></svg>`,
    );
    const reflection = await sharp(car)
      .flip()
      .extract({ left: 0, top: 0, width: cropW, height: cropH })
      .composite([{ input: gradient, blend: "dest-in" }])
      .blur(2)
      .png()
      .toBuffer();
    layers.push({ input: reflection, left, top: rect.top });
  }

  layers.push({ input: car, left, top });
  return sharp(background).composite(layers).png().toBuffer();
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
