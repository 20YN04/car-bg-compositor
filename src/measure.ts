import sharp from "sharp";

/** Gemiddelde kanaalwaarden — de meeteenheid van de lakpoort. */
export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

/** Alfagewogen gemiddelde kanaalwaarden van een cutout (RGBA-raw). */
export function cutoutMeans(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
): ChannelMeans {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < width * height; i++) {
    const a = (alpha[i] ?? 0) / 255;
    if (a <= 0.04) continue;
    const p = i * 4;
    r += (rgba[p] ?? 0) * a;
    g += (rgba[p + 1] ?? 0) * a;
    b += (rgba[p + 2] ?? 0) * a;
    w += a;
  }
  if (w === 0) return { r: 128, g: 128, b: 128 };
  return { r: r / w, g: g / w, b: b / w };
}

/**
 * Mediaan per kanaal over een set metingen — robuust tegen één afwijkende
 * opname (tegenlicht, onderbelichte garagefoto) in de bronset.
 */
export function medianMeans(list: ChannelMeans[]): ChannelMeans {
  if (list.length === 0) return { r: 128, g: 128, b: 128 };
  const mid = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const i = Math.floor(s.length / 2);
    return s.length % 2 ? (s[i] ?? 0) : ((s[i - 1] ?? 0) + (s[i] ?? 0)) / 2;
  };
  return {
    r: mid(list.map((m) => m.r)),
    g: mid(list.map((m) => m.g)),
    b: mid(list.map((m) => m.b)),
  };
}

/**
 * Detaildichtheid van een beeld: de gemiddelde Laplaciaan-respons over de
 * sterkste 2% randpixels, op vaste hoogte zodat resolutie niet meetelt.
 *
 * Waarom dit bestaat. De kwaliteitspoort vroeg een VLM of een kandidaat "even
 * scherp als de referentie" was, met het anker — een zwarte AMG in een donkere
 * studio — als maatstaf. Op de witte VW ID.3 sneuvelden zo zes van de zes
 * pogingen op woordelijk dezelfde klacht. Gemeten bleek de uitvoer op 93.2 te
 * zitten, tegen 104.7 voor de échte studiofoto's van diezelfde auto en 97.6
 * voor het anker: even scherp dus, en de poort had het simpelweg mis
 * (2026-08-03).
 *
 * Alleen de sterkste randen tellen mee, zodat een lege studio-achtergrond het
 * getal niet verdunt en bronfoto's met een andere kadervulling toch
 * vergelijkbaar zijn.
 */
export async function detailStrength(bytes: Buffer): Promise<number> {
  const { data } = await sharp(bytes)
    .greyscale()
    .resize({ height: 900, fit: "inside", withoutEnlargement: false })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = Array.from(data).sort((a, b) => b - a);
  const top = Math.max(1, Math.floor(px.length * 0.02));
  let som = 0;
  for (let i = 0; i < top; i++) som += px[i]!;
  return som / top;
}
