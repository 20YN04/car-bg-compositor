import type { GeminiConfig, SynthConfig } from "./config.js";
import { geminiText, type ImagePart } from "./gemini.js";
import type { ChannelMeans } from "./measure.js";

/**
 * Exacte voertuigidentificatie uit de hele fotoset.
 *
 * De spec gaat mee in elke volgende prompt (synthese én vergelijking) zodat
 * het model niet per call opnieuw hoeft te raden welke auto het ziet — de
 * fout die eerder een Taycan in een generiek "sports sedan" veranderde.
 */
export interface VehicleIdentity {
  spec: string;
  /** Werkelijke voertuiglengte in meters — stuurt de kadervulling. */
  lengthM: number;
}

export async function identifyVehicle(
  refs: ImagePart[],
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<VehicleIdentity> {
  const prompt =
    "These photos all show the same vehicle. Identify it exactly: make, " +
    "model, generation/body code, trim level if visible, paint colour, " +
    "wheel design and size, and any visible options (roof rails, spoiler, " +
    "badges, trim accents, panoramic roof). Also give the real-world " +
    "exterior length of this exact model in metres.\n" +
    'Answer with STRICT JSON only, no code fences: {"spec": "<one dense ' +
    'line>", "length_m": <number>}.';
  const raw = await geminiText(refs, prompt, cfg, cacheDir, useCache);
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { spec?: unknown; length_m?: unknown };
      const lengthM = typeof obj.length_m === "number" ? obj.length_m : NaN;
      return {
        spec: typeof obj.spec === "string" ? obj.spec : raw.trim().slice(0, 400),
        // plausibiliteitsklem: personenauto's liggen tussen ~2.5 en 6 m
        lengthM: Number.isFinite(lengthM) ? Math.min(6, Math.max(2.5, lengthM)) : 4.6,
      };
    } catch {
      // valt door naar de fallback
    }
  }
  return { spec: raw.trim().slice(0, 400), lengthM: 4.6 };
}

export interface IdentityVerdict {
  sameVehicle: boolean;
  /** Aparte lakbeoordeling: tint, lichtheid en metallic-karakter. */
  paintMatch: boolean;
  issues: string[];
}

/**
 * Inspecteursvergelijking: kandidaat-beeld langs de bronfoto's.
 *
 * Dit is de poort waar een gesynthetiseerde hoek doorheen moet (is dit nog
 * exact dezelfde auto?) én de detector voor weggevallen details in een
 * cutout (antenne, sierlijst, sensor die de matte opat). De issues gaan bij
 * een afkeuring als feedback terug de volgende generatiepoging in.
 */
export async function compareAgainstSources(
  candidate: ImagePart,
  sources: ImagePart[],
  spec: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<IdentityVerdict> {
  const prompt =
    "The FIRST image is a candidate catalogue image. Every other image is a " +
    `source photo of the real vehicle: ${spec}.\n` +
    "Compare the candidate against the sources like a vehicle inspector. " +
    "Check the exact model and generation, paint colour, wheel design, " +
    "badges, head- and taillights, grille, trim, roof line, mirrors, door " +
    "handles, antennas and sensors. Also check the PROPORTIONS: wheelbase " +
    "versus body length, roof height, overhangs and wheel size must match " +
    "the sources — a stretched, squashed or otherwise distorted body is a " +
    "mismatch. List every detail that is missing, changed, invented or " +
    "distorted in the candidate. Ignore background, framing and shadow. " +
    "The candidate intentionally carries a Carredo dealer plate instead of " +
    "the original licence plate — never report the plate as a difference; " +
    "it is checked elsewhere.\n" +
    "Judge the paint colour SEPARATELY and strictly: compare hue, " +
    "lightness and metallic character. A silver car that renders white or " +
    "cream, a grey that loses its blue cast, or any colour shift relative " +
    "to the sources is a paint mismatch even when the model is right.\n" +
    'Answer with STRICT JSON only, no code fences: {"same_vehicle": ' +
    'boolean, "paint_match": boolean, "issues": string[]} — issues stays ' +
    "empty when everything matches.";
  const raw = await geminiText(
    [candidate, ...sources], prompt, cfg, cacheDir, useCache,
  );
  return parseVerdict(raw);
}

/** Tolerant parsen: modellen verpakken JSON graag alsnog in fences of proza. */
export function parseVerdict(raw: string): IdentityVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as {
        same_vehicle?: unknown;
        paint_match?: unknown;
        issues?: unknown;
      };
      return {
        sameVehicle: obj.same_vehicle === true,
        // ontbreekt het veld (ouder cache-antwoord), dan beslist de
        // deterministische lakmeting alleen — niet dubbel straffen
        paintMatch: obj.paint_match !== false,
        issues: Array.isArray(obj.issues)
          ? obj.issues.filter((i): i is string => typeof i === "string")
          : [],
      };
    } catch {
      // valt door naar de tekstheuristiek
    }
  }
  // geen parsebare JSON: alleen een expliciete ja zonder twijfeltaal telt
  const yes = /"?same_vehicle"?\s*[:=]?\s*true|^\s*yes\b/i.test(raw);
  return { sameVehicle: yes, paintMatch: yes, issues: yes ? [] : [raw.slice(0, 300)] };
}

