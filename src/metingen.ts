/**
 * Meetdossier: per foto één keer meten, daarna onthouden.
 *
 * Waarom dit bestaat. De bronmetingen (classificatie via Gemini, lakmeting
 * via de fal-matte, detaildichtheid, wielbasis via Florence) zijn per foto
 * duur maar per foto ook onveranderlijk — dezelfde bytes geven hetzelfde
 * antwoord. Toch maten de thumbnail- en rondgang-service dezelfde foto's
 * allebei opnieuw, elk in hun eigen cache, en het fal-saldo liep er twee
 * keer op leeg (2026-08-04). Dit dossier legt de uitkomst per inhoudshash
 * vast in een deelbare map: wijs beide services met METINGEN_DIR naar
 * dezelfde plek (in compose: één gedeeld volume) en elke foto wordt in het
 * hele systeem nog precies één keer gemeten.
 *
 * Bewust per fóto en niet per auto: dezelfde foto duikt bij dealers in
 * meerdere listings op, en een automap kan groeien zonder het dossier
 * ongeldig te maken.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FotoMeting {
  /** classificatie: interior | exterior | other, plus vlaggen */
  classify?: {
    kind: string;
    closeUp: boolean;
    redacted: boolean;
    redactedWhere: string;
  };
  /** alfagewogen laksgemiddelde van de matte */
  paint?: { r: number; g: number; b: number };
  /** Laplaciaan-detaildichtheid */
  detail?: number;
  /** wielbasis/wieldiameter-verhouding, null = niet meetbaar op deze foto */
  wheelRatio?: number | null;
}

const DIR = process.env["METINGEN_DIR"] ?? "./metingen";

export function fotoHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 24);
}

async function lees(hash: string): Promise<FotoMeting> {
  const p = path.join(DIR, `${hash}.json`);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(await readFile(p, "utf8")) as FotoMeting;
  } catch {
    return {}; // kapot dossier = opnieuw meten, nooit blokkeren
  }
}

async function schrijf(hash: string, m: FotoMeting): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(path.join(DIR, `${hash}.json`), JSON.stringify(m));
  } catch {
    // niet kunnen schrijven mag een run nooit breken
  }
}

/**
 * Haalt één veld uit het dossier of meet het en legt het vast. `meet` wordt
 * alleen aangeroepen wanneer het veld ontbreekt; een gefaalde meting wordt
 * niet vastgelegd zodat een hik later gewoon opnieuw geprobeerd wordt.
 */
export async function onthoud<K extends keyof FotoMeting>(
  bytes: Buffer,
  veld: K,
  meet: () => Promise<FotoMeting[K]>,
): Promise<FotoMeting[K]> {
  const hash = fotoHash(bytes);
  const dossier = await lees(hash);
  const bestaand = dossier[veld];
  if (bestaand !== undefined) return bestaand;
  const waarde = await meet();
  if (waarde !== undefined) {
    dossier[veld] = waarde;
    await schrijf(hash, dossier);
  }
  return waarde;
}
