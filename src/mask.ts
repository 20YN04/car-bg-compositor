import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import type { BBox } from "./bbox.js";
import type { DetectConfig, FalConfig } from "./config.js";

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

export function ensureFalKey(): void {
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
 * Haalt de cutout (PNG met alfakanaal) op via fal.ai BiRefNet, gecachet op
 * sha256 van de input-bytes zodat herhaald draaien nooit opnieuw de API
 * aanroept.
 */
export async function getCutout(
  inputPath: string,
  cacheDir: string,
  falCfg: FalConfig,
  useCache: boolean,
): Promise<Buffer> {
  const inputBytes = await readFile(inputPath);
  const hash = createHash("sha256").update(inputBytes).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.png`);

  if (useCache && existsSync(cachePath)) {
    maskStats.cacheHits++;
    return readFile(cachePath);
  }

  ensureFalKey();
  const file = new File([inputBytes], path.basename(inputPath), {
    type: inputPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
  });
  const imageUrl = await fal.storage.upload(file);

  const result = await fal.subscribe(falCfg.modelId, {
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
      `BiRefNet gaf geen image terug: ${JSON.stringify(result.data).slice(0, 300)}`,
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
