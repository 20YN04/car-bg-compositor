import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { GeminiConfig } from "./config.js";

export interface GeminiStats {
  calls: number;
  cacheHits: number;
}

export const geminiStats: GeminiStats = {
  calls: 0,
  cacheHits: 0,
};

function getClient(cfg: GeminiConfig): GoogleGenAI {
  const apiKey = process.env["GEMINI_NANO_BANANA_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GEMINI_NANO_BANANA_API_KEY ontbreekt — zet 'm in .env",
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Genereert een studioscène via Gemini Nano Banana (image editing mode):
 * stuurt het mathematische composiet (auto op neutrale achtergrond) +
 * prompt → Gemini herschildert de scène rond de auto. De originele
 * autopixels worden er daarna altijd pixel-exact terug overheen gelegd,
 * dus velgen/badges blijven onaangetast.
 *
 * Gecachet op sha256 van beeld + prompt + seed.
 */
export async function generateScene(
  imagePng: Buffer,
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed = 20260724,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(imagePng)
    .update(prompt)
    .update(cfg.modelId)
    .update(String(seed))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.gemini.jpg`);
  if (useCache && existsSync(cachePath)) {
    geminiStats.cacheHits++;
    return readFile(cachePath);
  }

  const client = getClient(cfg);
  const imageBase64 = imagePng.toString("base64");

  // Gemini Nano Banana image editing: stuur prompt + bronbeeld.
  // De SDK-types voor de input array zijn te restrictief — voor deze use
  // case is prompt + image de correcte input (zie Google docs voorbeelden).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interactions: any = client.interactions;
  const interaction = await interactions.create({
    model: cfg.modelId,
    input: [
      { type: "text", text: prompt },
      { type: "image", mime_type: "image/png", data: imageBase64 },
    ],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
    },
  });

  geminiStats.calls++;

  const outputImage = interaction.output_image;
  if (!outputImage?.data) {
    throw new Error(
      `Gemini gaf geen beeld terug: ${JSON.stringify(interaction).slice(0, 300)}`,
    );
  }

  const scene = Buffer.from(outputImage.data, "base64");
  await writeFile(cachePath, scene);
  return scene;
}
