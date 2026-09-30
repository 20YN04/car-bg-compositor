import { existsSync } from "node:fs";
import sharp from "sharp";

export interface CarBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Volledige bbox van de auto in een cutout, in pixels. */
export async function carBox(cutout: Buffer): Promise<CarBox | null> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width, right = -1, top = info.height, bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 10) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0 || bottom < 0) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/** Kadervulling (bbox-breedte / beeldbreedte) van een cutout. */
export async function measureFill(cutout: Buffer): Promise<number> {
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width, right = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 10) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return right < 0 ? 0 : (right - left + 1) / info.width;
}

/**
 * Schaalt de auto deterministisch naar zijn reële kadervulling.
 *
 * Het model tekent elke auto het kader vol (het anker-composiet domineert;
 * gemeten op de 500e: 80–86% waar 65% hoort), en promptfeedback kreeg dat
 * niet klein. Geometrie hoort in code: we schalen het hele kandidaatbeeld
 * omlaag (alleen downscalen — verliesvrij) en zetten de wagen met zijn
 * bbox-onderkant op de vaste grondlijn van het anker, horizontaal
 * gecentreerd. De achtergrond eromheen is een tijdelijke vulling: de
 * plate-vervanging hierna maakt daar per definitie de studio van.
 */
export async function normalizeScale(
  img: Buffer,
  cutout: Buffer,
  targetFill: number,
  groundLineRatio: number,
): Promise<{ img: Buffer; cutout: Buffer; measuredFill: number }> {
  const meta = await sharp(img).metadata();
  const W = meta.width ?? 1;
  const H = meta.height ?? 1;
  const { data, info } = await sharp(cutout)
    .resize(W, H, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let left = info.width, right = -1, bottom = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if ((data[(y * info.width + x) * 4 + 3] ?? 0) > 10) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) throw new Error("schaalnormalisatie: leeg masker");
  const measuredFill = (right - left + 1) / W;
  // alleen omlaag schalen; opblazen zou detail verzinnen. Maar ALTIJD
  // herpositioneren: een kandidaat die al op maat is moet nog steeds met
  // zijn onderkant op de vaste grondlijn en gecentreerd staan — de Tesla
  // stond gemeten op 0.800 waar 0.813 hoort, puur omdat de translatie
  // alleen in het schaal-pad zat.
  const s = Math.min(1, targetFill / measuredFill);

  const W2 = Math.max(1, Math.round(W * s));
  const H2 = Math.max(1, Math.round(H * s));
  const scaledImg = await sharp(img).resize(W2, H2).png().toBuffer();
  const scaledCut = await sharp(cutout).resize(W2, H2).png().toBuffer();
  const dx = Math.round(W / 2 - ((left + right) / 2) * s);
  const dy = Math.round(H * groundLineRatio - bottom * s);
  const imgCanvas = await sharp({
    // neutrale vulling; wordt integraal door de plate vervangen
    create: { width: W, height: H, channels: 3, background: { r: 228, g: 230, b: 236 } },
  })
    .composite([{ input: scaledImg, left: dx, top: dy }])
    .jpeg({ quality: 97 })
    .toBuffer();
  const cutCanvas = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: scaledCut, left: dx, top: dy }])
    .png()
    .toBuffer();
  return { img: imgCanvas, cutout: cutCanvas, measuredFill };
}

interface ShadowGeometry {
  /** Car alpha at image size, lightly blurred. */
  alpha: Buffer;
  /** Inclusive car bbox from `alpha`, or null for an empty mask. */
  box: { left: number; right: number; top: number; bottom: number } | null;
  /** Inclusive shadow-transfer zone around the bottom of the car. */
  zone: { x0: number; x1: number; y0: number; y1: number };
}

/** Car alpha, bbox and shadow-transfer zone: one geometry for the transfer and its check. */
async function shadowGeometry(cutout: Buffer, width: number, height: number): Promise<ShadowGeometry> {
  const alpha = await sharp(cutout)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(3)
    .blur(1)
    .raw()
    .toBuffer();
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((alpha[y * width + x] ?? 0) > 10) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return { alpha, box: null, zone: { x0: 0, x1: -1, y0: 0, y1: -1 } };
  const mx = Math.round(width * 0.06);
  const myDown = Math.round(height * 0.1);
  return {
    alpha,
    box: { left, right, top, bottom },
    zone: {
      x0: Math.max(0, left - mx),
      x1: Math.min(width - 1, right + mx),
      // contact zone only: just under the body and just under the tyres
      y0: Math.max(0, bottom - Math.round((bottom - top) * 0.25)),
      y1: Math.min(height - 1, bottom + myDown),
    },
  };
}

