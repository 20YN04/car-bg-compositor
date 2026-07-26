import sharp from "sharp";
import { boxBlur, luminanceMap } from "./paint.js";

export interface RelightResult {
  image: Buffer; // PNG, volledig canvas
  /** Gemiddelde verschuiving per kanaal binnen het masker, in niveaus. */
  meanShift: number;
  /** Grootste verschuiving die is toegepast, na begrenzing. */
  maxShift: number;
  /** Fractie van de maskerpixels die tegen de begrenzing aan liep. */
  clipped: number;
}

/**
 * Het licht van de gegenereerde scène overnemen zonder de auto te hertekenen.
 *
 * Dit is het antwoord op de bekende tekortkoming van de pixel-exacte
 * terugplak. Een instructie-editor blendt een auto werkelijk in een scène: de
 * vloer kaatst terug op de dorpel, de wand licht de flank op, onder de
 * wielkast wordt het donker. Dat zit allemaal ín de autopixels. Plak je daarna
 * het origineel er pixel-exact overheen, dan gooi je precies die integratie
 * weg — je houdt de identiteit en verliest de blend. Alles of niets.
 *
 * De scheiding die dat oplost loopt langs de frequentie:
 *
 *   laag    hoe het licht over de carrosserie valt. Dat is de scène, niet de
 *           auto, en dat mag van het model komen.
 *   hoog    badges, velgspaken, panelnaden, ruitrubbers, tekst. Dat IS de
 *           auto en blijft bit-voor-bit van ons.
 *
 * Uitgevoerd als een verschuiving, niet als een menging: per pixel tellen we
 * op wat het verschil is tussen het lokale gemiddelde van de scène en dat van
 * ons composiet. Binnen het masker verandert daardoor alleen de belichting;
 * elk detail fijner dan `radius` staat er onaangeroerd doorheen. Dat is
 * aantoonbaar en niet alleen bedoeld — zie de test op de hoge frequentie.
 *
 * Twee remmen, want een instructie-editor kan de auto ook verplaatsen of
 * herkleuren, en dan is het "lokale gemiddelde" van iets anders:
 *
 *   maxShift  begrenst hoe ver een pixel mag opschuiven. Een model dat een
 *             witte auto tekent waar de onze zwart is, krijgt dan een
 *             begrensde duw in plaats van de auto over te schrijven.
 *   clipped   welke fractie tegen die grens aanliep. Loopt dat op, dan lag de
 *             gegenereerde auto niet op de onze en hoort het beeld afgekeurd
 *             te worden in plaats van gered.
 *
 * `binary` is het composiet zoals het nu gemaakt wordt: de scène met onze auto
 * er pixel-exact overheen. Beide blurs draaien dus op volledig dekkende
 * beelden van gelijke maat, wat de randbloeding voorkomt die je krijgt als je
 * een uitsnede met transparantie blurt.
 */
export async function adoptSceneLight(
  scene: Buffer,
  binary: Buffer,
  carMask: Buffer,
  radius: number,
  maxShift: number,
): Promise<RelightResult> {
  const s = await sharp(scene).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(binary).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = b.info.width;
  const height = b.info.height;
  if (s.info.width !== width || s.info.height !== height) {
    throw new Error(
      `scène (${s.info.width}x${s.info.height}) en composiet (${width}x${height}) verschillen van maat`,
    );
  }
  const m = await sharp(carMask)
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  const n = width * height;
  const out = Buffer.from(b.data);
  let sum = 0;
  let count = 0;
  let seen = 0;
  let clipped = 0;

  // per kanaal, want de kleurzweem van de scène hoort mee te komen: een
  // koelere wand maakt de flank koeler. Alleen luminantie verschuiven zou dat
  // laten liggen.
  for (let ch = 0; ch < 3; ch++) {
    const sceneCh = new Float32Array(n);
    const binCh = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sceneCh[i] = s.data[i * 3 + ch] ?? 0;
      binCh[i] = b.data[i * 3 + ch] ?? 0;
    }
    const lowScene = boxBlur(sceneCh, width, height, radius);
    const lowBin = boxBlur(binCh, width, height, radius);
    for (let i = 0; i < n; i++) {
      const w = (m[i] ?? 0) / 255;
      if (w <= 0.004) continue;
      let shift = ((lowScene[i] ?? 0) - (lowBin[i] ?? 0)) * w;
      if (shift > maxShift) {
        shift = maxShift;
        clipped++;
      } else if (shift < -maxShift) {
        shift = -maxShift;
        clipped++;
      }
      const v = (binCh[i] ?? 0) + shift;
      out[i * 3 + ch] = Math.max(0, Math.min(255, Math.round(v)));
      sum += Math.abs(shift);
      count++;
      if (Math.abs(shift) > seen) seen = Math.abs(shift);
    }
  }

  const image = await sharp(out, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return {
    image,
    meanShift: count > 0 ? sum / count : 0,
    maxShift: seen,
    clipped: count > 0 ? clipped / count : 0,
  };
}

