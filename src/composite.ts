import sharp from "sharp";
import type { BBox, ContactCluster } from "./bbox.js";
import { grainGapSigma, grainLevel } from "./harmonize.js";
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

/**
 * Ambient-schaduw uit het autosilhouet: het alfakanaal van de geschaalde auto
 * wordt verticaal platgedrukt tot een dunne band en zwaar geblurd. De schaduw
 * volgt zo de werkelijke onderlijn (neusoverhang, wielbasis) in plaats van een
 * ellips die als grijze blob naast de auto uitsteekt. Puur mathematisch.
 */
async function silhouetteShadow(
  car: Buffer,
  scaledW: number,
  canvas: CanvasSize,
  carLeft: number,
  contactY: number,
  cfg: Config,
  hasContacts: boolean,
  profile: BackgroundProfile,
): Promise<Buffer> {
  const s = cfg.SHADOW;
  const shH = Math.max(24, Math.round(s.height));
  const opacity = hasContacts ? s.opacity * 0.6 : s.opacity;
  const mask = await sharp(car)
    .ensureAlpha()
    .extractChannel(3)
    .resize(scaledW, shH, { fit: "fill" })
    .raw()
    .toBuffer();
  const px = Buffer.alloc(scaledW * shH * 4);
  for (let i = 0; i < scaledW * shH; i++) {
    px[i * 4 + 3] = Math.round((mask[i] ?? 0) * opacity);
  }
  const lightShift = -profile.lightDirX;
  const left = Math.round(
    carLeft + s.offsetX + lightShift * scaledW * 0.03,
  );
  // band straddlet de contactlijn: het grootste deel valt eronder, een klein
  // deel erboven zodat de donkerte onder de dorpels doorloopt
  const top = Math.round(contactY + s.offsetY - shH * 0.45);
  return sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      {
        input: px,
        raw: { width: scaledW, height: shH, channels: 4 },
        left: Math.max(0, left),
        top: Math.max(0, top),
      },
    ])
    .png()
    .toBuffer();
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
  const opacity = Math.min(0.6, s.opacity * 1.15);
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
        `<ellipse cx="${c.cx + lightShift * c.ry * 1.5}" cy="${c.cy}" rx="${c.rx * 1.1}" ry="${c.ry * 1.15}"` +
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

export interface CompositeResult {
  image: Buffer; // PNG van het volledige composiet
  /** De geschaalde/gecropte autolaag + positie, zodat een generatieve
   * scène-stap de originele autopixels er pixel-exact terug op kan leggen. */
  carLayer: { input: Buffer; left: number; top: number };
}

/**
 * Composite: achtergrond → schaduw (multiply) → auto. Geeft een PNG-buffer
 * terug zodat de plaat-anonimisatie verliesvrij kan volgen; de aanroeper
 * encodeert daarna éénmalig naar JPEG.
 */
export async function compositeImage(
  input: CompositeInput,
  cfg: Config,
): Promise<CompositeResult> {
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
  // Sharpen alleen bij een échte vergroting. Opschalen verzacht, en daar wint
  // een milde sharpen detail terug. Bij gelijke schaal of verkleining wint hij
  // niets en versterkt hij alleen sensorruis: gemeten op de Taycan-set ging de
  // korrel van 1,5 in de bron naar 5,75 in de uitvoer, tegen 0,3 op de
  // achtergrondplate. Dat korrelverschil is precies wat een composiet als
  // "uitgeknipt" laat lezen.
  if (cfg.CAR_SHARPEN_SIGMA > 0 && placement.scale > 1.05) {
    // bij 2× opschalen de volle sigma, daaronder evenredig minder
    const amount = Math.min(1, (placement.scale - 1.05) / 0.95);
    carPipe = carPipe.sharpen({ sigma: cfg.CAR_SHARPEN_SIGMA * amount });
  }
  let car = await carPipe.png().toBuffer();

  // ambient-schaduw uit het (volledige, ongecropte) autosilhouet
  const shadow = await sharp(
    await silhouetteShadow(
      car, scaledW, canvas, Math.round(placement.x), input.contactY, cfg,
      contacts.length > 0, input.profile,
    ),
  )
    .blur(cfg.SHADOW.blur * input.profile.lightSoftness)
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
    // flip en extract MOETEN in aparte pipelines: sharp voert extract uit vóór
    // de flip, ongeacht de aanroepvolgorde. In één keten leverde dit de
    // bovenste cropH rijen (het dak) gespiegeld onder de wielen in plaats van
    // de onderkant van de auto.
    const flipped = await sharp(car).flip().png().toBuffer();
    const reflection = await sharp(flipped)
      .extract({ left: 0, top: 0, width: cropW, height: cropH })
      .composite([{ input: gradient, blend: "dest-in" }])
      .blur(2)
      .png()
      .toBuffer();
    layers.push({ input: reflection, left, top: rect.top });
  }

  layers.push({ input: car, left, top });
  let image = await sharp(background).composite(layers).png().toBuffer();

  if (cfg.GRAIN.enabled) {
    image = await matchBackgroundGrain(
      image,
      car,
      { left, top, width: scaledW, height: scaledH },
      canvas,
      cfg,
    );
  }
  return { image, carLayer: { input: car, left, top } };
}