/**
 * Vervangt de achtergrond van een geaccepteerde kandidaat door de statische
 * studio-plate — deterministisch, per pixel.
 *
 * Waarom: zolang de achtergrond uit het model komt, verschilt hij per
 * generatie (verloop, vloernaad, vignet), ook wanneer het gemiddelde op het
 * anker genormaliseerd is. Met deze stap is de achtergrond van élke
 * thumbnail byte-voor-byte dezelfde plate; alleen de auto en zijn schaduw
 * komen uit de kandidaat.
 *
 * Schaduwbehoud: binnen een zone rond en onder de auto wordt de verhouding
 * kandidaat/plate (geklemd op ≤1, dus alleen verdonkering) op de plate
 * gemultipliceerd. Zo komt de contactschaduw en vloerreflectie van de
 * kandidaat mee, zonder dat de rest van zijn achtergrondstructuur de plate
 * kan binnendringen. De zone heeft een zachte rand; buiten de zone is de
 * plate exact de plate.
 */
export async function replaceBackground(
  img: Buffer,
  cutout: Buffer,
  platePath: string,
): Promise<Buffer> {
  const { data: cand, info } = await sharp(img)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width;
  const height = info.height;
  const plate = await sharp(platePath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const { alpha, box, zone } = await shadowGeometry(cutout, width, height);
  if (!box) {
    throw new Error("achtergrondvervanging: leeg masker — kandidaat ongewijzigd laten");
  }
  const featherPx = Math.round(width * 0.02);
  const zoneWeight = (x: number, y: number): number => {
    if (x < zone.x0 || x > zone.x1 || y < zone.y0 || y > zone.y1) return 0;
    const d = Math.min(x - zone.x0, zone.x1 - x, y - zone.y0, zone.y1 - y);
    return Math.min(1, d / featherPx);
  };

  // schaduwveld: verhouding kandidaat/plate (≤1) per pixel, daarna geblurd.
  // Schaduw en reflectie zijn laagfrequent; vloernaden, draaischijfranden en
  // andere structuur uit de kandidaat-studio zijn hoogfrequent en smeren in
  // de blur weg — gemeten op de 500e, waar de naden anders zichtbaar in de
  // plate stonden.
  const ratioU8 = Buffer.alloc(width * height, 255);
  for (let y = zone.y0; y <= zone.y1; y++) {
    for (let x = zone.x0; x <= zone.x1; x++) {
      const i = y * width + x;
      const p = i * 3;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const pv = plate[p + c] ?? 1;
        const cv = cand[p + c] ?? 0;
        sum += pv > 0 ? Math.min(1, cv / pv) : 1;
      }
      ratioU8[i] = Math.round((sum / 3) * 255);
    }
  }
  // 0.004 sinds de "blur is raar"-feedback: de zachte schaduwpoel bleef te
  // wollig; de naadonderdrukking heeft aan de halve straal genoeg
  const blurSigma = Math.max(1.5, width * 0.004);
  // zonder expliciet 1-kanaals doel promoveert sharp de blur naar 3 kanalen
  // en verschuiven alle bytes (zelfde valkuil als bij de oude matte-feather)
  const ratioBlurred = await sharp(ratioU8, { raw: { width, height, channels: 1 } })
    .blur(blurSigma)
    .toColourspace("b-w")
    .raw()
    .toBuffer();
  // nabijheidsveld: hoe dicht bij de auto, hoe rauwer (= scherper) de
  // schaduw. Vlak onder de banden hoort een strakke contactschaduw — de
  // blur die vloernaden wegwerkt mag die niet meesmeren. Naden liggen
  // verder van de auto en krijgen daar de geblurde versie; vlak bij de
  // auto ligt eventuele naad tóch onder de echte schaduw.
  const proximity = await sharp(alpha, { raw: { width, height, channels: 1 } })
    .blur(Math.max(2, width * 0.008))
    .toColourspace("b-w")
    .raw()
    .toBuffer();

  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 3;
      const a = (alpha[i] ?? 0) / 255;
      const w = zoneWeight(x, y);
      const near = Math.min(1, ((proximity[i] ?? 0) / 255) * 3.5);
      const raw = (ratioU8[i] ?? 255) / 255;
      const soft = (ratioBlurred[i] ?? 255) / 255;
      let ratio = raw * near + soft * (1 - near);
      // zachte knie tegen restruis: een harde afsnede tekende een golvende
      // contour in de schaduwrand. Boven 0.99 volledig plate, tussen 0.99
      // en 0.93 geleidelijk meer schaduw laten doorkomen.
      if (ratio > 0.99) {
        ratio = 1;
      } else if (ratio > 0.93) {
        const t = (0.99 - ratio) / 0.06;
        ratio = 1 - (1 - ratio) * t;
      }
      for (let c = 0; c < 3; c++) {
        const pv = plate[p + c] ?? 0;
        const cv = cand[p + c] ?? 0;
        const bg = pv * (1 - w) + pv * ratio * w;
        out[p + c] = Math.round(cv * a + bg * (1 - a));
      }
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 96 })
    .toBuffer();
}

/**
 * Faalt luid als de studio-plate ontbreekt of niet te decoderen is. Zonder
 * plate kan er geen thumbnail gepubliceerd worden: vroeger ging de kandidaat
 * dan met de achtergrond van het model door (Yentl, 2026-09-28: "een andere
 * achtergrond zou niet mogen").
 */
