import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import type { SegmentConfig } from "./config.js";
import { ensureFalKey } from "./mask.js";

export interface Sam3Stats {
  calls: number;
  cacheHits: number;
}

export const sam3Stats: Sam3Stats = { calls: 0, cacheHits: 0 };

export interface Sam3Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Sam3Result {
  boxes: Sam3Box[]; // absolute pixels, hoogste score eerst
  scores: number[];
  maskUrls: string[];
}

/**
 * SAM 3 levert boxes als genormaliseerde [cx, cy, w, h] (midden + maat, 0..1).
 * De rest van deze codebase rekent in absolute [x, y, w, h] vanaf de linker-
 * bovenhoek — dezelfde vorm die Florence-2 teruggeeft.
 *
 * De guard op `looksNormalized` is bewust: de API-documentatie zegt
 * genormaliseerd, maar dat is nog niet tegen een echte respons geverifieerd.
 * Waarden die duidelijk in pixels staan worden daarom ongemoeid doorgelaten
 * in plaats van met de beeldmaat vermenigvuldigd te worden.
 */
export function toAbsoluteBox(
  box: number[],
  imgWidth: number,
  imgHeight: number,
): Sam3Box | null {
  const [cx, cy, w, h] = box;
  if (
    cx === undefined || cy === undefined || w === undefined || h === undefined ||
    w <= 0 || h <= 0
  ) {
    return null;
  }
  const looksNormalized = cx <= 1.5 && cy <= 1.5 && w <= 1.5 && h <= 1.5;
  const sx = looksNormalized ? imgWidth : 1;
  const sy = looksNormalized ? imgHeight : 1;
  return {
    x: (cx - w / 2) * sx,
    y: (cy - h / 2) * sy,
    w: w * sx,
    h: h * sy,
  };
}

/**
 * Meerdere maskers samenvoegen tot één wit-op-zwart masker op beeldformaat.
 * `lighten` neemt per pixel het maximum, zodat overlappende segmenten (twee
 * ruiten die elkaar raken) niet oplichten of elkaar wegknippen.
 */
export async function unionMasks(
  masks: Buffer[],
  width: number,
  height: number,
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 0, g: 0, b: 0 } },
  });
  if (masks.length === 0) return base.png().toBuffer();
  const layers = await Promise.all(
    masks.map(async (m) => ({
      input: await sharp(m)
        .resize(width, height, { fit: "fill" })
        .greyscale()
        .toColourspace("srgb")
        .png()
        .toBuffer(),
      blend: "lighten" as const,
    })),
  );
  return base.composite(layers).png().toBuffer();
}

/**
 * Open-vocabulary segmentatie in één call: SAM 3 detecteert én segmenteert
 * alle instanties die bij de tekstprompt horen. Vervangt het tweetrapspad
 * Florence-2 (box uit tekst) → SAM 2 (masker uit box); dat waren twee calls,
 * twee modellen en twee foutkansen voor hetzelfde antwoord.
 *
 * Docs: https://fal.ai/models/fal-ai/sam-3/image/api
 * Gecachet op sha256 van beeld + prompt + model + maxMasks.
 */
export async function segmentByText(
  imageBytes: Buffer,
  prompt: string,
  cacheDir: string,
  cfg: SegmentConfig,
  useCache: boolean,
): Promise<Sam3Result> {
  const hash = createHash("sha256")
    .update(imageBytes)
    .update(prompt)
    .update(cfg.modelId)
    .update(String(cfg.maxMasks))
    .digest("hex");
  const cachePath = path.join(cacheDir, `${hash}.sam3.json`);
  if (useCache && existsSync(cachePath)) {
    sam3Stats.cacheHits++;
    return JSON.parse(await readFile(cachePath, "utf8")) as Sam3Result;
  }

  ensureFalKey();
  const imageUrl = await fal.storage.upload(
    new File([new Uint8Array(imageBytes)], "sam3.jpg", { type: "image/jpeg" }),
  );
  const result = await fal.subscribe(cfg.modelId, {
    input: {
      image_url: imageUrl,
      prompt,
      // we willen het masker zelf, niet het beeld met het masker erop
      apply_mask: false,
      output_format: "png",
      return_multiple_masks: true,
      max_masks: cfg.maxMasks,
      include_scores: true,
      include_boxes: true,
    },
  });
  sam3Stats.calls++;

  const data = result.data as {
    masks?: { url?: string }[];
    scores?: number[];
    boxes?: number[][];
  };
  const meta = await sharp(imageBytes).metadata();
  const imgW = meta.width ?? 1;
  const imgH = meta.height ?? 1;

  // score, box en masker horen bij elkaar per index; filter op minScore en
  // houd de koppeling intact zodat maskUrls[i] bij boxes[i] blijft horen
  const kept: { box: Sam3Box; score: number; url: string }[] = [];
  const rawBoxes = data.boxes ?? [];
  const rawMasks = data.masks ?? [];
  const rawScores = data.scores ?? [];
  for (let i = 0; i < rawMasks.length; i++) {
    const url = rawMasks[i]?.url;
    if (!url) continue;
    const score = rawScores[i] ?? 1;
    if (score < cfg.minScore) continue;
    const rawBox = rawBoxes[i];
    const box = rawBox ? toAbsoluteBox(rawBox, imgW, imgH) : null;
    if (!box) continue;
    kept.push({ box, score, url });
  }
  kept.sort((a, b) => b.score - a.score);

  const out: Sam3Result = {
    boxes: kept.map((k) => k.box),
    scores: kept.map((k) => k.score),
    maskUrls: kept.map((k) => k.url),
  };
  await writeFile(cachePath, JSON.stringify(out));
  return out;
}

/** Maskers van een SAM3-resultaat downloaden en samenvoegen. */
export async function fetchUnionMask(
  res: Sam3Result,
  width: number,
  height: number,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for (const url of res.maskUrls) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`download SAM3-masker mislukt: HTTP ${response.status}`);
    }
    buffers.push(Buffer.from(await response.arrayBuffer()));
  }
  return unionMasks(buffers, width, height);
}