/**
 * Korrel gelijktrekken tussen auto en plate.
 *
 * De auto komt van een cameraruis-dragende opname, de plate is glad. Gemeten
 * op de Taycan-set: paneel 3,9 tegen vloer 1,2 en wand 0,3. Dat verschil in
 * ruisniveau is een van de sterkste signalen dat twee lagen niet uit dezelfde
 * opname komen — het oog leest het als uitgeknipt, ook als de rand perfect is.
 *
 * We voegen ruis toe aan de scène, niet aan de auto: de auto verzachten zou
 * detail kosten en dat is precies wat deze pipeline belooft te behouden.
 * De ruis gaat er vóór de finishing grade overheen, zodat beide lagen daarna
 * dezelfde curve krijgen en in de pas blijven.
 */
async function matchBackgroundGrain(
  image: Buffer,
  car: Buffer,
  carRect: { left: number; top: number; width: number; height: number },
  canvas: CanvasSize,
  cfg: Config,
): Promise<Buffer> {
  const grey = await sharp(image).greyscale().raw().toBuffer();

  // meetvenster op de auto: ruim binnen de bbox, weg van de randen
  const inset = (r: typeof carRect, f: number) => ({
    x: Math.round(r.left + r.width * f),
    y: Math.round(r.top + r.height * f),
    w: Math.max(8, Math.round(r.width * (1 - 2 * f))),
    h: Math.max(8, Math.round(r.height * (1 - 2 * f))),
  });
  const carWin = inset(carRect, 0.3);
  const carGrain = grainLevel(grey, canvas.width, carWin.x, carWin.y, carWin.w, carWin.h);

  // meetvenster op de plate: linkerstrook, buiten de auto
  const bgW = Math.max(16, Math.min(240, Math.round(carRect.left * 0.6)));
  const plateGrain =
    bgW >= 16
      ? grainLevel(grey, canvas.width, 8, Math.round(canvas.height * 0.25), bgW, 200)
      : 0;

  const sigma = grainGapSigma(carGrain, plateGrain) * cfg.GRAIN.strength;
  if (sigma < 0.5) return image;

  // deterministische ruis: dezelfde invoer geeft hetzelfde beeld, anders is
  // geen enkele regressietest op de uitvoer nog betrouwbaar
  const n = canvas.width * canvas.height;
  const noise = Buffer.alloc(n * 4);
  let seed = cfg.GRAIN.seed >>> 0;
  const rnd = (): number => {
    // xorshift32
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < n; i++) {
    // Box-Muller voor normaalverdeelde ruis; uniform zou als dither lezen
    const u = Math.max(1e-6, rnd());
    const v = rnd();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sigma;
    const c = Math.max(0, Math.min(255, Math.round(128 + g)));
    noise[i * 4] = c;
    noise[i * 4 + 1] = c;
    noise[i * 4 + 2] = c;
    noise[i * 4 + 3] = 255;
  }
  const noisePng = await sharp(noise, {
    raw: { width: canvas.width, height: canvas.height, channels: 4 },
  })
    .png()
    .toBuffer();

  // 128 is neutraal voor overlay-blending. Dat neutrale vlak moet exact de
  // AUTOVORM volgen, niet zijn bounding box: op de bbox maskeren laat een
  // zichtbare lichtere rechthoek rond de auto achter, want binnen die box
  // kwam geen korrel en erbuiten wel.
  const meta = await sharp(car).metadata();
  const shapeW = meta.width ?? carRect.width;
  const shapeH = meta.height ?? carRect.height;
  const neutralShape = await sharp({
    create: {
      width: shapeW,
      height: shapeH,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 1 },
    },
  })
    .composite([
      {
        input: await sharp(car).ensureAlpha().extractChannel(3).png().toBuffer(),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

  const maskedNoise = await sharp(noisePng)
    .composite([{ input: neutralShape, left: carRect.left, top: carRect.top }])
    .png()
    .toBuffer();

  return sharp(image)
    .composite([{ input: maskedNoise, blend: "overlay" }])
    .png()
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