export async function assertPlate(platePath: string): Promise<void> {
  if (!existsSync(platePath)) {
    throw new Error(`studio-plate ontbreekt: ${platePath}`);
  }
  try {
    const meta = await sharp(platePath).metadata();
    if (!meta.width || !meta.height) throw new Error("geen afmetingen");
    await sharp(platePath).resize(8, 8).raw().toBuffer();
  } catch (err) {
    throw new Error(
      `studio-plate onleesbaar (${platePath}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Meetzones van de achtergrond, als fractie van het beeld: de hoeken en
 * randen waar per constructie nooit auto of schaduw staat. De auto vult
 * maximaal 88% van de breedte, gecentreerd (6% marge links en rechts), met
 * zijn onderkant op de grondlijn 0.813 en de schaduwzone tot ~0.91. Bewust
 * niet `backgroundMeans` uit index.ts: die meet randen van 7.8% breed tot
 * halverwege het beeld, en daar staat bij een bestelwagen al koets.
 */
const PLATE_ZONES: Record<string, [number, number, number, number]> = {
  "linksboven": [0, 0, 0.08, 0.08],
  "rechtsboven": [0.92, 0, 1, 0.08],
  "midden-boven": [0.35, 0, 0.65, 0.08],
  "onderrand": [0.35, 0.95, 0.65, 1],
  "linkerrand": [0, 0.08, 0.03, 0.45],
  "rechterrand": [0.97, 0.08, 1, 0.45],
};
/**
 * Toleranties van de plate-poort, in 8-bit niveaus. Gemeten 2026-09-28 op
 * 2528×1696: de 11 goedgekeurde thumbnails in out/ en 3 productiebeelden
 * wijken per zone ≤ 0.1 af in gemiddelde en ≤ 0.7 in pixelresidu
 * (JPEG-ruis). Dezelfde beelden tegen de andere versie van de plate (blauw
 * x0.945) wijken 9.6 af in gemiddelde en 3.8 in residu; de 17
 * modeldecors in cache/accepted-synth-* 38–63 en 28–56. De grens ligt ruim
 * boven de ruis en ruim onder elke echte afwijking.
 */
const PLATE_MAX_MEAN_DELTA = 2.5;
const PLATE_MAX_RESIDU = 2.0;

/**
 * Laatste poort vóór publicatie: ligt de achtergrond van het beeld exact op
 * de studio-plate? Per zone het gemiddelde per kanaal én het gemiddelde
 * absolute pixelverschil — een gemiddelde alleen laat een egaal
 * model-decor door dat toevallig even licht is; het residu vangt verloop,
 * vignet en vloernaden. Geeft `null` bij akkoord, anders de reden.
 */
export async function plateDeviation(img: Buffer, platePath: string): Promise<string | null> {
  const { data: beeld, info } = await sharp(img)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const plate = await sharp(platePath)
    .resize(W, H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const afwijkingen: string[] = [];
  for (const [naam, [fx0, fy0, fx1, fy1]] of Object.entries(PLATE_ZONES)) {
    const x0 = Math.floor(W * fx0), x1 = Math.max(x0 + 1, Math.floor(W * fx1));
    const y0 = Math.floor(H * fy0), y1 = Math.max(y0 + 1, Math.floor(H * fy1));
    const somB = [0, 0, 0], somP = [0, 0, 0];
    let residu = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) {
          const b = beeld[p + c] ?? 0, q = plate[p + c] ?? 0;
          somB[c]! += b;
          somP[c]! += q;
          residu += Math.abs(b - q);
        }
        n++;
      }
    }
    const delta = Math.max(...[0, 1, 2].map((c) => Math.abs(somB[c]! - somP[c]!) / n));
    const res = residu / (n * 3);
    if (delta > PLATE_MAX_MEAN_DELTA || res > PLATE_MAX_RESIDU) {
      const gem = (s: number[]) => s.map((v) => Math.round(v / n)).join(",");
      afwijkingen.push(
        `${naam} ${gem(somB)} tegen plate ${gem(somP)} (Δ ${delta.toFixed(1)}, residu ${res.toFixed(1)})`,
      );
    }
  }
  return afwijkingen.length > 0
    ? `achtergrond wijkt af van de studio-plate: ${afwijkingen.join("; ")}`
    : null;
}

/**
 * Schaal, grondlijn en achtergrond in één stap, met de plate-poort erachter.
 * Contract: het resultaat staat op de plate, of de functie gooit. Er is geen
 * pad waarlangs de ongewijzigde kandidaat terugkomt — dat is precies het
 * pad dat vroeger publiceerde met de achtergrond van het model.
 */
export async function normaliseToPlate(
  img: Buffer,
  cutout: Buffer,
  targetFill: number,
  groundLineRatio: number,
  platePath: string,
): Promise<{ img: Buffer; measuredFill: number }> {
  await assertPlate(platePath);
  const scaled = await normalizeScale(img, cutout, targetFill, groundLineRatio);
  const uit = await replaceBackground(scaled.img, scaled.cutout, platePath);
  const afwijking = await plateDeviation(uit, platePath);
  if (afwijking) throw new Error(afwijking);
  return { img: uit, measuredFill: scaled.measuredFill };
}
