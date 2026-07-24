import sharp from "sharp";
import type { HarmonizeConfig, HighlightConfig } from "./config.js";

export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

/** Gemiddelde kanaalwaarden van de achtergrond-plate (op canvasformaat). */
export async function backgroundMeans(
  backgroundPath: string,
  width: number,
  height: number,
): Promise<ChannelMeans> {
  const stats = await sharp(backgroundPath)
    .resize(width, height, { fit: "cover" })
    .stats();
  return {
    r: stats.channels[0]?.mean ?? 128,
    g: stats.channels[1]?.mean ?? 128,
    b: stats.channels[2]?.mean ?? 128,
  };
}

/** Alfagewogen gemiddelde kanaalwaarden van de cutout. */
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
 * Fase 3 — harmonisatie: trekt white-balance en exposure van de auto subtiel
 * richting de achtergrondtoon via per-kanaal lineaire gains (gecapt), zodat
 * de koele buitenlicht-zweem verdwijnt. Puur curves/levels op de bestaande
 * pixels — geen generatieve bewerking. Retourneert de toegepaste gains.
 */
export function harmonizeColors(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  car: ChannelMeans,
  bg: ChannelMeans,
  cfg: HarmonizeConfig,
): { r: number; g: number; b: number } {
  const lum = (m: ChannelMeans): number => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
  const carLum = Math.max(1, lum(car));
  const bgLum = Math.max(1, lum(bg));

  // white-balance: kanaalverhoudingen t.o.v. de eigen luminantie gelijktrekken
  const clamp = (v: number): number => Math.min(1 + cfg.maxGain, Math.max(1 - cfg.maxGain, v));
  const wb = (carC: number, bgC: number): number =>
    clamp(1 + cfg.strength * (bgC / bgLum / (carC / carLum) - 1));
  // exposure: luminantie een fractie richting de achtergrond
  const exposure = clamp(1 + cfg.strength * 0.5 * (bgLum / carLum - 1));

  const gains = {
    r: wb(car.r, bg.r) * exposure,
    g: wb(car.g, bg.g) * exposure,
    b: wb(car.b, bg.b) * exposure,
  };
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    rgba[p] = Math.min(255, Math.round((rgba[p] ?? 0) * gains.r));
    rgba[p + 1] = Math.min(255, Math.round((rgba[p + 1] ?? 0) * gains.g));
    rgba[p + 2] = Math.min(255, Math.round((rgba[p + 2] ?? 0) * gains.b));
  }
  return gains;
}

/**
 * Specular-compressie: de originele omgeving (tl-balken, spots) laat felle
 * witte spikkels en strepen achter in de lak die vloeken met de rustige
 * studio-achtergrond. Een soft-knee curve comprimeert alleen de luminantie
 * boven de knee — normale lakglans en verlopen blijven onaangetast, de hue
 * blijft behouden (alle kanalen schalen mee). Puur een curve, niet generatief.
 * Retourneert het aantal aangepaste pixels.
 */
export function compressHighlights(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  cfg: HighlightConfig,
): number {
  if (!cfg.enabled || cfg.strength <= 0) return 0;
  // adaptieve knee: op een witte auto ligt de hele carrosserie boven een
  // vaste knee en zou de lak afvlakken; de knee schuift daarom mee met de
  // gemiddelde helderheid van de auto zelf — alleen echte uitschieters
  // (spot-reflecties) blijven erboven
  let sum = 0;
  let n = 0;
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    sum += Math.max(rgba[p] ?? 0, rgba[p + 1] ?? 0, rgba[p + 2] ?? 0);
    n++;
  }
  if (n === 0) return 0;
  const knee = Math.max(cfg.knee, sum / n + 35);
  const keep = 1 - cfg.strength;
  let touched = 0;
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    const r = rgba[p] ?? 0;
    const g = rgba[p + 1] ?? 0;
    const b = rgba[p + 2] ?? 0;
    const max = Math.max(r, g, b);
    if (max <= knee) continue;
    const target = knee + (max - knee) * keep;
    const scale = target / max;
    rgba[p] = Math.round(r * scale);
    rgba[p + 1] = Math.round(g * scale);
    rgba[p + 2] = Math.round(b * scale);
    touched++;
  }
  return touched;
}
