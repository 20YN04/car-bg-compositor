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
  horizontalBias = 0.5,
): Placement {
  const bboxWidth = bbox.right - bbox.left + 1;
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const scale = (canvas.width * carWidthRatio) / bboxWidth;
  const width = bboxWidth * scale;
  const height = bboxHeight * scale;
  // bias 0,5 = gecentreerd. De cutout-referenties zetten het middelpunt op
  // ~45%, links van het midden, zodat er rechts ruimte overblijft voor de
  // plaat en de badge.
  const x = canvas.width * horizontalBias - width / 2;
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
  shadowScale = 1,
): ShadowEllipse[] {
  return clusters.map((c) => {
    const centerX = (c.x0 + c.x1) / 2;
    const clusterWidth = (c.x1 - c.x0 + 1) * placement.scale;
    const ry = cfg.SHADOW.height * 0.3 * shadowScale;
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
  const shH = Math.max(10, Math.round(s.height * profile.shadowHeightScale));
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
  // contactY komt uit de wielmeting en is zelden rond. Eerst afronden, dán
  // klemmen: andersom levert de clamp een gebroken hoogte zodra de reflectie
  // de onderrand raakt, en sharp weigert die.
  const top = Math.round(contactY);
  const visibleHeight = Math.min(height, canvas.height - top);
  if (visibleHeight <= 2 || width <= 0) return null;
  return { left, top, width, height: visibleHeight };
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
    .blur(cfg.SHADOW.blur * input.profile.lightSoftness * input.profile.shadowBlurScale)
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
    const base = await sharp(flipped)
      .extract({ left: 0, top: 0, width: cropW, height: cropH })
      .composite([{ input: gradient, blend: "dest-in" }])
      .png()
      .toBuffer();
    // Oplopende blur naar beneden i.p.v. één uniforme. Een spiegeling in een
    // vloer wordt onscherper met de afstand: microruwheid verstrooit het licht
    // over een grotere hoek naarmate de weg langer is. Een even scherpe
    // spiegeling over de hele diepte leest als een tweede laag, niet als een
    // reflectie. Twee lagen met een verloop ertussen benaderen dat zonder de
    // kosten van een echte per-rij blur.
    const reflection = cfg.DOF.enabled
      ? await sharp(base)
          .blur(cfg.DOF.reflectionNearBlur)
          .composite([
            {
              input: await sharp(base)
                .blur(cfg.DOF.reflectionFarBlur)
                .composite([
                  {
                    input: Buffer.from(
                      `<svg width="${cropW}" height="${cropH}" xmlns="http://www.w3.org/2000/svg">` +
                        `<defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1">` +
                        `<stop offset="0" stop-color="white" stop-opacity="0"/>` +
                        `<stop offset="1" stop-color="white" stop-opacity="1"/>` +
                        `</linearGradient></defs>` +
                        `<rect width="100%" height="100%" fill="url(#d)"/></svg>`,
                    ),
                    blend: "dest-in",
                  },
                ])
                .png()
                .toBuffer(),
            },
          ])
          .png()
          .toBuffer()
      : await sharp(base).blur(2).png().toBuffer();
    layers.push({ input: reflection, left, top: rect.top });
  }

  layers.push({ input: car, left, top });
  if (cfg.LIGHTWRAP.enabled) {
    const wrap = await buildLightWrap(background, car, left, top, canvas, cfg);
    if (wrap) layers.push(wrap);
  }
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
 * Light wrap: het licht van de scène een paar pixels de auto in laten bloeden.
 *
 * In een echte opname verlicht de omgeving het onderwerp ook langs de rand —
 * de wand achter de auto werpt licht op de flanken. Een alfacomposiet mist dat
 * volledig: er staat een mesrand tussen twee lagen. Gemeten op de daklijn van
 * de Taycan-set ging de overgang van 152 naar 31 in twee pixels, zonder enige
 * tussenwaarde. Dat leest als geplakt, ook als de rand technisch perfect is.
 *
 * Standaardtechniek uit compositing: neem de achtergrond, blur die, en laat
 * hem alleen binnen een smalle band langs de binnenrand van het alfa
 * doorkomen. `screen` licht op zonder detail te verdringen, en de band is
 * begrensd tot de auto zelf — buiten het masker verandert er niets.
 */
async function buildLightWrap(
  background: Buffer,
  car: Buffer,
  left: number,
  top: number,
  canvas: CanvasSize,
  cfg: Config,
): Promise<sharp.OverlayOptions | null> {
  const meta = await sharp(car).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 8 || h < 8) return null;

  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const pw = Math.min(w, canvas.width - x0);
  const ph = Math.min(h, canvas.height - y0);
  if (pw < 8 || ph < 8) return null;

  const alpha = await sharp(car).ensureAlpha().extractChannel(3).png().toBuffer();
  // randband = alfa min een geblurde (dus gekrompen) versie van zichzelf. Waar
  // het alfa vol is, heffen die elkaar op; alleen langs de rand blijft er wat
  // over. Precies de zone waar het omgevingslicht hoort te bloeden.
  const shrunk = await sharp(alpha).blur(cfg.LIGHTWRAP.width).png().toBuffer();
  const band = await sharp(alpha)
    .composite([{ input: shrunk, blend: "difference" }])
    .linear([cfg.LIGHTWRAP.strength * 2], [0])
    .resize(pw, ph, { fit: "fill" })
    // strikt één kanaal: extractChannel levert grijs MET alfa (2 kanalen), en
    // joinChannel verwacht precies het aantal dat het doelbeeld mist
    .removeAlpha()
    .toColourspace("b-w")
    .png()
    .toBuffer();

  // het licht zelf: de achtergrond op deze plek, zwaar geblurd zodat er kleur
  // en helderheid overkomt maar geen herkenbare structuur
  const bgPatch = await sharp(background)
    .extract({ left: x0, top: y0, width: pw, height: ph })
    .blur(cfg.LIGHTWRAP.blur)
    .removeAlpha()
    .png()
    .toBuffer();

  // de band MOET het alfakanaal worden, niet een overlay: een dest-in met een
  // grijswaarde-PNG maskeert op diens alfa (overal 255) en laat de wrap dan
  // over de hele auto komen in plaats van alleen over de randband
  const wrap = await sharp(bgPatch).joinChannel(band).png().toBuffer();

  return { input: wrap, left: x0, top: y0, blend: "screen" };
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

/**
 * Schaal uit de gemeten wieldiameter.
 *
 * De oude schaal legde de bbox-breedte op een vaste fractie van het canvas.
 * Maar hoeveel auto er in die bbox zit hangt van de kijkhoek af: een
 * zijaanzicht toont ~4,4 m lengte, een vooraanzicht ~1,9 m breedte. Gemeten
 * over de Taycan-set liep de bbox-aspect van 1,45 tot 3,20 terwijl de
 * widthRatio op alle dertien beelden exact 0,720 stond — het vooraanzicht
 * werd dus fors groter uitgerekt dan het zijaanzicht.
 *
 * Een wiel is een betere maatlat: vaste maat in meters, zichtbaar in vrijwel
 * elke exterieuropname, en ongevoelig voor zowel de kijkhoek als voor een
 * bronfoto waarin de auto deels buiten beeld valt.
 *
 * Het NABIJE wiel telt (het grootste): dat ligt het dichtst bij de
 * contactdiepte waarop `floorScaleRef` gekalibreerd is.
 */
export function scaleFromWheel(
  wheelBoxes: { x: number; y: number; w: number; h: number }[],
  nominalWheelMeters: number,
  floorScaleRef: number,
): number | null {
  let widest = 0;
  for (const b of wheelBoxes) {
    // diameter ~ de grootste zijde: een wiel is rond, maar de box kan bij een
    // schuine hoek in de breedte samengedrukt zijn
    const d = Math.max(b.w, b.h);
    if (d > widest) widest = d;
  }
  if (widest < 8) return null;
  const targetPx = nominalWheelMeters * floorScaleRef;
  return targetPx / widest;
}

/**
 * Contactlijn verdiepen zodat ook het verste wiel op de vloer landt.
 *
 * Bij een sterke 3/4-hoek staat het verre wiel door het perspectief van de
 * bronopname fors hoger in beeld dan het nabije — op de Taycan-set liep dat op
 * tot 300px. Met een vaste contactlijn belandt dat wiel boven de
 * wand/vloerovergang van de plate: de auto staat dan met één wiel op de muur.
 *
 * De config loste dat op met een handmatig verdiepte contactTargetY (1195 in
 * plaats van 1150) die voor élke hoek geldt, ook voor zijaanzichten die het
 * niet nodig hebben. Dat is te meten in plaats van te gokken: we weten waar
 * elk wielcontact na plaatsing landt en waar de horizon van de plate ligt.
 *
 * Retourneert de aangepaste contactlijn, of de originele als er niets hoeft.
 */
export function contactYForWheels(
  clusters: ContactCluster[],
  bbox: BBox,
  contactY: number,
  scale: number,
  placementY: number,
  horizonY: number | null,
  margin: number,
): number {
  if (horizonY === null || clusters.length === 0) return contactY;
  // hoogste (= verste) wielcontact na plaatsing
  let highest = Infinity;
  for (const c of clusters) {
    const y = placementY + (c.y - bbox.top + 1) * scale;
    if (y < highest) highest = y;
  }
  if (!Number.isFinite(highest)) return contactY;
  const minimum = horizonY + margin;
  if (highest >= minimum) return contactY;
  // alles zakt mee met hetzelfde verschil, dus de auto blijft intact staan
  return contactY + (minimum - highest);
}

export interface SweepParams {
  horizonRatio: number; // y van de wand/vloerovergang als fractie van de hoogte
  /**
   * Verticaal profiel van de wand in het midden: luminantie op hoogtes
   * uitgedrukt als fractie van de wandband (0 = bovenrand, 1 = horizon).
   *
   * Een verzadigende curve, geen rechte lijn: gemeten stijgt de wand snel en
   * vlakt dan af. Een lineair verloop dat door de twee gemeten uiteinden gaat
   * zou bij de horizon op ~304 uitkomen — een wit gat achter de auto.
   */
  wallStops: { at: number; lum: number }[];
  /**
   * Vignettering aan de zijkanten als fractie zwart (0..1) op de uiterste rand,
   * per hoogte — niet als vaste kleur en niet als één getal.
   *
   * Vermenigvuldigen in plaats van naar een kleur trekken houdt het verband
   * intact: de gemeten randen lopen mee omhoog met het midden (102 bovenaan
   * naar 160 lager), en dat doet een vaste kleur niet.
   *
   * Per hoogte, want de gemeten vignettering is een boog: 0,33 bovenaan, het
   * diepst met 0,42 rond y=100, en weer 0,31 bij de horizon. Eén vast getal
   * zat er in de middenband 17 tot 26 niveaus naast.
   */
  wallVignetteStops: { at: number; v: number }[];
  /** Luminantie van de vloer direct onder de naad. Gemeten ~138. */
  floorSeam: number;
  /** Luminantie van de vloer onderaan het beeld, in het midden. Gemeten ~128. */
  floorBottom: number;
  /**
   * Hoeveel donkerder de onderhoeken zijn. Deze vignettering groeit naar
   * beneden toe: vlak onder de naad is de rand juist niet donkerder dan het
   * midden (128 tegen 118), onderaan wel (93 tegen 128).
   */
  floorCornerVignette: number;
  /** Hoeveel de lichtpoel onder de auto bovenop de basis legt. Gemeten ~75. */
  poolGain: number;
  poolCentreRatio: number; // y van de poelkern als fractie van de vloerband
  poolWidthRatio: number; // horizontale spreiding als fractie van de breedte
  poolHeightRatio: number; // verticale spreiding als fractie van de vloerband
  /**
   * De vouwlijn waar wand en vloer samenkomen. Een cyclorama heeft daar een
   * zachte schaduw: gemeten zakt de naad naar 114 terwijl er 148 boven en 130
   * onder staat. Zonder die lijn oogt de overgang als twee aan elkaar geplakte
   * vlakken in plaats van als een doorlopend oppervlak.
   */
  creaseDepth: number;
  creaseSigma: number; // in px
}

/**
 * Luminantie van de studio-sweep op één pixel.
 *
 * Losgetrokken van het schrijven naar bestand zodat het profiel te meten is
 * zonder een PNG te hoeven decoderen — de tests toetsen hierop tegen de
 * gemeten waarden van de referentie.
 */
export function sweepLuminance(
  x: number,
  y: number,
  canvas: CanvasSize,
  p: SweepParams,
): number {
  const horizon = canvas.height * p.horizonRatio;
  // 0 in het midden, 1 aan de zijrand; de middelste ~16% blijft onaangeroerd
  const u = Math.abs(x / canvas.width - 0.5);
  const side = Math.max(0, Math.min(1, (u - 0.08) / 0.42));

  let value: number;
  if (y < horizon) {
    const t = y / horizon;
    // piecewise lineair door de gemeten stops
    let lum = p.wallStops[0]?.lum ?? 0;
    for (let i = 1; i < p.wallStops.length; i++) {
      const a = p.wallStops[i - 1];
      const b = p.wallStops[i];
      if (!a || !b) continue;
      if (t <= b.at) {
        const span = Math.max(1e-6, b.at - a.at);
        lum = a.lum + (b.lum - a.lum) * Math.min(1, (t - a.at) / span);
        break;
      }
      lum = b.lum;
    }
    let vig = p.wallVignetteStops[0]?.v ?? 0;
    for (let i = 1; i < p.wallVignetteStops.length; i++) {
      const a = p.wallVignetteStops[i - 1];
      const b = p.wallVignetteStops[i];
      if (!a || !b) continue;
      if (t <= b.at) {
        const span = Math.max(1e-6, b.at - a.at);
        vig = a.v + (b.v - a.v) * Math.min(1, (t - a.at) / span);
        break;
      }
      vig = b.v;
    }
    // vermenigvuldigen, niet naar een vaste kleur trekken: zo lopen de randen
    // mee omhoog met het midden, zoals gemeten
    value = lum * (1 - vig * side);
  } else {
    const band = Math.max(1, canvas.height - horizon);
    const s = (y - horizon) / band;
    const base = p.floorSeam + (p.floorBottom - p.floorSeam) * s;
    // de hoekvignettering groeit naar beneden: vlak onder de naad is de rand
    // niet donkerder dan het midden, onderaan wel
    value = base * (1 - p.floorCornerVignette * side * s);
    // lichtpoel onder de auto, gaussisch zodat hij nergens een rand heeft
    const dx = (x - canvas.width / 2) / (p.poolWidthRatio * canvas.width);
    const dy = (y - (horizon + p.poolCentreRatio * band)) / (p.poolHeightRatio * band);
    value += p.poolGain * Math.exp(-(dx * dx + dy * dy));
  }

  // de vouwlijn ligt over beide vlakken heen, anders zit hij alleen aan één kant
  const d = (y - horizon) / p.creaseSigma;
  return value * (1 - p.creaseDepth * Math.exp(-d * d));
}

/**
 * Geconstrueerde studio-sweep: verticaal verlopende wand met vignettering,
 * een vloer met lichtpoel, en een vouwlijn op de naad.
 *
 * De live Carredo-listings gebruiken geen fotografische plate maar precies
 * zo'n verloop. Gemeten op images.carredo.be (Taycan-listing, 1248x832) over
 * alle zes de studiobeelden, dus dit is hun studio en niet één opname.
 *
 * Uitgerekend in plaats van getekend: met gestapelde SVG-gradiënten kreeg ik
 * de vloer niet gemodelleerd. Die is bij de naad licht (~138) en donkert af
 * naar de onderhoeken (~95) met een poel onder de auto — een radiale gradient
 * doet precies het omgekeerde en gaf een zichtbare stap op de naad.
 *
 * Een verloop is fundamenteel makkelijker dan een foto: geen korrel om gelijk
 * te trekken, geen camerahoogte die bij de opname moet passen, geen
 * perspectief om te matchen. Je rekent het uit in plaats van het te zoeken.
 */
export async function generateStudioSweep(
  file: string,
  canvas: CanvasSize,
  p: SweepParams,
): Promise<void> {
  const { width, height } = canvas;
  const raw = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = sweepLuminance(x + 0.5, y + 0.5, canvas, p);
      raw[y * width + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  await sharp(raw, { raw: { width, height, channels: 1 } })
    .toColourspace("b-w")
    .png()
    .toFile(file);
}