export interface ProportionVerdict {
  distorted: boolean;
  why: string;
}

/**
 * Gerichte proportie-poort, los van de algemene inspectie.
 *
 * In het waslijstje van compareAgainstSources verdrinkt de proportievraag:
 * de Taycan Cross Turismo kwam er samengedrukt doorheen terwijl badges en
 * velgen wél werden nagekeken. Eén vraag met één focus dwingt het model om
 * echt naar wielbasis, lengte en overhangen te kijken.
 */
export async function checkProportions(
  candidate: ImagePart,
  sources: ImagePart[],
  spec: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<ProportionVerdict> {
  const prompt =
    "The FIRST image is a candidate catalogue image. Every other image is " +
    `a source photo of the real vehicle: ${spec}.\n` +
    "Focus ONLY on body proportions. Compare the candidate against the " +
    "sources on: wheelbase relative to body length, body length relative " +
    "to height, front and rear overhangs, and wheel size relative to the " +
    "body. Is the candidate's body stretched, compressed, shortened or " +
    "squashed in any direction compared to the real vehicle?\n" +
    'Answer with STRICT JSON only, no code fences: {"distorted": boolean, ' +
    '"why": string} — why stays empty when the proportions match.';
  const raw = await geminiText([candidate, ...sources], prompt, cfg, cacheDir, useCache);
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { distorted?: unknown; why?: unknown };
      return {
        distorted: obj.distorted === true,
        why: typeof obj.why === "string" ? obj.why : "",
      };
    } catch {
      // valt door naar de tekstheuristiek
    }
  }
  const bad = /"?distorted"?\s*[:=]?\s*true|^\s*yes\b/i.test(raw);
  return { distorted: bad, why: bad ? raw.slice(0, 300) : "" };
}

export interface PlateVerdict {
  plateOk: boolean;
  issues: string[];
}

/**
 * Plaat-poort: het model monteert de Carredo-plaat zelf tijdens de
 * generatie, dus er moet een aparte controle op zitten dat het resultaat
 * het asset exact reproduceert — op ware grootte, niet uitgerekt, in het
 * perspectief van de bumper. Een fout logo of vervormde tekst is een
 * afkeuring, geen schoonheidsfoutje.
 */
export async function checkPlate(
  candidate: ImagePart,
  plateAsset: ImagePart,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<PlateVerdict> {
  const prompt =
    "The FIRST image is a candidate catalogue photo of a car. The SECOND " +
    "image is the exact Carredo dealer plate that must be mounted on its " +
    "front.\n" +
    "Verify the plate on the car: (1) it reproduces the reference exactly " +
    "— the blue wing logo mark followed by the blue lowercase-style " +
    "'Carredo' logotype on a white plate, plus the green-to-blue leasing " +
    "strip at the bottom. A plate with plain dark CAPITAL letters " +
    "'CARREDO', a missing wing mark, a missing strip, or any other " +
    "typography than the reference is WRONG; (2) it is NOT stretched, " +
    "squashed or warped out of its natural proportions; (3) its size is " +
    "realistic for a standard European front plate on this car (about " +
    "52 cm wide in reality — roughly a third of the car's width, never " +
    "spanning the whole grille); (4) it sits in the car's plate position, " +
    "angled consistently with the bumper perspective.\n" +
    'Answer with STRICT JSON only, no code fences: {"plate_ok": boolean, ' +
    '"issues": string[]} — issues stays empty when the plate is correct.';
  const raw = await geminiText(
    [candidate, plateAsset], prompt, cfg, cacheDir, useCache,
  );
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { plate_ok?: unknown; issues?: unknown };
      return {
        plateOk: obj.plate_ok === true,
        issues: Array.isArray(obj.issues)
          ? obj.issues.filter((i): i is string => typeof i === "string")
          : [],
      };
    } catch {
      // valt door naar de tekstheuristiek
    }
  }
  const ok = /"?plate_ok"?\s*[:=]?\s*true|^\s*yes\b/i.test(raw);
  return { plateOk: ok, issues: ok ? [] : [raw.slice(0, 300)] };
}

export interface QualityVerdict {
  qualityOk: boolean;
  issues: string[];
}

