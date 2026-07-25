import type { BBox } from "./bbox.js";
import type { WindowsConfig } from "./config.js";

export interface SourceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Verwerpt detecties die onmogelijk één raam kunnen zijn: Florence geeft bij
 * "car window" naast de echte ramen vaak ook één box rond de hele auto terug,
 * en die zou SAM2 de complete auto laten segmenteren (= hele auto getint).
 */
export function filterPlausibleWindowBoxes(
  boxes: SourceBox[],
  carBBox: BBox,
): SourceBox[] {
  const carArea =
    (carBBox.right - carBBox.left + 1) * (carBBox.bottom - carBBox.top + 1);
  const carHeight = carBBox.bottom - carBBox.top + 1;
  return boxes.filter(
    (b) => b.w * b.h <= 0.3 * carArea && b.h <= 0.5 * carHeight,
  );
}

/** Houdt alleen boxes over waarvan het middelpunt op de gemaskeerde auto ligt. */
export function filterBoxesOnCar(
  boxes: SourceBox[],
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): SourceBox[] {
  return boxes.filter((b) => {
    const cx = Math.round(b.x + b.w / 2);
    const cy = Math.round(b.y + b.h / 2);
    return (
      cx >= 0 && cx < width && cy >= 0 && cy < height &&
      (alpha[cy * width + cx] ?? 0) > threshold
    );
  });
}

/**
 * Verdonkert de raamzones in de cutout richting tintColor, gewogen met het
 * (gefeatherde) segmentmasker en beperkt tot pixels op de auto. Puur
 * mathematische pixeloperatie: reflecties blijven proportioneel zichtbaar,
 * er wordt niets hertekend. Retourneert het aantal getinte pixels.
 */
export function applyWindowTint(
  rgba: Buffer,
  alpha: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  cfg: Pick<WindowsConfig, "tintOpacity" | "tintColor">,
): number {
  let tinted = 0;
  const { r: tr, g: tg, b: tb } = cfg.tintColor;
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const m = (mask[i] ?? 0) / 255;
    if (m <= 0.02) continue;
    const t = m * cfg.tintOpacity;
    const p = i * 4;
    rgba[p] = Math.round((rgba[p] ?? 0) * (1 - t) + tr * t);
    rgba[p + 1] = Math.round((rgba[p + 1] ?? 0) * (1 - t) + tg * t);
    rgba[p + 2] = Math.round((rgba[p + 2] ?? 0) * (1 - t) + tb * t);
    if (t > 0.05) tinted++;
  }
  return tinted;
}

export interface GreenhouseColour {
  r: number;
  g: number;
  b: number;
}

/**
 * Greenhouse-vervanging: het glas de studio-achtergrond laten spiegelen in
 * plaats van het alleen donker te tinten.
 *
 * "Greenhouse" is de vakterm voor het glasgedeelte boven de gordellijn. De
 * tint-aanpak maakt het glas donkerder maar laat de oorspronkelijke omgeving
 * er doorheen schemeren — bomen, hekwerk. De AI-native pipelines vervangen
 * die reflectie door de achtergrond; Spyne noemt de stap letterlijk
 * "greenhouse cleaning". Dat is precies wat hier gebeurt, maar zonder
 * generatieve stap.
 *
 * Frequentiescheiding is de sleutel. Het glas draagt twee soorten informatie:
 *
 *   lage frequentie — brede lichtvlakken: de gespiegelde omgeving. Dit mag
 *                     weg; het is niet de auto maar de plek waar hij stond.
 *   hoge frequentie — ruitenwisser, raamstijlen, de contouren van het
 *                     interieur, randen van de afdichtrubbers. Dit IS de auto
 *                     en blijft bit-voor-bit staan.
 *
 * De lage frequentie wordt vervangen door `plate`, de kleur die de
 * studio-achtergrond op die plek zou spiegelen, verdonkerd met `tintOpacity`
 * zodat het als getint glas leest en niet als een gat.
 *
 * `lowFreq` is de geblurde luminantie van het glasgebied; de aanroeper levert
 * die aan omdat de blur op beeldniveau efficiënter is dan hier per pixel.
 *
 * Retourneert het aantal aangepaste pixels.
 */
export function applyGreenhouse(
  rgba: Buffer,
  alpha: Uint8Array,
  mask: Uint8Array,
  lowFreq: Uint8Array,
  width: number,
  height: number,
  plate: GreenhouseColour,
  cfg: Pick<WindowsConfig, "tintOpacity" | "tintColor">,
  detailKeep: number,
): number {
  let changed = 0;
  // waar de plate op landt: de reflectiekleur verdonkerd richting de tint,
  // zodat het glas donker glas blijft in plaats van een lichte vlek te worden
  const t = cfg.tintOpacity;
  const baseR = plate.r * (1 - t) + cfg.tintColor.r * t;
  const baseG = plate.g * (1 - t) + cfg.tintColor.g * t;
  const baseB = plate.b * (1 - t) + cfg.tintColor.b * t;

  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const m = (mask[i] ?? 0) / 255;
    if (m <= 0.02) continue;
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;

    // hoge frequentie = pixel min zijn eigen lokale gemiddelde. Dat is de
    // structuur: wisser, stijlen, interieurcontouren.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const detail = (lum - (lowFreq[i] ?? 0)) * detailKeep;

    // nieuwe waarde = vervangen lage frequentie + behouden hoge frequentie,
    // gewogen met het maskerverloop zodat de raamrand niet hard afsnijdt
    rgba[p] = Math.max(0, Math.min(255, Math.round(r * (1 - m) + (baseR + detail) * m)));
    rgba[p + 1] = Math.max(0, Math.min(255, Math.round(g * (1 - m) + (baseG + detail) * m)));
    rgba[p + 2] = Math.max(0, Math.min(255, Math.round(b * (1 - m) + (baseB + detail) * m)));
    if (m > 0.05) changed++;
  }
  return changed;
}
