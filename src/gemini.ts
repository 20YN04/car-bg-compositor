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

function getClient(): GoogleGenAI {
  const apiKey = process.env["GEMINI_NANO_BANANA_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "GEMINI_NANO_BANANA_API_KEY ontbreekt — zet 'm in .env",
    );
  }
  return new GoogleGenAI({ apiKey });
}

export interface ImagePart {
  data: Buffer;
  mime?: string; // default image/jpeg
}

function toImageInput(p: ImagePart): { type: string; mime_type: string; data: string } {
  return {
    type: "image",
    mime_type: p.mime ?? "image/jpeg",
    data: p.data.toString("base64"),
  };
}

/**
 * Tekstantwoord van Gemini over één of meer beelden (identificatie,
 * vergelijking, proportie-oordeel). Gecachet op sha256 van prompt + beelden.
 */
export async function geminiText(
  images: ImagePart[],
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<string> {
  const h = createHash("sha256").update(prompt).update(cfg.modelId);
  for (const i of images) h.update(i.data);
  const cachePath = path.join(cacheDir, `${h.digest("hex")}.gtext.json`);
  if (useCache && existsSync(cachePath)) {
    geminiStats.cacheHits++;
    return (JSON.parse(await readFile(cachePath, "utf8")) as { text: string }).text;
  }

  const client = getClient();
  // De SDK-types voor de input array zijn te restrictief — prompt + images
  // is de correcte input voor deze use case (zie Google docs voorbeelden).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interactions: any = (client as GoogleGenAI & { interactions: unknown }).interactions;
  const interaction = await interactions.create({
    model: cfg.modelId,
    input: [{ type: "text", text: prompt }, ...images.map(toImageInput)],
  });
  geminiStats.calls++;

  const text = interaction.output_text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(
      `Gemini gaf geen tekst terug: ${JSON.stringify(interaction).slice(0, 300)}`,
    );
  }
  await writeFile(cachePath, JSON.stringify({ text }));
  return text;
}

/**
 * Nieuwe kijkhoek van dezelfde auto, gereconstrueerd uit de bronfoto's.
 *
 * Dit is bewust volledige generatie — de bewaking zit niet in de prompt
 * maar eromheen: de aanroeper legt het resultaat langs de bronfoto's
 * (dimensie-, identiteits-, lak- en proportie-poorten in index.ts).
 *
 * De seed gaat mee in het request, niet alleen in de cachesleutel: anders
 * stuurt de retry-loop bij afkeuring een identiek request naar een
 * non-deterministisch model en is "nieuwe seed" een lege belofte.
 */
export async function generateNovelView(
  refs: ImagePart[],
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed: number,
): Promise<Buffer> {
  const h = createHash("sha256").update(prompt).update(cfg.modelId).update(String(seed));
  for (const r of refs) h.update(r.data);
  const cachePath = path.join(cacheDir, `${h.digest("hex")}.synth.jpg`);
  if (useCache && existsSync(cachePath)) {
    geminiStats.cacheHits++;
    return readFile(cachePath);
  }

  const client = getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interactions: any = (client as GoogleGenAI & { interactions: unknown }).interactions;
  const interaction = await interactions.create({
    model: cfg.modelId,
    input: [{ type: "text", text: prompt }, ...refs.map(toImageInput)],
    response_format: {
      type: "image",
      mime_type: "image/jpeg",
      aspect_ratio: cfg.aspectRatio,
      image_size: cfg.imageSize,
    },
    generation_config: { seed },
  });
  geminiStats.calls++;

  const out = interaction.output_image;
  if (!out?.data) {
    throw new Error(
      `Gemini gaf geen beeld terug: ${JSON.stringify(interaction).slice(0, 300)}`,
    );
  }
  const img = Buffer.from(out.data, "base64");
  await writeFile(cachePath, img);
  return img;
}
