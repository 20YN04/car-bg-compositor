import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import type { BBox } from "./bbox.js";
import type { DetectConfig, FalConfig, MatteConfig, MatteProvider } from "./config.js";
import { localMaskStats, removeBackgroundLocal } from "./mask-local.js";

export interface MaskStats {
  apiCalls: number;
  cacheHits: number;
  detectCalls: number;
  detectCacheHits: number;
}

export const maskStats: MaskStats = {
  apiCalls: 0,
  cacheHits: 0,
  detectCalls: 0,
  detectCacheHits: 0,
};

export interface CarDetection {
  box: BBox;
  confidence: number; // heuristisch: oppervlak × centraliteit (0–1)
}

export interface DetectedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Kiest dé auto uit de detecties: grootste oppervlak, gewogen met afstand
 * tot het beeldmidden (achtergrondauto's zijn klein en/of excentrisch).
 * Puur en los getest; Florence-2 levert zelf geen confidence-score.
 */
export function selectBestBox(
  boxes: DetectedBox[],
  imgWidth: number,
  imgHeight: number,
  minConfidence: number,
): CarDetection | null {
  let best: CarDetection | null = null;
  for (const b of boxes) {
    if (b.w <= 0 || b.h <= 0) continue;
    const areaFraction = (b.w * b.h) / (imgWidth * imgHeight);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const dx = (cx - imgWidth / 2) / (imgWidth / 2);
    const dy = (cy - imgHeight / 2) / (imgHeight / 2);
    const centrality = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy));
    const confidence = areaFraction * (0.5 + 0.5 * centrality);
    if (confidence >= minConfidence && (!best || confidence > best.confidence)) {
      best = {
        box: {
          left: Math.round(b.x),
          top: Math.round(b.y),
          right: Math.round(b.x + b.w - 1),
          bottom: Math.round(b.y + b.h - 1),
        },
        confidence,
      };
    }
  }
  return best;
}

/**
 * Auto-detectie via Florence-2 open-vocabulary detection, gecachet op de
 * sha256 van de input-bytes. Retourneert null wanneer er geen (voldoende
 * scorende) auto gevonden is — de aanroeper valt dan terug op het oude,
 * onbegrensde gedrag.
 */
