import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import type { QwenConfig } from "./config.js";
import { ensureFalKey } from "./mask.js";

export interface QwenStats {
  calls: number;
  cacheHits: number;
}

export const qwenStats: QwenStats = { calls: 0, cacheHits: 0 };

/**
 * Scène-generatie via Qwen-Image-Edit (fal-ai/qwen-image-edit).
 *
 * Waarom deze naast FLUX Fill en Gemini: Qwen wordt in vergelijkingen
 * consequent aangewezen als het model voor "pixel-level accuracy — product,
 * e-commerce, technical", terwijl Nano Banana als "snelst, ruilt precisie in"
 * geldt. Dat sluit aan bij wat we hier nodig hebben.
 *
 * Twee praktische voordelen boven de Gemini-route:
 *
 *   image_size accepteert landscape_4_3, dus de output komt in de
 *   canvasverhouding binnen. Gemini leverde 3:2 op een 4:3 canvas, waarna de
 *   cover-crop de gegenereerde vloerlijn wegschoof onder de teruggeplakte auto.
 *
 *   seed gaat mee in het request, dus de reseed bij afkeuring doet echt iets.
 *
 * Qwen kent geen maskerparameter — het is een instructie-editor, geen
 * inpainter. De bescherming komt dus volledig van de paste-back: de originele
 * autopixels gaan er na afloop pixel-exact overheen.
 */
export async function generateSceneQwen(
  imagePng: Buffer,
  prompt: string,
  cfg: QwenConfig,
  cacheDir: string,
  useCache: boolean,
  seed: number,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(imagePng)
    .update(prompt)
    .update(cfg.modelId)
    .update(cfg.imageSize)
    .update(String(seed))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.qwen.png`);
  if (useCache && existsSync(cachePath)) {
    qwenStats.cacheHits++;
    return readFile(cachePath);
  }

  ensureFalKey();
  const imageUrl = await fal.storage.upload(
    new File([new Uint8Array(imagePng)], "qwen-input.png", { type: "image/png" }),
  );
  const result = await fal.subscribe(cfg.modelId, {
    input: {
      image_url: imageUrl,
      prompt,
      negative_prompt: cfg.negativePrompt,
      image_size: cfg.imageSize,
      num_inference_steps: cfg.steps,
      guidance_scale: cfg.guidanceScale,
      seed,
      output_format: "png",
      num_images: 1,
    },
  });
  qwenStats.calls++;

  const data = result.data as { images?: { url?: string }[] };
  const url = data.images?.[0]?.url;
  if (!url) {
    throw new Error(
      `Qwen gaf geen beeld terug: ${JSON.stringify(result.data).slice(0, 300)}`,
    );
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download Qwen-scène mislukt: HTTP ${response.status}`);
  }
  const scene = Buffer.from(await response.arrayBuffer());
  await writeFile(cachePath, scene);
  return scene;
}
