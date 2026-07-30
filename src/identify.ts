import type { GeminiConfig, SynthConfig } from "./config.js";
import { geminiText, type ImagePart } from "./gemini.js";
import type { ChannelMeans } from "./harmonize.js";

/**
 * Exacte voertuigidentificatie uit de hele fotoset.
 *
 * De spec gaat mee in elke volgende prompt (synthese én vergelijking) zodat
 * het model niet per call opnieuw hoeft te raden welke auto het ziet — de
 * fout die eerder een Taycan in een generiek "sports sedan" veranderde.
 */
export async function identifyVehicle(
  refs: ImagePart[],
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<string> {
  const prompt =
    "These photos all show the same vehicle. Identify it exactly: make, " +
    "model, generation/body code, trim level if visible, paint colour, " +
    "wheel design and size, and any visible options (roof rails, spoiler, " +
    "badges, trim accents, panoramic roof). Answer in one dense line, no " +
    "preamble.";
  return (await geminiText(refs, prompt, cfg, cacheDir, useCache)).trim();
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
    "handles, antennas and sensors. List every detail that is missing, " +
    "changed or invented in the candidate. Ignore background, framing, " +
    "shadow and licence-plate contents — those are handled elsewhere.\n" +
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
 * afwijkt, en een lineaire gain per kanaal is dezelfde klasse ingreep als
 * harmonize — pure curves, geen generatieve stap. De cap voorkomt dat een
 * fundamenteel verkeerde kleur (rood i.p.v. zilver) stilletjes "gecorrigeerd"
 * wordt: zo'n kandidaat hoort door de meting afgekeurd te blijven.
 */
export function paintCorrectionGains(
  candidate: ChannelMeans,
  reference: ChannelMeans,
  cap = 1.3,
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
