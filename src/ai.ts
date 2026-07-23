import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import type { AiConfig } from "./config.js";
import { ensureFalKey } from "./mask.js";

export interface AiStats {
  detectCalls: number;
  detectCacheHits: number;
  vlmCalls: number;
  vlmCacheHits: number;
  segmentCalls: number;
  segmentCacheHits: number;
}

export const aiStats: AiStats = {
  detectCalls: 0,
  detectCacheHits: 0,
  vlmCalls: 0,
  vlmCacheHits: 0,
  segmentCalls: 0,
  segmentCacheHits: 0,
};

export interface PlateBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

async function uploadImage(bytes: Buffer, name: string): Promise<string> {
  ensureFalKey();
  return fal.storage.upload(
    new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }),
  );
}

/**
 * Objectdetectie via Florence-2 phrase grounding, gecachet op sha256 van de
 * input-bytes + cacheSuffix — herhaald draaien kost geen credits.
 */
async function detectObjects(
  imageBytes: Buffer,
  prompt: string,
  cacheSuffix: string,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<PlateBox[]> {
  const hash = createHash("sha256").update(imageBytes).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.${cacheSuffix}.json`);
  if (useCache && existsSync(cachePath)) {
    aiStats.detectCacheHits++;
    return JSON.parse(await readFile(cachePath, "utf8")) as PlateBox[];
  }

  const imageUrl = await uploadImage(imageBytes, `${cacheSuffix}.jpg`);
  const result = await fal.subscribe(aiCfg.detectionModelId, {
    input: { image_url: imageUrl, text_input: prompt },
  });
  aiStats.detectCalls++;

  const data = result.data as {
    results?: { bboxes?: { x: number; y: number; w: number; h: number; label?: string }[] };
  };
  const boxes: PlateBox[] = (data.results?.bboxes ?? []).map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  }));
  await writeFile(cachePath, JSON.stringify(boxes));
  return boxes;
}

export async function detectPlates(
  imageBytes: Buffer,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<PlateBox[]> {
  return detectObjects(imageBytes, "license plate", "plates", cacheDir, aiCfg, useCache);
}

export async function detectWheels(
  imageBytes: Buffer,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<PlateBox[]> {
  return detectObjects(imageBytes, "wheel", "wheels", cacheDir, aiCfg, useCache);
}

export async function detectWindows(
  imageBytes: Buffer,
  prompt: string,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<PlateBox[]> {
  return detectObjects(imageBytes, prompt, "windows", cacheDir, aiCfg, useCache);
}

/**
 * SAM2-segmentatie met box-prompts; geeft het gecombineerde masker (PNG,
 * wit = segment) terug. Gecachet op sha256 van beeld + boxes.
 */
export async function segmentByBoxes(
  imageBytes: Buffer,
  boxes: PlateBox[],
  segmentModelId: string,
  cacheDir: string,
  useCache: boolean,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(imageBytes)
    .update(JSON.stringify(boxes))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.segmask.png`);
  if (useCache && existsSync(cachePath)) {
    aiStats.segmentCacheHits++;
    return readFile(cachePath);
  }

  const imageUrl = await uploadImage(imageBytes, "segment.jpg");
  const result = await fal.subscribe(segmentModelId, {
    input: {
      image_url: imageUrl,
      box_prompts: boxes.map((b) => ({
        x_min: Math.round(b.x),
        y_min: Math.round(b.y),
        x_max: Math.round(b.x + b.w),
        y_max: Math.round(b.y + b.h),
      })),
      apply_mask: false,
      output_format: "png",
    },
  });
  aiStats.segmentCalls++;

  const data = result.data as { image?: { url?: string } };
  if (!data.image?.url) {
    throw new Error(
      `SAM2 gaf geen masker terug: ${JSON.stringify(result.data).slice(0, 300)}`,
    );
  }
  const response = await fetch(data.image.url);
  if (!response.ok) {
    throw new Error(`download segmentmasker mislukt: HTTP ${response.status}`);
  }
  const mask = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, mask);
  return mask;
}

export interface YesNoResult {
  yes: boolean;
  answer: string;
}

/**
 * Ja/nee-vraag over een beeld via een klein vision-language model.
 * Gecachet op sha256 van beeld + vraag, zodat alleen een nieuw beeld of een
 * nieuwe vraag een API-call kost.
 */
export async function visualYesNo(
  imageBytes: Buffer,
  prompt: string,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<YesNoResult> {
  const hash = createHash("sha256").update(imageBytes).update(prompt).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.vlm.json`);
  if (useCache && existsSync(cachePath)) {
    aiStats.vlmCacheHits++;
    return JSON.parse(await readFile(cachePath, "utf8")) as YesNoResult;
  }

  const imageUrl = await uploadImage(imageBytes, "vlm-query.jpg");
  const result = await fal.subscribe(aiCfg.vlmModelId, {
    input: { image_url: imageUrl, prompt },
  });
  aiStats.vlmCalls++;

  const answer = String((result.data as { output?: string }).output ?? "").trim();
  const parsed: YesNoResult = { yes: /^\s*yes\b/i.test(answer), answer };
  await writeFile(cachePath, JSON.stringify(parsed));
  return parsed;
}
