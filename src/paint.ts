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

/**
 * Lokaal contrast per pixel: |L − boxblur(L)| op een middelgrote straal.
 *
 * Onderscheidt een gestructureerde reflectie (bladerdek, hekwerk, gebouwrand)
 * van een gladde kleurzweem. Dat verschil is precies de vakregel uit de
 * automotive retouche: *"You don't want to clean up the entire car's
 * reflections, otherwise it will look pasted in — just the ones that are
 * distracting."* Een egale zweem hoort te blijven staan; die leest als
 * omgevingslicht. Herkenbare vormen zijn wat stoort.
 *
 * Middelgrote straal, niet 3×3: op pixelniveau meet je sensorruis, niet
 * structuur. Bladerdek in lak zit op een schaal van tientallen pixels.
 */
export function localContrastMap(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const n = width * height;
  const lum = luminanceMap(rgba, n);
  const blurred = boxBlur(lum, width, height, radius);
  const contrast = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    contrast[i] = Math.abs((lum[i] ?? 0) - (blurred[i] ?? 0));
  }
  return contrast;
}

/** Luminantie per pixel uit een RGBA-buffer. */
export function luminanceMap(rgba: Buffer, n: number): Float32Array {
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    lum[i] = 0.2126 * (rgba[p] ?? 0) + 0.7152 * (rgba[p + 1] ?? 0) + 0.0722 * (rgba[p + 2] ?? 0);
  }
  return lum;
}