export interface Box { left: number; top: number; width: number; height: number }

/**
 * Waar staat de auto in de gegenereerde scène?
 *
 * Een drempel volstaat hier en een matte-call niet waard: de studio is licht
 * (gemeten 140 tot 230) en een auto in listingfoto's is het donkerste object
 * in beeld. Alleen bóven de contactlijn kijken, anders telt de spiegeling in
 * de vloer als carrosserie en wordt de auto twee keer zo hoog.
 */
export function findCarBox(
  grey: Buffer,
  width: number,
  height: number,
  contactY: number,
  threshold: number,
): Box | null {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  const limit = Math.max(1, Math.min(height, Math.round(contactY)));
  for (let y = 0; y < limit; y++) {
    for (let x = 0; x < width; x++) {
      if ((grey[y * width + x] ?? 255) >= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0 || right <= left || bottom <= top) return null;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * De auto uit de scène op onze voetafdruk leggen.
 *
 * Een instructie-editor verplaatst en herschaalt de auto — gemeten schoof
 * Gemini hem een halve wagenbreedte op en maakte hem groter. Voor het
 * overnemen van licht is dat fataal: het "lokale gemiddelde" komt dan van
 * carrosserie waar bij ons lucht zit, en andersom.
 *
 * Uitrekken naar onze bbox is genoeg omdat er alleen lage frequenties uit
 * gehaald worden. De vervorming die dat oplevert zit in het detail, en dat
 * detail gooien we sowieso weg.
 */
export async function alignCarRegion(
  scene: Buffer,
  from: Box,
  to: Box,
): Promise<Buffer> {
  const patch = await sharp(scene)
    .extract(from)
    .resize(Math.max(1, Math.round(to.width)), Math.max(1, Math.round(to.height)), {
      fit: "fill",
    })
    .png()
    .toBuffer();
  return sharp(scene)
    .composite([{ input: patch, left: Math.round(to.left), top: Math.round(to.top) }])
    .png()
    .toBuffer();
}

/**
 * Toetst dat de hoge frequentie binnen het masker onveranderd is gebleven.
 *
 * De belofte van deze stap is smal en controleerbaar: alleen de belichting
 * verschuift. Deze maat maakt dat meetbaar in plaats van aangenomen — hij
 * vergelijkt per pixel het detail (waarde min lokaal gemiddelde) van voor en
 * na, en geeft de grootste afwijking terug. Bij een zuivere verschuiving is
 * die nul op afrondingsruis na.
 */
export function detailDrift(
  before: Buffer,
  after: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): number {
  const n = width * height;
  const lumA = luminanceMap(before, n);
  const lumB = luminanceMap(after, n);
  const lowA = boxBlur(lumA, width, height, radius);
  const lowB = boxBlur(lumB, width, height, radius);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    if ((mask[i] ?? 0) < 200) continue;
    const dA = (lumA[i] ?? 0) - (lowA[i] ?? 0);
    const dB = (lumB[i] ?? 0) - (lowB[i] ?? 0);
    const d = Math.abs(dA - dB);
    if (d > worst) worst = d;
  }
  return worst;
}
