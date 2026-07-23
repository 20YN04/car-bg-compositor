// Tijdelijk script: synthetisch testbeeld + voorgevulde cache-cutout,
// zodat de pipeline end-to-end draait zonder API-call.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

// "auto"-silhouet: carrosserie + cabine + wielen, en een dunne sliert onder
// de auto als uitschieter die de grondlijn NIET mag beïnvloeden
const shapes =
  `<rect x="100" y="300" width="600" height="130" rx="20" fill="#222"/>` +
  `<path d="M 220 300 L 280 220 L 520 220 L 580 300 Z" fill="#222"/>` +
  `<circle cx="230" cy="430" r="55" fill="#111"/>` +
  `<circle cx="570" cy="430" r="55" fill="#111"/>` +
  `<rect x="395" y="480" width="8" height="40" fill="#333"/>`; // uitschieter

const input = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">` +
  `<rect width="100%" height="100%" fill="#b0c4de"/>${shapes}</svg>`;
const cutout = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`;

await sharp(Buffer.from(input)).png().toFile("./in/test-car.png");
const bytes = await readFile("./in/test-car.png");
const hash = createHash("sha256").update(bytes).digest("hex");
const cutoutPng = await sharp(Buffer.from(cutout)).png().toBuffer();
await writeFile(`./cache/${hash}.png`, cutoutPng);
console.log(`testbeeld + cache-cutout klaar (${hash.slice(0, 12)}…)`);
