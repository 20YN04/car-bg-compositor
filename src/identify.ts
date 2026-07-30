import type { GeminiConfig } from "./config.js";
import { geminiText, type ImagePart } from "./gemini.js";

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
    'Answer with STRICT JSON only, no code fences: {"same_vehicle": ' +
    'boolean, "issues": string[]} — issues stays empty when everything ' +
    "matches.";
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
        issues?: unknown;
      };
      return {
        sameVehicle: obj.same_vehicle === true,
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
  return { sameVehicle: yes, issues: yes ? [] : [raw.slice(0, 300)] };
}
