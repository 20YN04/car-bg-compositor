import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import type { FalConfig } from "./config.js";

export interface MaskStats {
  apiCalls: number;
  cacheHits: number;
}

export const maskStats: MaskStats = { apiCalls: 0, cacheHits: 0 };

let falConfigured = false;

function ensureFalKey(): void {
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
