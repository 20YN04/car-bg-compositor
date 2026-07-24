import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { removeBackgroundLocal, localMaskStats } from "./mask-local.js";
import { geminiStats, generateComposite } from "./gemini.js";
import { applyFinish, compressHighlights } from "./harmonize.js";
import { applyBranding } from "./branding.js";
import { defaultConfig, type Config } from "./config.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const CACHE_DIR = "./cache";

function parseCli(): { cfg: Config; cli: { file?: string; useCache: boolean } } {
  const { values } = parseArgs({
    options: { file: { type: "string" }, "no-cache": { type: "boolean", default: false } },
  });
  return { cfg: structuredClone(defaultConfig), cli: { file: values.file, useCache: !values["no-cache"] } };
}

async function findImages(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else if (/\.(jpe?g|png)$/i.test(e.name)) result.push(path.relative(rootDir, f));
    }
  }
  await walk(rootDir);
  return result.sort();
}

async function main(): Promise<void> {
  const { cfg, cli } = parseCli();
  for (const d of [IN_DIR, OUT_DIR, CACHE_DIR]) await mkdir(d, { recursive: true });

  let files = cli.file
    ? (existsSync(path.join(IN_DIR, cli.file)) ? [cli.file] : (() => { throw new Error(`niet gevonden: ${cli.file}`); })())
    : await findImages(IN_DIR);
  if (!files.length) { console.log(`geen beelden in ${IN_DIR}/`); return; }

  console.log(`${files.length} beeld(en)`);

  const bgPath = cfg.GEMINI.backgroundPath;
  const bgBytes = await readFile(bgPath);
  const bgMeta = await sharp(bgBytes).metadata();
  const bgW = bgMeta.width ?? 1536;
  const bgH = bgMeta.height ?? 1024;

  let ok = 0, geminiCalls = 0;

  for (const file of files) {
    process.stdout.write(`→ ${file}\n`);
    try {
      // 1. rembg mask
      const cutout = await removeBackgroundLocal(path.join(IN_DIR, file), cli.useCache);

      // 2. Reflecties dempen
      const { data, info } = await sharp(cutout).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const alpha = new Uint8Array(info.width * info.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] ?? 0;
      compressHighlights(data, alpha, info.width, info.height, { enabled: true, knee: 160, strength: 0.7 });
      const carPng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

      // 3. Auto op correcte schaal op wit canvas plaatsen
      const carMeta = await sharp(carPng).metadata();
      const carW = carMeta.width ?? 800, carH = carMeta.height ?? 600;
      // Target: auto op ~60% breedte, gecentreerd, onderrand op vloerlijn (~75% hoogte)
      const targetW = Math.round(bgW * 0.60);
      const scale = targetW / carW;
      const targetH = Math.round(carH * scale);
      const floorY = Math.round(bgH * 0.75);
      const left = Math.round((bgW - targetW) / 2);
      const top = floorY - targetH;

      const canvasInput = await sharp({
        create: { width: bgW, height: bgH, channels: 3, background: "#ffffff" },
      }).composite([{
        input: await sharp(carPng).resize(targetW, targetH, { fit: "inside" }).png().toBuffer(),
        left, top: Math.max(0, top),
      }]).png().toBuffer();

      // 4. Gemini: plaats auto op showroom-achtergrond
      const scene = await generateComposite(
        canvasInput, bgBytes, cfg.GEMINI.showroomPrompt, cfg.GEMINI,
        CACHE_DIR, cli.useCache,
      );
      geminiCalls++;

      // 5. Rand-restauratie + afwerking
      const bandW = Math.round(bgW * 0.045);
      const ringMask = await sharp(Buffer.from(
        `<svg width="${bgW}" height="${bgH}" xmlns="http://www.w3.org/2000/svg">` +
        `<path fill-rule="evenodd" fill="white" d="M0 0 H${bgW} V${bgH} H0 Z M${bandW} ${bandW} H${bgW - bandW} V${bgH - bandW} H${bandW} Z"/></svg>`
      )).blur(bandW / 3).png().toBuffer();

      const sceneFull = await sharp(scene).resize(bgW, bgH, { fit: "fill" }).png().toBuffer();
      const borderPatch = await sharp(sceneFull).blur(24).composite([{ input: ringMask, blend: "dest-in" }]).png().toBuffer();
      const composited = await sharp(sceneFull).composite([{ input: borderPatch }]).png().toBuffer();

      const finished = await applyFinish(composited, cfg.FINISH);
      const branded = await applyBranding(finished, cfg.CANVAS, cfg.BRANDING);
      const outJpeg = await sharp(branded)
        .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "contain", background: "#ffffff" })
        .jpeg({ quality: cfg.JPEG_QUALITY }).toBuffer();

      const outDir = path.join(OUT_DIR, path.parse(file).dir);
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, path.parse(file).name + ".jpg"), outJpeg);
      ok++;
    } catch (err) {
      const msg = err instanceof Error ? (err.message || JSON.stringify((err as any).body).slice(0, 200)) : String(err);
      console.error(`  ✗ ${file}: ${msg}`);
    }
  }

  console.log(`\n── samenvatting ──────────────────────────────`);
  console.log(`verwerkt:    ${ok}/${files.length}`);
  console.log(`rembg:       ${localMaskStats.calls} calls, ${localMaskStats.cacheHits} hits`);
  console.log(`Gemini:      ${geminiCalls} calls, ${geminiStats.cacheHits} hits`);
  console.log(`kosten:      $${(geminiCalls * cfg.GEMINI.costPerCall).toFixed(2)} (masker = gratis)`);
}

main().catch(err => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; });