/** Gescheiden boxblur: horizontaal, dan verticaal — O(n) i.p.v. O(n·r²). */
export function boxBlur(
  lum: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const n = width * height;
  const tmp = new Float32Array(n);
  const blurred = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    let count = 0;
    for (let x = -radius; x <= radius; x++) {
      if (x >= 0 && x < width) {
        sum += lum[row + x] ?? 0;
        count++;
      }
    }
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / Math.max(1, count);
      const out = x - radius;
      const inn = x + radius + 1;
      if (out >= 0) {
        sum -= lum[row + out] ?? 0;
        count--;
      }
      if (inn < width) {
        sum += lum[row + inn] ?? 0;
        count++;
      }
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = -radius; y <= radius; y++) {
      if (y >= 0 && y < height) {
        sum += tmp[y * width + x] ?? 0;
        count++;
      }
    }
    for (let y = 0; y < height; y++) {
      blurred[y * width + x] = sum / Math.max(1, count);
      const out = y - radius;
      const inn = y + radius + 1;
      if (out >= 0) {
        sum -= tmp[out * width + x] ?? 0;
        count--;
      }
      if (inn < height) {
        sum += tmp[inn * width + x] ?? 0;
        count++;
      }
    }
  }
  return blurred;
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
  weightsOut: Float32Array | null = null,
): number {
  if (!cfg.enabled || cfg.strength <= 0) return 0;
  // selectief, niet uniform: alleen gestructureerde reflecties dempen. Een
  // egale kleurzweem leest als omgevingslicht en hoort te blijven — een auto
  // zonder enige reflectie leest juist als geplakt.
  const contrast = cfg.selective
    ? localContrastMap(rgba, alpha, width, height, cfg.contrastRadius)
    : null;
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
    // structuurweging: vlak blijft staan, patroon wordt gedempt
    const structure = contrast
      ? Math.min(1, (contrast[i] ?? 0) / Math.max(1e-6, cfg.contrastFull))
      : 1;
    const amount = cfg.strength * w * ramp * structure;
    if (amount <= 0) continue;
    if (weightsOut) weightsOut[i] = amount;

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

/**
 * De vórm van een gespiegelde omgeving uit de lak halen.
 *
 * `dampEnvironmentReflections` trekt de kleur eruit maar laat de helderheids-
 * structuur bewust staan; dat is daar de bovengrens. Op een dak of motorkap
 * blijft daarmee een ontkleurd bladerdek liggen: een vlekkerige modulatie die
 * nog steeds als "deze auto stond onder bomen" leest, hoe neutraal hij ook is.
 *
 * Wat we hier weghalen is de middenband — het verschil tussen een fijne en een
 * grove blur. Dat is de schaal van gespiegeld gebladerte. Wat blijft:
 *
 *   fijner dan fineRadius   panelnaden, deurgrepen, badges, de rand van een
 *                           spiegelkap. De identiteit van de auto.
 *   grover dan coarseRadius de lichtverdeling over het carrosseriepaneel: waar
 *                           het dak licht vangt en waar het wegdraait. De vorm
 *                           van de auto zelf.
 *
 * Twee gates, want vlakke lak gladstrijken geeft precies de plastic look die we
 * proberen te vermijden:
 *
 *   weights   alleen waar de dempstap de pixel al als omgeving heeft
 *             aangewezen. Waar niets gedempt is, gebeurt hier niets.
 *   strength  hoeveel van die middenband verdwijnt.
 *
 * Retourneert het aantal aangepaste pixels.
 */
export function attenuateReflectionStructure(
  rgba: Buffer,
  alpha: Uint8Array,
  weights: Float32Array,
  width: number,
  height: number,
  fineRadius: number,
  coarseRadius: number,
  strength: number,
): number {
  if (strength <= 0) return 0;
  const n = width * height;
  const lum = luminanceMap(rgba, n);
  const fine = boxBlur(lum, width, height, fineRadius);
  const coarse = boxBlur(lum, width, height, coarseRadius);
  let touched = 0;
  for (let i = 0; i < n; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const w = weights[i] ?? 0;
    if (w <= 0) continue;
    const mid = (fine[i] ?? 0) - (coarse[i] ?? 0);
    const delta = -strength * w * mid;
    if (delta === 0) continue;
    const p = i * 4;
    // dezelfde delta op alle drie de kanalen: de pixels die hier langskomen
    // zijn door de dempstap al vrijwel neutraal, dus dit verschuift de
    // helderheid zonder een kleurzweem te introduceren
    rgba[p] = Math.max(0, Math.min(255, Math.round((rgba[p] ?? 0) + delta)));
    rgba[p + 1] = Math.max(0, Math.min(255, Math.round((rgba[p + 1] ?? 0) + delta)));
    rgba[p + 2] = Math.max(0, Math.min(255, Math.round((rgba[p + 2] ?? 0) + delta)));
    touched++;
  }
  return touched;
}

/**
 * Het randlicht van de oude omgeving dempen.
 *
 * Een auto die buiten staat vangt de hele hemel op zijn daklijst, schouderlijn
 * en dorpel: een lichte lijn die het silhouet volgt. In een studio vangt die
 * lijn alleen het stuk wand erachter. Gemeten op de referentie van de live
 * listing steekt die lijn 28 niveaus boven de lak uit; bij ons 89 en 64. Een
 * lichte lijn die de contour volgt verraadt de vorm van het oude licht, en dat
 * is een van de sterkste aanwijzingen dat een auto ergens anders vandaan komt.
 *
 * Hij hoort er niet helemaal uit — de referentie heeft hem ook, alleen zwakker.
 *
 * `compressHighlights` komt er niet bij: die knie ligt op 200 en schuift mee
 * met de autohelderheid, terwijl deze lijn op een zwarte auto rond 150 piekt.
 *
 * Twee dingen die een eerdere poging lieten mislukken en hier expliciet anders
 * zijn opgelost:
 *
 *   de band was te smal. De lijn beslaat op bronresolutie zo'n 7 tot 10 px,
 *   dus een band van 5 raakte alleen de buitenste rand ervan. Breedte wordt nu
 *   afgeleid van de autohoogte, zodat hij met het beeld meeschaalt.
 *
 *   het lakniveau werd over een straal gemeten die de lijn zelf bevatte,
 *   waardoor het niveau omhoog werd getrokken en het overschot verdween. De
 *   straal is nu ruim, en gemaskeerd (som van luminantie maal masker, gedeeld
 *   door som van het masker) zodat de transparante buitenkant niet meetelt.
 *
 * Retourneert het aantal aangepaste pixels.
 */
export function dampRimLight(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
  rimWidth: number,
  paintRadius: number,
  strength: number,
  minExcess: number,
): number {
  if (strength <= 0 || rimWidth < 1) return 0;
  const n = width * height;
  const lum = luminanceMap(rgba, n);
  const mask = new Float32Array(n);
  const masked = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (alpha[i] ?? 0) / 255;
    mask[i] = a;
    masked[i] = (lum[i] ?? 0) * a;
  }
  // afstand tot de rand, benaderd met een blur van het masker: diep binnen de
  // auto is die 1, pal op de rand ongeveer 0,5
  const near = boxBlur(mask, width, height, rimWidth);
  // Het lakniveau meten ZONDER de randband. Anders zit de lichte lijn in zijn
  // eigen referentie: gemeten op een uitgebeten daklijn (luminantie 255) kwam
  // het niveau daardoor op ~200 uit en bleef er van het overschot niets over.
  const body = new Float32Array(n);
  const bodyLum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const band = Math.min(1, Math.max(0, (1 - (near[i] ?? 1)) / 0.5));
    const w = (mask[i] ?? 0) * (1 - band);
    body[i] = w;
    bodyLum[i] = (lum[i] ?? 0) * w;
  }
  const wSum = boxBlur(body, width, height, paintRadius);
  const vSum = boxBlur(bodyLum, width, height, paintRadius);
  // Vangnet: de mediaan van de carrosserie buiten de band. Bij een uitgebeten
  // daklijn (luminantie 255 over een band van 18 px) is zelfs een lokaal
  // niveau dat de band uitsluit nog te hoog, want de hele omgeving daar is
  // uitgebeten. De mediaan van de rest van de auto is dan de eerlijke
  // schatting van "wat is dit voor lak".
  const bodyVals: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((body[i] ?? 0) > 0.9) bodyVals.push(lum[i] ?? 0);
  }
  bodyVals.sort((a, b) => a - b);
  const bodyMedian = bodyVals.length > 0
    ? (bodyVals[Math.floor(bodyVals.length / 2)] ?? 0)
    : 0;

  let touched = 0;
  for (let i = 0; i < n; i++) {
    const a = (alpha[i] ?? 0) / 255;
    if (a <= 0.02) continue;
    // 0 diep binnen de auto, 1 op de rand
    const band = Math.min(1, Math.max(0, (1 - (near[i] ?? 1)) / 0.5));
    if (band <= 0.02) continue;
    const denom = wSum[i] ?? 0;
    if (denom < 1e-3) continue;
    // de laagste van de twee: een lokaal niveau dat door uitgebeten omgeving
    // omhoog is getrokken mag het overschot niet wegpoetsen
    const level = Math.min((vSum[i] ?? 0) / denom, bodyMedian + 30);
    const excess = (lum[i] ?? 0) - level - minExcess;
    if (excess <= 0) continue;
    const drop = strength * band * a * excess;
    const p = i * 4;
    rgba[p] = Math.max(0, Math.min(255, Math.round((rgba[p] ?? 0) - drop)));
    rgba[p + 1] = Math.max(0, Math.min(255, Math.round((rgba[p + 1] ?? 0) - drop)));
    rgba[p + 2] = Math.max(0, Math.min(255, Math.round((rgba[p + 2] ?? 0) - drop)));
    touched++;
  }
  return touched;
}
