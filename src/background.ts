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
  const alpha = await sharp(cutout)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(3)
    .blur(1)
    .raw()
    .toBuffer();

  // bbox van de auto voor de schaduwzone
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
  if (right < 0) {
    throw new Error("achtergrondvervanging: leeg masker — kandidaat ongewijzigd laten");
  }
  const mx = Math.round(width * 0.06);
  const myDown = Math.round(height * 0.1);
  const zone = {
    x0: Math.max(0, left - mx),
    x1: Math.min(width - 1, right + mx),
    // alleen de contactzone: vlak onder de koets en net onder de banden
    y0: Math.max(0, bottom - Math.round((bottom - top) * 0.25)),
    y1: Math.min(height - 1, bottom + myDown),
  };
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
