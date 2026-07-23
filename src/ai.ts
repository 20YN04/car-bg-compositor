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
}

export const aiStats: AiStats = {
  detectCalls: 0,
  detectCacheHits: 0,
  vlmCalls: 0,
  vlmCacheHits: 0,
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
 * Nummerplaatdetectie via Florence-2 phrase grounding. Gecachet op de
 * sha256 van de input-bytes — herhaald draaien kost geen credits.
 */
export async function detectPlates(
  imageBytes: Buffer,
  cacheDir: string,
  aiCfg: AiConfig,
  useCache: boolean,
): Promise<PlateBox[]> {
  const hash = createHash("sha256").update(imageBytes).digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.plates.json`);
  if (useCache && existsSync(cachePath)) {
    aiStats.detectCacheHits++;
    return JSON.parse(await readFile(cachePath, "utf8")) as PlateBox[];
  }

  const imageUrl = await uploadImage(imageBytes, "plate-detect.jpg");
  const result = await fal.subscribe(aiCfg.detectionModelId, {
    input: { image_url: imageUrl, text_input: "license plate" },
  });
  aiStats.detectCalls++;

  const data = result.data as {
    results?: { bboxes?: { x: number; y: number; w: number; h: number; label?: string }[] };
  };
  const plates: PlateBox[] = (data.results?.bboxes ?? []).map((b) => ({
    x: b.x,
    y: b.y,
    w: b.w,
    h: b.h,
  }));
  await writeFile(cachePath, JSON.stringify(plates));
  return plates;
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
