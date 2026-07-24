// Genereert backgrounds/studio.png — een carredo-achtige studioplate:
// lichtgrijze wand, donkere naad, betonvloer die naar voren verdonkert.
// Waarden gesampled uit de live carredo-listingbeelden (neutraal grijs,
// wand/vloerlijn op ~55% hoogte). Seeded ruis → bit-identiek reproduceerbaar.
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const W = 1920;
const H = 1440;
const HORIZON = 576; // wand/vloer-overgang (40% van 1440, zoals de referentie)

// mulberry32: deterministische PRNG zodat de plate reproduceerbaar is
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const svg = Buffer.from(
  `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6d6d6d"/>
        <stop offset="0.62" stop-color="#a6a6a6"/>
        <stop offset="0.97" stop-color="#989898"/>
        <stop offset="1" stop-color="#828282"/>
      </linearGradient>
      <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8f8f8f"/>
        <stop offset="0.3" stop-color="#7f7f7f"/>
        <stop offset="1" stop-color="#565656"/>
      </linearGradient>
      <linearGradient id="seam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="black" stop-opacity="0"/>
        <stop offset="0.45" stop-color="black" stop-opacity="0.22"/>
        <stop offset="1" stop-color="black" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="sheen" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="white" stop-opacity="0.10"/>
        <stop offset="1" stop-color="white" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${HORIZON}" fill="url(#wall)"/>
    <rect y="${HORIZON}" width="${W}" height="${H - HORIZON}" fill="url(#floor)"/>
    <rect y="${HORIZON - 26}" width="${W}" height="64" fill="url(#seam)"/>
    <ellipse cx="${W / 2}" cy="${HORIZON + 330}" rx="${W * 0.55}" ry="240" fill="url(#sheen)"/>
  </svg>`,
);

// betonruis, alleen op de vloer: ±5 levels, licht geblurd
const rand = mulberry32(20260724);
const noise = Buffer.alloc(W * (H - HORIZON));
// twee octaven: fijne korrel + grovere vlekken (beton-mottling)
for (let i = 0; i < noise.length; i++) noise[i] = 114 + Math.round(rand() * 28);
const noisePng = await sharp(noise, {
  raw: { width: W, height: H - HORIZON, channels: 1 },
})
  .blur(1.1)
  .png()
  .toBuffer();

await mkdir("backgrounds", { recursive: true });
await sharp(svg)
  .composite([{ input: noisePng, top: HORIZON, left: 0, blend: "overlay" }])
  .png()
  .toFile("backgrounds/studio.png");
console.log("backgrounds/studio.png geschreven");