export async function getCarBox(
  inputPath: string,
  cacheDir: string,
  detectCfg: DetectConfig,
  useCache: boolean,
): Promise<CarDetection | null> {
  const inputBytes = await readFile(inputPath);
  const hash = createHash("sha256").update(inputBytes).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.carbox.json`);
  if (useCache && existsSync(cachePath)) {
    maskStats.detectCacheHits++;
    return JSON.parse(await readFile(cachePath, "utf8")) as CarDetection | null;
  }

  ensureFalKey();
  const file = new File([new Uint8Array(inputBytes)], path.basename(inputPath), {
    type: inputPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  });
  const imageUrl = await fal.storage.upload(file);
  const result = await fal.subscribe(detectCfg.modelId, {
    input: { image_url: imageUrl, text_input: detectCfg.prompt },
  });
  maskStats.detectCalls++;

  const data = result.data as { results?: { bboxes?: DetectedBox[] } };
  const meta = await sharp(inputBytes).metadata();
  const detection = selectBestBox(
    data.results?.bboxes ?? [],
    meta.width ?? 1,
    meta.height ?? 1,
    detectCfg.minConfidence,
  );
  await writeFile(cachePath, JSON.stringify(detection));
  return detection;
}

let falConfigured = false;
let falUnavailable: string | null = null;

/**
 * Circuit breaker op de fal-key. Een ongeldige of opgebruikte key laat élke
 * fal-call opnieuw proberen met backoff; over een batch van 13 beelden × 6
 * optionele stappen loopt dat op tot minutenlang wachten op een fout die na
 * de eerste al vaststaat. Eén auth-fout zet alle verdere fal-stappen uit.
 */
export function noteFalFailure(err: unknown): void {
  if (falUnavailable) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (!/forbidden|unauthorized|401|403/i.test(msg)) return;
  falUnavailable = msg;
  console.warn(
    `  ⚠ fal.ai wees de key af (${msg}) — alle verdere fal-stappen ` +
      `(detectie, ruit-tint, plaat-anonimisatie, AI-checks) worden overgeslagen`,
  );
}

export function isFalAvailable(): boolean {
  return falUnavailable === null;
}

export function ensureFalKey(): void {
  if (falUnavailable) throw new Error(`fal.ai overgeslagen: ${falUnavailable}`);
  if (falConfigured) return;
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new Error(
      "FAL_KEY ontbreekt. Maak een .env aan op basis van .env.example en " +
        "zet daar je fal.ai API-key in (https://fal.ai/dashboard/keys).",
    );
  }
  fal.config({ credentials: key });
  falConfigured = true;
}

/**
 * Haalt de cutout (PNG met alfakanaal) op via het geconfigureerde
 * matte-model (BiRefNet of BRIA RMBG 2.0), gecachet op sha256 van de
 * input-bytes — per provider een eigen cache-entry, zodat herhaald draaien
 * nooit opnieuw de API aanroept.
 */
export async function getCutout(
  inputPath: string,
  cacheDir: string,
  falCfg: FalConfig,
  matteCfg: MatteConfig,
  useCache: boolean,
): Promise<Buffer> {
  const provider: MatteProvider = matteCfg.provider;
  if (provider === "api4ai") {
    throw new Error(
      "MATTE.provider 'api4ai' is nog niet geïmplementeerd (stap B — alleen als fal-rmbg onvoldoende blijkt)",
    );
  }
  // lokale matte via Python rembg (u2net): gratis, geen API-key, eigen cache.
  // Randkwaliteit ligt onder BiRefNet/RMBG 2.0 — vooral op spaken en antennes —
  // maar de compositing eromheen is identiek, dus de garantie blijft staan.
  if (provider === "rembg") {
    const before = { calls: localMaskStats.calls, hits: localMaskStats.cacheHits };
    const cutout = await removeBackgroundLocal(inputPath, useCache, matteCfg.rembgModel);
    // in dezelfde tellers als de fal-providers, zodat de runsamenvatting
    // niet stilletjes 0 calls rapporteert
    maskStats.apiCalls += localMaskStats.calls - before.calls;
    maskStats.cacheHits += localMaskStats.cacheHits - before.hits;
    return cutout;
  }
  const inputBytes = await readFile(inputPath);
  const hash = createHash("sha256").update(inputBytes).digest("hex");
  const suffix = provider === "fal-rmbg" ? ".rmbg.png" : ".png";
  const cachePath = path.join(cacheDir, `${hash}${suffix}`);

  if (useCache && existsSync(cachePath)) {
    maskStats.cacheHits++;
    return readFile(cachePath);
  }

  ensureFalKey();
  const file = new File([inputBytes], path.basename(inputPath), {
    type: inputPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  });
  const imageUrl = await fal.storage.upload(file);

  const result =
    provider === "fal-rmbg"
      ? await fal.subscribe(matteCfg.rmbgModelId, {
          input: { image_url: imageUrl },
        })
      : await fal.subscribe(falCfg.modelId, {
          input: {
            image_url: imageUrl,
            model: falCfg.model,
            operating_resolution: falCfg.operatingResolution,
            output_format: falCfg.outputFormat,
            refine_foreground: falCfg.refineForeground,
          },
        });
  maskStats.apiCalls++;

  const data = result.data as { image?: { url?: string } };
  if (!data.image?.url) {
    throw new Error(
      `${provider} gaf geen image terug: ${JSON.stringify(result.data).slice(0, 300)}`,
    );
  }
  const response = await fetch(data.image.url);
  if (!response.ok) {
    throw new Error(`download cutout mislukt: HTTP ${response.status}`);
  }
  const cutout = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, cutout);
  return cutout;
}
