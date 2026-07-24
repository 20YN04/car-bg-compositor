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

function getClient(_cfg: GeminiConfig): GoogleGenAI {
  const apiKey = process.env["GEMINI_NANO_BANANA_API_KEY"];
  if (!apiKey) {
    throw new Error("GEMINI_NANO_BANANA_API_KEY ontbreekt — zet 'm in .env");
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Laad stijlreferenties uit carredo-imaging-refs/.
 */
async function loadReferenceImages(): Promise<
  Array<{ data: string; mimeType: string; name: string }>
> {
  const refsDir = path.resolve("carredo-imaging-refs");
  const files = [
    { filePath: path.join(refsDir, "assets", "thumbnail_reference.webp"), name: "canonical" },
    { filePath: path.join(refsDir, "style_refs", "lizy_1.webp"), name: "ref1" },
    { filePath: path.join(refsDir, "style_refs", "lizy_2.webp"), name: "ref2" },
    { filePath: path.join(refsDir, "style_refs", "lizy_3.webp"), name: "ref3" },
  ];

  const results: Array<{ data: string; mimeType: string; name: string }> = [];
  for (const { filePath, name } of files) {
    if (!existsSync(filePath)) {
      console.warn(`  ⚠ referentie-image niet gevonden: ${filePath}`);
      continue;
    }
    results.push({
      data: (await readFile(filePath)).toString("base64"),
      mimeType: "image/webp",
      name,
    });
  }
  return results;
}

/**
 * Gemini Nano Banana showroom-compositing: plaatst de gemaskeerde auto
 * op de showroom-achtergrond met stijlreferenties.
 *
 * Input: carPng (flattend op wit), backgroundPng, prompt + refs
 * Output: JPEG buffer
 */
export async function generateComposite(
  carPng: Buffer,
  backgroundPng: Buffer,
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed = 20260724,
): Promise<Buffer> {
  const refs = await loadReferenceImages();
  const hash = createHash("sha256")
    .update(carPng)
    .update(backgroundPng)
    .update(prompt)
    .update(cfg.modelId)
    .update(String(seed))
    .update(JSON.stringify(refs.map((r) => r.name)))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.gemini.jpg`);

  if (useCache && existsSync(cachePath)) {
    geminiStats.cacheHits++;
    return readFile(cachePath);
  }

  const client = getClient(cfg);

  // Bouw input: prompt + auto + achtergrond + referenties
  const input: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
    { type: "image", mime_type: "image/png", data: carPng.toString("base64") },
    { type: "image", mime_type: "image/png", data: backgroundPng.toString("base64") },
  ];
  for (const ref of refs) {
    input.push({ type: "image", mime_type: ref.mimeType, data: ref.data });
  }

  let interaction: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interaction = await (client.interactions as any).create({
      model: cfg.modelId,
      input,
      response_format: { type: "image", mime_type: "image/jpeg" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Gemini API call mislukt: ${msg}`);
  }

  geminiStats.calls++;

  const outputImage = interaction.output_image;
  if (!outputImage?.data) {
    throw new Error(`Gemini gaf geen beeld terug: ${JSON.stringify(interaction).slice(0, 300)}`);
  }

  const scene = Buffer.from(outputImage.data, "base64");
  await writeFile(cachePath, scene);
  return scene;
}
