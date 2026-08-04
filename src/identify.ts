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
  /**
   * Badges apart én blokkerend. Als onderdeel van de issues-lijst telde een
   * verzonnen badge als "kleine afwijking" en publiceerde de terugvalroute in
   * car-multiview de AMG mét een 4MATIC-badge die de echte auto niet voert —
   * nadat de poort hem meermaals correct had benoemd (2026-08-04). Een
   * verzonnen, verdubbelde of ontbrekende badge is een verkeerde voorstelling
   * van de auto, geen cosmetiek.
   */
  badgesMatch: boolean;
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
  // Alleen de modelnaam, niet de volledige spec: de inspecteur las vroeger
  // dezelfde beschrijving als de generator en citeerde die terug, waarna hij
  // twaalf keer op rij een correcte BMW i5 Touring afkeurde als X1 omdat mijn
  // spec die namen noemde. Een wielbasis-meting bewees dat de kandidaat
  // klopte (2026-08-03). Hij moet toetsen aan de FOTO'S.
  const korteSpec = spec.split(/[—.]/)[0]?.trim().slice(0, 90) || spec.slice(0, 90);
  const prompt =
    "The FIRST image is a candidate catalogue image. Every other image is a " +
    `source photo of the real vehicle (${korteSpec}).\n` +
    "The source photos are the ONLY truth. Judge the candidate against what " +
    "you see in them, never against expectations from the model name.\n" +
    "Judge ONLY what the candidate's viewing angle could show: a badge or " +
    "detail on a panel that is not visible from this angle (a bonnet star " +
    "on a pure side profile, a boot badge from the front) is NEVER " +
    "'missing' — different angles show different panels.\n" +
    "Compare the candidate against the sources like a vehicle inspector. " +
    "Check the exact model and generation, paint colour, wheel design, " +
    "badges, head- and taillights, grille, trim, roof line, mirrors, door " +
    "handles, antennas and sensors. Also check the PROPORTIONS: wheelbase " +
    "versus body length, roof height, overhangs and wheel size must match " +
    "the sources — a stretched, squashed or otherwise distorted body is a " +
    "mismatch. BADGES: every badge or lettering visible on the candidate " +
    "must also be visible on the source photos, on the SAME panel — a badge " +
    "that appears only on the candidate, or a second copy of a badge the " +
    "sources show once, is an invented detail and a mismatch, even when the " +
    "badge text matches the model name. " +
    "List every detail that is missing, changed, invented or " +
    "distorted in the candidate. Ignore background, framing and shadow. " +
    "The candidate intentionally carries a Carredo dealer plate instead of " +
    "the original licence plate — never report the plate as a difference; " +
    "it is checked elsewhere.\n" +
    "Judge the paint colour SEPARATELY and strictly: compare hue, " +
    "lightness and metallic character. A silver car that renders white or " +
    "cream, a grey that loses its blue cast, or any colour shift relative " +
    "to the sources is a paint mismatch even when the model is right.\n" +
    "Report badges in the separate field `badges_match`: false when any " +
    "badge or lettering is invented, duplicated, moved to another panel or " +
    "missing relative to the source photos — matching the model name is no " +
    "excuse. Dealer stickers advertising the selling dealer are " +
    "intentionally absent from the candidate — never count their absence " +
    "as a badge mismatch.\n" +
    'Answer with STRICT JSON only, no code fences: {"same_vehicle": ' +
    'boolean, "paint_match": boolean, "badges_match": boolean, ' +
    '"issues": string[]} — issues stays ' +
    "empty when everything matches.";
  // Twee stemmen, en bij onenigheid een derde. Eén oordeel is wisselvallig:
  // op de BMW i5 Touring keurde de inspectie twaalf keer op rij af als
  // "compacte X1", terwijl de kandidaat bij eigen inspectie onmiskenbaar de
  // juiste lange break was (2026-08-03). Een enkele mening mag geen goed
  // beeld vernietigen; drie eensgezinde stemmen mag dat wel.
  const ask = async (pass: number) =>
    parseVerdict(await geminiText(
      [candidate, ...sources],
      `${prompt}\n(inspection pass ${pass} — judge independently)`,
      cfg, cacheDir, useCache,
    ));
  const first = await ask(1);
  if (first.sameVehicle) return first;
  const second = await ask(2);
  if (second.sameVehicle) return second;
  return first;
}

