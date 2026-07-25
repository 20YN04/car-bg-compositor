import sharp from "sharp";
import type { FinishConfig, HarmonizeConfig, HighlightConfig } from "./config.js";

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
 * Hoogfrequente energie: gemiddelde afwijking t.o.v. het 3×3-gemiddelde. Een
 * praktische maat voor sensorkorrel, ongevoelig voor de vorm van het beeld.
 */
export function grainLevel(
  grey: Uint8Array | Buffer,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): number {
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      let mean = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) mean += grey[(y + dy) * width + (x + dx)] ?? 0;
      }
      sum += Math.abs((grey[y * width + x] ?? 0) - mean / 9);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Ruis die nodig is om `plate` op het niveau van `car` te brengen. Ruis telt
 * in kwadratuur op, dus de toe te voegen standaardafwijking volgt uit het
 * verschil van de kwadraten. De deler corrigeert dat `grainLevel` een
 * gemiddelde absolute afwijking meet en geen standaardafwijking.
 */
export function grainGapSigma(carGrain: number, plateGrain: number): number {
  if (carGrain <= plateGrain) return 0;
  return Math.sqrt(carGrain * carGrain - plateGrain * plateGrain) / 0.94;
}

export interface Gains {
  r: number;
  g: number;
  b: number;
}

const lum = (m: ChannelMeans): number => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;

/**
 * Gains die `from` richting `to` trekken: per-kanaal white-balance t.o.v. de
 * eigen luminantie, plus een halve stap exposure. Beide gecapt op maxGain.
 * Puur rekenkundig; niets wordt hier toegepast.
 */
export function computeGains(
  from: ChannelMeans,
  to: ChannelMeans,
  strength: number,
  maxGain: number,
): Gains {
  const fromLum = Math.max(1, lum(from));
  const toLum = Math.max(1, lum(to));
  const clamp = (v: number): number => Math.min(1 + maxGain, Math.max(1 - maxGain, v));
  const wb = (fromC: number, toC: number): number =>
    clamp(1 + strength * (toC / toLum / (fromC / fromLum) - 1));
  const exposure = clamp(1 + strength * 0.5 * (toLum / fromLum - 1));
  return {
    r: wb(from.r, to.r) * exposure,
    g: wb(from.g, to.g) * exposure,
    b: wb(from.b, to.b) * exposure,
  };
}

/** Per-kanaal mediaan: robuust tegen één afwijkende opname in de set. */
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

/** Gains op de gemaskeerde pixels toepassen (in-place). */
export function applyGains(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  gains: Gains,
): void {
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const p = i * 4;
    rgba[p] = Math.min(255, Math.round((rgba[p] ?? 0) * gains.r));
    rgba[p + 1] = Math.min(255, Math.round((rgba[p + 1] ?? 0) * gains.g));
    rgba[p + 2] = Math.min(255, Math.round((rgba[p + 2] ?? 0) * gains.b));
  }
}

/**
 * Fase 3 — harmonisatie: trekt white-balance en exposure van de auto subtiel
 * richting de achtergrondtoon via per-kanaal lineaire gains (gecapt), zodat
 * de koele buitenlicht-zweem verdwijnt. Puur curves/levels op de bestaande
 * pixels — geen generatieve bewerking. Retourneert de toegepaste gains.
 *
 * `setReference` (optioneel) maakt de correctie set-consistent: elke foto van
 * dezelfde auto wordt eerst naar het gedeelde witpunt van de set getrokken en
 * daarna verschuift de héle set met één gedeelde gain naar de plate-toon.
 * Zonder referentie krijgt elke foto zijn eigen correctie — een set die half
 * bij ochtendlicht en half in de namiddagzon is geschoten leest dan als twee
 * verschillende auto's.
 */
export function harmonizeColors(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  car: ChannelMeans,
  bg: ChannelMeans,
  cfg: HarmonizeConfig,
  setReference?: ChannelMeans,
): Gains {
  if (!setReference) {
    const gains = computeGains(car, bg, cfg.strength, cfg.maxGain);
    applyGains(rgba, alpha, width, height, gains);
    return gains;
  }
  // stap 1: dit beeld naar het witpunt van de set (volle sterkte — het doel is
  // gelijkheid binnen de set, niet een subtiele nudge)
  const toSet = computeGains(car, setReference, 1, cfg.maxGain);
  // stap 2: de set als geheel richting de plate — identiek voor elk beeld
  const toBg = computeGains(setReference, bg, cfg.strength, cfg.maxGain);
  const gains: Gains = {
    r: toSet.r * toBg.r,
    g: toSet.g * toBg.g,
    b: toSet.b * toBg.b,
  };
  applyGains(rgba, alpha, width, height, gains);
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

/**
 * Finishing grade op het volledige composiet: per-kanaal lineaire
 * contrastcurve rond het middenpunt met black-lift en warmte, plus
 * saturatie. Auto en scène krijgen exact dezelfde curve — dat verbindt ze
 * visueel tot één opname. Puur curves, geen generatieve stap.
 */
export async function applyFinish(
  png: Buffer,
  cfg: FinishConfig,
): Promise<Buffer> {
  if (!cfg.enabled) return png;
  const lut = buildFinishLut(cfg);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    for (let ch = 0; ch < Math.min(3, info.channels); ch++) {
      data[i + ch] = lut[data[i + ch] ?? 0] ?? 0;
    }
  }
  const gains = [1 + cfg.warmth, 1, 1 - cfg.warmth];
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .linear(gains, [0, 0, 0])
    .modulate({ saturation: cfg.saturation })
    .png()
    .toBuffer();
}

/**
 * Eén opzoektabel voor de hele grade: contrast-S plus zwart-toe.
 *
 * Beide zijn verankerd op 0 en 255, want de vorige versie was dat niet en
 * knipte daardoor de onderkant weg. Een contrast rond het middenpunt
 * (v·c + 128(1−c)) stuurt bij c=1,1 alles onder waarde 11,6 naar nul, en de
 * vlakke blackLift-aftrek deed daar nog eens 7 bovenop. Op de Taycan-set ging
 * het aandeel autopaneel onder waarde 12 daardoor van 17% in de bron naar 53%
 * in de uitvoer: een zwarte auto werd een silhouet zonder paneelscheiding, en
 * dat is een van de dingen die een composiet als "uitgeknipt" laten lezen.
 *
 *   contrast: x' = x + (c−1)·(smoothstep(x) − x)   met smoothstep = x²(3−2x)
 *             smoothstep(0)=0 en smoothstep(1)=1, dus beide uiteinden liggen vast
 *   toe:      v' = v − D·(1 − v/K)²                voor v < K
 *             afgeleide 1 + 2D(1−v/K)/K > 0, dus monotoon: twee verschillende
 *             invoerwaarden komen nooit op dezelfde uitvoerwaarde uit
 */
export function buildFinishLut(cfg: FinishConfig): Uint8Array {
  const lut = new Uint8Array(256);
  const depth = Math.max(0, -cfg.blackLift); // blackLift negatief = dieper
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    const s = x * x * (3 - 2 * x);
    let out = 255 * (x + (cfg.contrast - 1) * (s - x));
    if (out < cfg.toeKnee && depth > 0) {
      const t = 1 - out / cfg.toeKnee;
      out -= depth * t * t;
    }
    lut[v] = Math.max(0, Math.min(255, Math.round(out)));
  }
  return lut;
}
