import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import type { FalConfig, MatteConfig, MatteProvider } from "./config.js";
import { localMaskStats, removeBackgroundLocal } from "./mask-local.js";

export interface MaskStats {
  apiCalls: number;
  cacheHits: number;
}

export const maskStats: MaskStats = {
  apiCalls: 0,
  cacheHits: 0,
};

let falConfigured = false;
let falUnavailable: string | null = null;

/**
 * Circuit breaker op de fal-key. Een ongeldige of opgebruikte key laat élke
 * fal-call opnieuw proberen met backoff; over een set bronfoto's loopt dat
 * op tot minutenlang wachten op een fout die na de eerste al vaststaat.
 */
export function noteFalFailure(err: unknown): void {
  if (falUnavailable) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (!/forbidden|unauthorized|401|403/i.test(msg)) return;
  falUnavailable = msg;
  console.warn(
    `  ⚠ fal.ai wees de key af (${msg}) — verdere matte-calls worden ` +
      `overgeslagen; overweeg MATTE.provider "rembg" (lokaal, gratis)`,
  );
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
 * matte-model, gecachet op sha256 van de input-bytes. In deze pipeline is
 * de cutout uitsluitend nog het meetinstrument voor de lakpoort: hij
 * selecteert de autopixels waarvan de gemiddelde kleur wordt vergeleken.
 */
export async function getCutout(
  inputPath: string,
  cacheDir: string,
  falCfg: FalConfig,
  matteCfg: MatteConfig,
  useCache: boolean,
): Promise<Buffer> {
  const provider: MatteProvider = matteCfg.provider;
  // lokale matte via Python rembg: gratis, geen API-key, eigen cache.
  // Randkwaliteit ligt onder RMBG 2.0, maar voor een kleurgemiddelde is dat
  // ruim voldoende.
  if (provider === "rembg") {
    const before = { calls: localMaskStats.calls, hits: localMaskStats.cacheHits };
    const cutout = await removeBackgroundLocal(inputPath, useCache, matteCfg.rembgModel);
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