/** Tolerant parsen: modellen verpakken JSON graag alsnog in fences of proza. */
export function parseVerdict(raw: string): IdentityVerdict {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as {
        same_vehicle?: unknown;
        badges_match?: unknown;
        paint_match?: unknown;
        issues?: unknown;
      };
      return {
        sameVehicle: obj.same_vehicle === true,
        // ontbreekt het veld (ouder cache-antwoord), dan niet blokkeren
        badgesMatch: obj.badges_match !== false,
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
  return {
    sameVehicle: yes, paintMatch: yes, badgesMatch: true,
    issues: yes ? [] : [raw.slice(0, 300)],
  };
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
    "strip at the bottom. It is a DEALER plate: a blue EU band on the left, " +
    "a circle of stars, a country letter or any registration characters are " +
    "WRONG and must be reported. A plate with plain dark CAPITAL letters " +
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
  // Deze poort vroeg vroeger of de kandidaat "even scherp als de referentie"
  // was, met het anker — een zwarte AMG — als maatstaf. Dat oordeel bleek
  // onbetrouwbaar én onuitvoerbaar: op de witte VW ID.3 sneuvelden zes van de
  // zes pogingen op dezelfde klacht, terwijl de gemeten detaildichtheid van de
  // uitvoer gelijk was aan die van de échte studiofoto's (2026-08-03).
  // Scherpte wordt nu gemeten in measure.ts; hier vragen we alleen nog naar
  // wat een meting niet kan zien.
  const prompt =
    "The FIRST image is a candidate catalogue photo. The SECOND image is a " +
    "reference showing the intended studio look.\n" +
    "Do NOT judge sharpness, resolution, focus or how crisp the panel lines " +
    "look — those are measured separately and are not your concern. Do NOT " +
    "compare the two vehicles; they are different cars.\n" +
    "Report ONLY concrete rendering faults you can point at in the candidate: " +
    "visible compression blocks or banding, chromatic noise, warped or " +
    "duplicated structures, melted or nonsensical geometry, garbled lettering " +
    "outside the number plate, stray objects, watermark or logo remnants from " +
    "another source, and areas blown to pure white with no detail left.\n" +
    "The candidate intentionally carries a Carredo dealer plate in the car's " +
    "own plate position: a white plate with a blue wing mark, the blue " +
    "'Carredo' logotype and a green-to-blue strip. That plate belongs there " +
    "and is checked elsewhere — never report it as a watermark, a sticker, an " +
    "extraneous element or a rendering fault.\n" +
    "If you cannot point at a specific fault, the quality is fine.\n" +
    'Answer with STRICT JSON only, no code fences: {"quality_ok": boolean, ' +
    '"issues": string[]} — issues stays empty when you found no fault.';
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
  lumaOnly = false,
): [number, number, number] {
  const g = (c: number, r: number) =>
    Math.min(cap, Math.max(1 / cap, r / Math.max(1e-6, c)));
  if (lumaOnly) {
    const l = (m: ChannelMeans) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
    const k = g(l(candidate), l(reference));
    return [k, k, k];
  }
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
  checkTint = true,
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
  if (checkTint && (dRG > cfg.maxTintDelta || dBG > cfg.maxTintDelta)) {
    parts.push(
      `the paint tint drifts from the source paint (Δr/g ${dRG.toFixed(3)}, ` +
        `Δb/g ${dBG.toFixed(3)}, allowed ${cfg.maxTintDelta}) — keep the ` +
        "exact colour cast of the source photos",
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

export interface BadgeVoteVerdict {
  badgesOk: boolean;
  issues: string[];
}

/**
 * Toegewijde badgepoort met twee stemmen.
 *
 * Waarom. Het badges_match-veld in de brede identiteitsinspectie flipte per
 * poging: de verzonnen 4MATIC werd in drie van zes pogingen benoemd en in de
 * andere doorgelaten, en een verdubbelde EQE-badge glipte er daarna alsnog
 * doorheen (2026-08-04). Eén veld tussen tien andere vragen krijgt niet de
 * aandacht die een detail van twintig pixels vraagt. Dit is dezelfde les als
 * bij het plaatwerk: een toegewijde, kleine vraag met ALTIJD twee
 * onafhankelijke stemmen, en alleen blokkeren als beide stemmen het eens
 * zijn — één wisselvallige stem mag geen goed beeld afkeuren, en één milde
 * stem mag geen fout beeld doorlaten.
 *
 * Een mislukte aanroep telt als schoon: infrastructuur keurt nooit af.
 */
export async function checkBadgesVoted(
  candidate: ImagePart,
  sources: ImagePart[],
  korteSpec: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<BadgeVoteVerdict> {
  const prompt = (pass: number): string =>
    "The FIRST image is a generated catalogue photo. The other images are " +
    `real photos of the same physical car: ${korteSpec}.\n` +
    "Enumerate EVERY badge, emblem and piece of model lettering visible on " +
    "the bodywork of the FIRST image (ignore the licence/Carredo plate and " +
    "anything inside the car). For each: does at least one real photo show " +
    "that same badge on that same body panel? Duplicates count as " +
    "unsupported: when the candidate shows the same lettering on MORE " +
    "panels than the real photos do, the extra copies are unsupported.\n" +
    "Blurry real photos: a badge whose PRESENCE is visible on the real car " +
    "supports a badge in that spot even when its text is too small to read. " +
    "In that case the candidate's lettering is acceptable ONLY when it is " +
    "the badge the FACTORY places at that position on this exact model and " +
    "trim — factory knowledge fills in unreadable text, it never adds " +
    "badges the photos don't show at all.\n" +
    `(inspection pass ${pass} — judge independently)\n` +
    'Answer with STRICT JSON only, no code fences: {"unsupported": ' +
    '[{"text": string, "where": string}]} — empty when every candidate ' +
    "badge is supported by the real photos.";
  const ask = async (pass: number): Promise<{ text: string; where: string }[] | null> => {
    try {
      const raw = await geminiText([candidate, ...sources], prompt(pass), cfg, cacheDir, useCache);
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]) as { unsupported?: unknown };
      if (!Array.isArray(obj.unsupported)) return [];
      return obj.unsupported
        .filter((u): u is { text?: unknown; where?: unknown } => typeof u === "object" && u !== null)
        .map((u) => ({ text: String(u.text ?? "?"), where: String(u.where ?? "?") }));
    } catch {
      return null;
    }
  };
  const [a, b] = await Promise.all([ask(1), ask(2)]);
  if (a === null || b === null) return { badgesOk: true, issues: [] };
  // alleen blokkeren bij overeenstemming: dezelfde tekst in beide stemmen
  const inBeide = a.filter((x) =>
    b.some((y) => y.text.toLowerCase().replace(/\s+/g, "") === x.text.toLowerCase().replace(/\s+/g, "")),
  );
  return {
    badgesOk: inBeide.length === 0,
    issues: inBeide.map(
      (x) => `unsupported badge "${x.text}" (${x.where}) — not on the real car at that spot`,
    ),
  };
}

export interface BadgeCensusVerdict {
  badgesOk: boolean;
  issues: string[];
}

/**
 * Badge-telling op uitvergrote rastercrops, getoetst aan de beschrijving.
 *
 * Waarom. Elke vol-formaat-poort — het brede badges_match-veld én de
 * toegewijde stempoort — miste een verdubbelde EQE-badge van twintig pixels;
 * op een crop van 1400px breed is diezelfde dubbel onmiskenbaar. Resolutie
 * los je niet op met meer stemmen, wel met zoom (2026-08-04).
 *
 * De maatstaf is hier bewust de BESCHRIJVING, niet de bronfoto's: de
 * hiërarchie is aanwezigheid-uit-foto's, tekst-uit-fabriekskennis, en de
 * spec is waar die twee samenkomen (Yentl, 2026-08-04). De spec somt de
 * badges limitatief op; alles wat de crops daarbuiten tonen — verkeerde
 * tekst, verkeerd paneel, of een tweede exemplaar waar er één hoort — is
 * een overtreding. Twee stemmen, alleen blokkeren bij overeenstemming.
 * Een mislukte aanroep telt als schoon.
 */
export async function checkBadgeCensus(
  crops: ImagePart[],
  spec: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<BadgeCensusVerdict> {
  if (crops.length === 0) return { badgesOk: true, issues: [] };
  const prompt = (pass: number): string =>
    `The ${crops.length} images are enlarged crops of ONE generated ` +
    "catalogue photo of a car (they overlap slightly).\n" +
    "The car's description states exactly which badges the real car " +
    `carries:\n---\n${spec}\n---\n` +
    "Step 1: from the description, list the allowed badges and where they " +
    "sit. Step 2: list EVERY badge, emblem and model lettering instance " +
    "visible in the crops, with its panel (count an instance once even " +
    "when overlapping crops show it twice; ignore the licence/Carredo " +
    "plate, brand star and grille emblems, and anything behind glass; " +
    "ignore EVERYTHING on wheels, tyres and brake calipers — factory " +
    "caliper and rim lettering is judged by the wheel gate, not here). " +
    "Step 3: report every instance the description does not allow. A " +
    "violation is ONLY: lettering the description does not mention at all, " +
    "lettering on a clearly DIFFERENT body panel than described, or MORE " +
    "instances than the description allows (a stacked duplicate). NOT a " +
    "violation: small position differences within the same area (door edge " +
    "versus wing edge counts as the same area), finish, brightness or size " +
    "nuances — chrome lettering photographs bright against dark paint in a " +
    "studio, that is physics, not a wrong badge.\n" +
    `(inspection pass ${pass} — judge independently)\n` +
    'Answer with STRICT JSON only, no code fences: {"violations": ' +
    '[{"text": string, "where": string}]} — empty when the crops match ' +
    "the description.";
  const ask = async (pass: number): Promise<{ text: string; where: string }[] | null> => {
    try {
      const raw = await geminiText(crops, prompt(pass), cfg, cacheDir, useCache);
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]) as { violations?: unknown };
      if (!Array.isArray(obj.violations)) return [];
      return obj.violations
        .filter((u): u is { text?: unknown; where?: unknown } => typeof u === "object" && u !== null)
        .map((u) => ({ text: String(u.text ?? "?"), where: String(u.where ?? "?") }));
    } catch {
      return null;
    }
  };
  // Meerderheid op BESTAAN van een overtreding, niet op tekstgelijkheid.
  // De verdubbelde badge rendert vaak verhaspeld ("EGE" naast "EQE"); twee
  // stemmen die hem allebei zien maar anders lezen, waren het onder de oude
  // regel "oneens" en spraken samen vrij — zo kwam de dubbel er in poging 2
  // alsnog door (2026-08-04). Nu: twee stemmen eens = blok, verdeeld = derde
  // stem beslist, twee schone stemmen = door.
  const [a, b] = await Promise.all([ask(1), ask(2)]);
  if (a === null || b === null) return { badgesOk: true, issues: [] };
  let stemmen = [a, b];
  if ((a.length === 0) !== (b.length === 0)) {
    const c = await ask(3);
    if (c === null) return { badgesOk: true, issues: [] };
    stemmen = [a, b, c];
  }
  const voor = stemmen.filter((v) => v.length > 0).length;
  const blok = voor >= 2;
  const alle = stemmen.flat();
  return {
    badgesOk: !blok,
    issues: blok
      ? [...new Set(alle.map((x) => `badge violates the description: "${x.text}" (${x.where})`))]
      : [],
  };
}