/**
 * Kwaliteitspoort met het anker als standaard: slechte bronfoto's (lage
 * resolutie, ruis, compressie) mogen nooit een zachte of plastic-achtige
 * output opleveren. Een deterministische scherptemaat bleek hier lak-textuur
 * te meten in plaats van kwaliteit (zwarte lak scoort altijd "onscherp"),
 * dus dit is bewust een visueel oordeel tegen een vaste referentie.
 */
export async function checkQuality(
  candidate: ImagePart,
  anchor: ImagePart,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<QualityVerdict> {
  const prompt =
    "The FIRST image is a candidate catalogue photo. The SECOND image is " +
    "the QUALITY REFERENCE: the required standard of professional studio " +
    "photography.\n" +
    "Judge ONLY the image quality and rendering of the candidate — not the " +
    "vehicle, not the composition. It must match the reference standard: " +
    "tack-sharp panel lines and badges, clean realistic reflections, " +
    "believable materials, no blur, no noise, no compression artifacts, no " +
    "soft plasticky toy-like or over-smoothed rendering, no watermark " +
    "remnants. Low-quality source photos are never an excuse — the output " +
    "must look like it was shot in the reference's studio with the " +
    "reference's camera.\n" +
    'Answer with STRICT JSON only, no code fences: {"quality_ok": boolean, ' +
    '"issues": string[]} — issues stays empty when the quality matches.';
  const raw = await geminiText([candidate, anchor], prompt, cfg, cacheDir, useCache);
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { quality_ok?: unknown; issues?: unknown };
      return {
        qualityOk: obj.quality_ok === true,
        issues: Array.isArray(obj.issues)
          ? obj.issues.filter((i): i is string => typeof i === "string")
          : [],
      };
    } catch {
      // valt door naar de tekstheuristiek
    }
  }
  const ok = /"?quality_ok"?\s*[:=]?\s*true|^\s*yes\b/i.test(raw);
  return { qualityOk: ok, issues: ok ? [] : [raw.slice(0, 300)] };
}

const luma = (m: ChannelMeans): number => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;

/**
 * Deterministische lakvergelijking: kandidaat-lak tegen de bron-mediaan.
 *
 * De VLM-inspectie bleek hier te vergeeflijk — zilver dat wit rendert kwam
 * erdoor. Dit meet het: luminantieratio (te licht/te donker) en de
 * tintverhoudingen r/g en b/g (kleurzweem; het koele zilver van de EQE zit
 * in die b/g). Engelstalige melding, want het resultaat gaat als
 * correctie-instructie terug de generatieprompt in.
 */
/**
 * Per-kanaal gains die de kandidaat-lak op de bron-mediaan leggen.
 *
 * Corrigeren in plaats van afkeuren: de meting weet exact hóe de lak
 * afwijkt, en een lineaire gain per kanaal is pure curves, geen generatieve
 * stap. De cap voorkomt dat een fundamenteel verkeerde kleur (rood i.p.v.
 * zilver) stilletjes "gecorrigeerd" wordt. 1.45 sinds de ID.3-case
 * (2026-07-30): bronfoto's in een donkere studio tegenover een synthese in
 * de lichte ankerstudio geven legitiem ×1.4 lichtheidsverschil, en achter
 * de correctie staat nu sowieso een her-inspectie én een nameting.
 */
export function paintCorrectionGains(
  candidate: ChannelMeans,
  reference: ChannelMeans,
  cap = 1.45,
): [number, number, number] {
  const g = (c: number, r: number) =>
    Math.min(cap, Math.max(1 / cap, r / Math.max(1e-6, c)));
  return [
    g(candidate.r, reference.r),
    g(candidate.g, reference.g),
    g(candidate.b, reference.b),
  ];
}

export function paintDeviation(
  candidate: ChannelMeans,
  reference: ChannelMeans,
  cfg: SynthConfig,
): string | null {
  const ratio = luma(candidate) / Math.max(1e-6, luma(reference));
  const dRG = Math.abs(candidate.r / candidate.g - reference.r / reference.g);
  const dBG = Math.abs(candidate.b / candidate.g - reference.b / reference.g);
  const parts: string[] = [];
  if (ratio < cfg.minLumaRatio || ratio > cfg.maxLumaRatio) {
    parts.push(
      `the paint renders ${ratio > 1 ? "lighter" : "darker"} than the source ` +
        `paint (luminance x${ratio.toFixed(2)}, allowed ` +
        `${cfg.minLumaRatio}-${cfg.maxLumaRatio}) — match the exact paint ` +
        "tone of the source photos",
    );
  }
  if (dRG > cfg.maxTintDelta || dBG > cfg.maxTintDelta) {
    parts.push(
      `the paint tint drifts from the source paint (Δr/g ${dRG.toFixed(3)}, ` +
        `Δb/g ${dBG.toFixed(3)}, allowed ${cfg.maxTintDelta}) — keep the ` +
        "exact colour cast of the source photos",
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}
