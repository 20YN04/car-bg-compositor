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
      // zonder aspect_ratio levert het model zijn eigen ratio (3:2, 1264×843)
      // terwijl het canvas 4:3 is; de cover-crop schoof de gegenereerde
      // vloerlijn en schaduw dan weg onder de teruggeplakte autolaag
      aspect_ratio: cfg.aspectRatio,
      // ~1264px opschalen naar 1920 gaf een zichtbaar zachte achtergrond
      image_size: cfg.imageSize,
    },
    // de seed hoort in het request, niet alleen in de cachesleutel: anders
    // stuurt de retry-loop bij afkeuring een identiek request naar een
    // non-deterministisch model en is "nieuwe seed" een lege belofte
    generation_config: { seed },
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

export interface TargetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Positioneringsraster: magenta doelrechthoek + cyaan wand/vloerlijn.
 *
 * Dit is de sleutel tot paste-back bij een model dat de hele scène tekent. We
 * dicteren wáár de auto komt in plaats van het te moeten raden; daarna kunnen
 * we onze eigen autolaag exact in datzelfde rechthoek terugleggen.
 *
 * De kleuren zijn bewust magenta en cyaan: die komen in een grijze studio niet
 * voor, dus resterende raster-pixels in de uitvoer zijn direct meetbaar als
 * mislukking in plaats van dat ze wegvallen in de scène.
 */
export function positioningGrid(
  canvas: { width: number; height: number },
  target: TargetRect,
  seamY: number,
): Buffer {
  const lines: string[] = [];
  for (let i = 1; i < 10; i++) {
    const x = Math.round((canvas.width * i) / 10);
    const y = Math.round((canvas.height * i) / 10);
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${canvas.height}" stroke="#FF00FF" stroke-width="2" opacity="0.35"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${canvas.width}" y2="${y}" stroke="#FF00FF" stroke-width="2" opacity="0.35"/>`);
  }
  return Buffer.from(
    `<svg width="${canvas.width}" height="${canvas.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#808080"/>` +
      lines.join("") +
      `<rect x="${Math.round(target.left)}" y="${Math.round(target.top)}" ` +
      `width="${Math.round(target.width)}" height="${Math.round(target.height)}" ` +
      `fill="none" stroke="#FF00FF" stroke-width="6"/>` +
      `<line x1="0" y1="${Math.round(seamY)}" x2="${canvas.width}" y2="${Math.round(seamY)}" ` +
      `stroke="#00FFFF" stroke-width="6"/>` +
      `</svg>`,
  );
}

/**
 * Showroom-compositing met meerdere invoerbeelden — de aanpak die in
 * carredo-imaging-refs staat beschreven en die de live listings gebruiken.
 *
 * Gemini krijgt de auto als CUTOUT OP TRANSPARANTIE, niet als composiet met
 * een zwart gat. Dat verschil is wezenlijk: instructie-editors lezen een zwart
 * vlak als object en bouwen er een studio omheen, of vullen het met een
 * verzonnen auto. Een transparante cutout toont alleen de auto.
 *
 * Daarnaast de plate, het positioneringsraster en de stijlreferenties. Het
 * raster dicteert waar de auto komt zodat de aanroeper zijn eigen autolaag
 * daarna exact op die plek kan terugleggen — dát maakt paste-back mogelijk bij
 * een model dat de hele scène tekent.
 */
export async function generateShowroomComposite(
  cutoutPng: Buffer,
  platePng: Buffer,
  gridPng: Buffer,
  styleRefs: Buffer[],
  prompt: string,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
  seed: number,
): Promise<Buffer> {
  const hash = createHash("sha256")
    .update(cutoutPng)
    .update(platePng)
    .update(gridPng)
    .update(prompt)
    .update(cfg.modelId)
    .update(String(styleRefs.length))
    .update(String(seed))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.showroom.jpg`);
  if (useCache && existsSync(cachePath)) {
    geminiStats.cacheHits++;
    return readFile(cachePath);
  }

  const client = getClient(cfg);
  const img = (b: Buffer, mime = "image/png") => ({
    type: "image",
    mime_type: mime,
    data: b.toString("base64"),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const interactions: any = client.interactions;
  const interaction = await interactions.create({
    model: cfg.modelId,
    input: [
      { type: "text", text: prompt },
      img(cutoutPng),
      img(platePng),
      img(gridPng),
      ...styleRefs.map((r) => img(r, "image/webp")),
    ],
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
  const scene = Buffer.from(out.data, "base64");
  await writeFile(cachePath, scene);
  return scene;
}
