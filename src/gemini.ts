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

export const geminiStats: GeminiStats = { calls: 0, cacheHits: 0 };

function getClient(): GoogleGenAI {
  const apiKey = process.env["GEMINI_NANO_BANANA_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_NANO_BANANA_API_KEY ontbreekt — zet 'm in .env");
  return new GoogleGenAI({ apiKey });
}

async function callGemini(
  input: Array<Record<string, unknown>>,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  cacheSuffix = "",
  seed = 20260724,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(JSON.stringify(input))
    .update(cfg.modelId)
    .update(String(seed))
    .update(cacheSuffix)
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.gemini.jpg`);
  if (useCache && existsSync(cachePath)) { geminiStats.cacheHits++; return readFile(cachePath); }

  let interaction: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    interaction = await (getClient().interactions as any).create({
      model: cfg.modelId,
      input,
      response_format: { type: "image", mime_type: "image/jpeg" },
    });
  } catch (err) {
    throw new Error(`Gemini API mislukt: ${err instanceof Error ? err.message : err}`);
  }

  geminiStats.calls++;
  const img = interaction.output_image;
  if (!img?.data) throw new Error(`Gemini gaf geen beeld terug: ${JSON.stringify(interaction).slice(0, 200)}`);
  const buf = Buffer.from(img.data, "base64");
  await writeFile(cachePath, buf);
  return buf;
}

/**
 * Gemini image editing: stuur één afbeelding + prompt, krijg bewerkte afbeelding terug.
 * Voor schaduw-generatie en andere lokale edits — géén referentie-images.
 */
export async function editImage(
  imagePng: Buffer,
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed?: number,
): Promise<Buffer> {
  return callGemini(
    [
      { type: "text", text: prompt },
      { type: "image", mime_type: "image/png", data: imagePng.toString("base64") },
    ],
    cfg, cacheDir, useCache, "edit", seed,
  );
}

/**
 * Gemini full compositing: auto + achtergrond + stijlreferenties → showroomfoto.
 */
export async function generateComposite(
  carPng: Buffer,
  backgroundPng: Buffer,
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed?: number,
): Promise<Buffer> {
  const refsDir = path.resolve("carredo-imaging-refs");
  const refFiles = [
    { fp: path.join(refsDir, "assets", "thumbnail_reference.webp"), n: "canonical" },
    { fp: path.join(refsDir, "style_refs", "lizy_1.webp"), n: "ref1" },
    { fp: path.join(refsDir, "style_refs", "lizy_2.webp"), n: "ref2" },
    { fp: path.join(refsDir, "style_refs", "lizy_3.webp"), n: "ref3" },
  ];

  const input: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
    { type: "image", mime_type: "image/png", data: carPng.toString("base64") },
    { type: "image", mime_type: "image/png", data: backgroundPng.toString("base64") },
  ];
  for (const { fp } of refFiles) {
    if (existsSync(fp)) input.push({ type: "image", mime_type: "image/webp", data: (await readFile(fp)).toString("base64") });
  }

  return callGemini(input, cfg, cacheDir, useCache, "composite", seed);
}
