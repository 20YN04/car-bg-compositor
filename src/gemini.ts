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
 * Is dit een hik of een echt bezwaar? Tijdelijke fouten verdienen een
 * herkansing, een afgewezen prompt of een dood quotum niet.
 *
 * Waarom dit bestaat. In car-multiview gingen op de VW ID.3 twee van de drie
 * hoeken verloren aan zo'n hik — een leeg antwoord en een "fetch failed" —
 * na 138 betaalde calls, terwijl er inhoudelijk niets mis was (2026-08-03).
 */
function tijdelijkeFout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /fetch failed|geen tekst terug|geen beeld terug|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timeout|429|500|502|503|504|overloaded|unavailable|internal error/i
    .test(msg);
}

/** Voert `fn` uit en herkanst alleen bij een tijdelijke fout, met oplopende pauze. */
async function metHerkansing<T>(wat: string, fn: () => Promise<T>): Promise<T> {
  const pauzes = [2000, 6000, 15000];
  for (let poging = 0; ; poging++) {
    try {
      return await fn();
    } catch (err) {
      if (poging >= pauzes.length || !tijdelijkeFout(err)) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  ⚠ ${wat}: tijdelijke fout (${msg.slice(0, 70)}) — ` +
          `herkansing ${poging + 1}/${pauzes.length} over ${pauzes[poging]! / 1000}s`,
      );
      await new Promise((r) => setTimeout(r, pauzes[poging]!));
    }
  }
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
  const model = cfg.textModelId || cfg.modelId;
  const h = createHash("sha256").update(prompt).update(model);
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
  const input = [{ type: "text", text: prompt }, ...images.map(toImageInput)];
  const text = await metHerkansing("tekstoordeel", async () => {
    let interaction: { output_text?: unknown };
    try {
      interaction = await interactions.create({ model, input });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (model === cfg.modelId || !/not found|unsupported|invalid|404/i.test(msg)) throw err;
      console.warn(`  ⚠ tekstmodel "${model}" niet bruikbaar — teruggevallen op ${cfg.modelId}`);
      interaction = await interactions.create({ model: cfg.modelId, input });
    }
    geminiStats.calls++;
    const t = interaction.output_text;
    if (typeof t !== "string" || t.length === 0) {
      throw new Error(
        `Gemini gaf geen tekst terug: ${JSON.stringify(interaction).slice(0, 300)}`,
      );
    }
    return t;
  });
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
  const img = await metHerkansing("beeldgeneratie", async () => {
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
    return Buffer.from(out.data, "base64");
  });
  await writeFile(cachePath, img);
  return img;
}
