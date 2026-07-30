import sharp from "sharp";

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
  const blurSigma = Math.max(1.5, width * 0.008);
  // zonder expliciet 1-kanaals doel promoveert sharp de blur naar 3 kanalen
  // en verschuiven alle bytes (zelfde valkuil als bij de oude matte-feather)
  const ratioBlurred = await sharp(ratioU8, { raw: { width, height, channels: 1 } })
    .blur(blurSigma)
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
      let ratio = (ratioBlurred[i] ?? 255) / 255;
      // restruis niet laten doordrukken
      if (ratio > 0.96) ratio = 1;
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
