import type { PaintConfig } from "./config.js";

export interface PaintStats {
  /** Dominante tint van de lak in graden (0–360); betekenisloos bij achromatisch. */
  dominantHue: number;
  /** Mediane verzadiging van de lak (0–1). */
  medianSat: number;
  /** Zwart, wit of grijs: dan is élke verzadigde pixel omgeving. */
  achromatic: boolean;
}

/** HSV-verzadiging en -tint uit RGB. Verzadiging is relatief (max−min)/max. */
function hueSat(r: number, g: number, b: number): { hue: number; sat: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const sat = max === 0 ? 0 : d / max;
  if (d === 0) return { hue: 0, sat: 0 };
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, sat };
}

/** Kleinste hoek tussen twee tinten op de kleurencirkel (0–180). */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * Lakstatistiek uit de gemaskeerde pixels. De mediaan i.p.v. het gemiddelde:
 * een enkele felrode achterlichtcluster mag de "lakkleur" niet verschuiven.
 *
 * Alleen pixels met genoeg helderheid tellen mee — in bijna-zwarte pixels is
 * de tint ruis, en die zou de dominante tint willekeurig maken.
 */
export function analyzePaint(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  cfg: PaintConfig,
): PaintStats {
  const sats: number[] = [];
  const hueBins = new Float64Array(36); // 10 graden per bin
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    if (Math.max(r, g, b) < cfg.minValue) continue;
    const { hue, sat } = hueSat(r, g, b);
    sats.push(sat);
    // wegen met verzadiging: een grijze pixel zegt niets over de tint
    const bin = Math.min(35, Math.floor(hue / 10));
    hueBins[bin] = (hueBins[bin] ?? 0) + sat;
  }
  if (sats.length === 0) return { dominantHue: 0, medianSat: 0, achromatic: true };

  sats.sort((a, b) => a - b);
  const medianSat = sats[Math.floor(sats.length / 2)] ?? 0;

  let bestBin = 0;
  for (let i = 1; i < hueBins.length; i++) {
    if ((hueBins[i] ?? 0) > (hueBins[bestBin] ?? 0)) bestBin = i;
  }
  return {
    dominantHue: bestBin * 10 + 5,
    medianSat,
    achromatic: medianSat < cfg.achromaticSat,
  };
}

/**
 * Omgevingsreflecties in de lak dempen.
 *
 * Glanzende lak is een spiegel: wat je erin ziet is de omgeving waarin de foto
 * genomen is. Een auto die onder bomen stond houdt een bomenrij op de
 * motorkap, ook nadat de achtergrond vervangen is — en dat is wat een beeld
 * als "buitenfoto met vervangen achtergrond" laat lezen in plaats van als
 * studio-opname. De commerciële pipelines lossen dit niet op maar dempen het
 * (Spyne noemt de stap letterlijk "shadow and reflection reduction").
 *
 * We verwijderen niets: we trekken de verzadiging terug richting neutraal,
 * zodat groen bladerdek als kleurloze wolkerige modulatie leest. De vorm van
 * de reflectie blijft — dat is de bovengrens van deze aanpak.
 *
 * Twee beschermingen, want de valkuil is dat achterlichten, badges en
 * remklauwen ook afwijkende tinten hebben:
 *
 *   satProtect  boven deze verzadiging blijft alles onaangeroerd. Achterlicht-
 *               rood en badge-goud zitten daar ruim boven; een reflectie in
 *               donkere lak haalt die verzadiging niet.
 *   hueTolerance  bij een gekleurde auto telt de eigen lakkleur niet als
 *               omgeving. Bij een zwarte, witte of grijze auto (achromatic)
 *               vervalt die uitzondering: dan is élke verzadigde pixel
 *               omgeving.
 *
 * Retourneert het aantal aangepaste pixels.
 */
export function dampEnvironmentReflections(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  stats: PaintStats,
  cfg: PaintConfig,
): number {
  if (!cfg.enabled || cfg.strength <= 0) return 0;
  let touched = 0;
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const max = Math.max(r, g, b);
    if (max < cfg.minValue) continue;

    const { hue, sat } = hueSat(r, g, b);
    if (sat <= cfg.satFloor || sat >= cfg.satProtect) continue;

    // hoeveel telt deze pixel als omgeving?
    let w = 1;
    if (!stats.achromatic) {
      const d = hueDistance(hue, stats.dominantHue);
      if (d <= cfg.hueTolerance) continue; // eigen lakkleur
      w = Math.min(1, (d - cfg.hueTolerance) / cfg.hueTolerance);
    }
    // vlak boven satFloor niets abrupts: lineair invaren over een band
    const ramp = Math.min(1, (sat - cfg.satFloor) / Math.max(1e-6, cfg.satRamp));
    const amount = cfg.strength * w * ramp;
    if (amount <= 0) continue;

    // naar de luminantie trekken, niet naar het maximumkanaal: dat laatste
    // maakt de pixel lichter (groen 30/55/25 zou 55/55/55 worden). Naar L
    // blijft de helderheid exact gelijk, dus de lichtverdeling — en daarmee
    // de vorm van de reflectie en van het lakoppervlak — verandert niet.
    // Alleen de kleur verdwijnt.
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    rgba[p] = Math.round(r + (lum - r) * amount);
    rgba[p + 1] = Math.round(g + (lum - g) * amount);
    rgba[p + 2] = Math.round(b + (lum - b) * amount);
    touched++;
  }
  return touched;
}
