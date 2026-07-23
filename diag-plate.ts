import "dotenv/config";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { defaultConfig } from "./src/config.js";
import { detectPlates, segmentByBoxes } from "./src/ai.js";
import { plateQuadFromMask } from "./src/plate.js";

const file = "/Users/yentl/Projects/car-bg-compositor/in/audi-etron-03.jpg";
const CACHE = "/Users/yentl/Projects/car-bg-compositor/cache";
const bytes = await readFile(file);
const meta = await sharp(file).metadata();
const W = meta.width!, H = meta.height!;
const detected = await detectPlates(bytes, CACHE, defaultConfig.AI, true);
console.log("detected boxes:", JSON.stringify(detected));
for (const box of detected) {
  const maskPng = await segmentByBoxes(bytes, [box], defaultConfig.WINDOWS.segmentModelId, CACHE, true);
  const raw = await sharp(maskPng).resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const mask = new Uint8Array(raw.buffer, raw.byteOffset, W * H);
  const quad = plateQuadFromMask(mask, W, H, box);
  console.log("quad:", JSON.stringify(quad));
  // overlay: origineel + maskrand + box
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="none" stroke="red" stroke-width="3"/>
    ${quad ? `<polygon points="${[quad.tl,quad.tr,quad.br,quad.bl].map(p=>p.x+','+p.y).join(' ')}" fill="none" stroke="lime" stroke-width="3"/>` : ""}
  </svg>`;
  const maskTint = await sharp(maskPng).resize(W, H, {fit:"fill"}).ensureAlpha(0.35).png().toBuffer();
  await sharp(file).composite([{input: maskTint, blend:"screen"},{input: Buffer.from(svg)}])
    .extract({left: Math.max(0,Math.round(box.x)-150), top: Math.max(0,Math.round(box.y)-150), width: Math.min(W,Math.round(box.w)+300), height: Math.min(H,Math.round(box.h)+300)})
    .png().toFile("/private/tmp/claude-501/-Users-yentl/01826dc0-0d84-493c-b49f-4c8596427474/scratchpad/diag-03.png");
}
