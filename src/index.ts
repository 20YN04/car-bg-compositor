import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { removeBackgroundLocal, localMaskStats } from "./mask-local.js";
import { geminiStats, generateComposite } from "./gemini.js";
import { applyFinish } from "./harmonize.js";
import { applyBranding } from "./branding.js";
import { defaultConfig, type Config } from "./config.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const CACHE_DIR = "./cache";

interface CliOptions {
  file?: string;
  useCache: boolean;
}

function parseCli(): { cfg: Config; cli: CliOptions } {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      "no-cache": { type: "boolean", default: false },
    },
  });
  return {
    cfg: structuredClone(defaultConfig),
    cli: {
      file: values.file,
      useCache: !values["no-cache"],
    },
  };
}

async function findImages(rootDir: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\.(jpe?g|png)$/i.test(e.name)) {
        result.push(path.relative(rootDir, full));
      }
    }
  }
  await walk(rootDir);
  return result.sort();
}

interface ImageResult {
  file: string;
  ok: boolean;
  error?: string;
}

async function processImage(
  file: string,
  cfg: Config,
  cli: CliOptions,
): Promise<ImageResult> {
  const inputPath = path.join(IN_DIR, file);

  // ── Stap 1: Lokale achtergrondverwijdering (rembg, gratis) ──
  const cutout = await removeBackgroundLocal(inputPath, cli.useCache);

  // ── Stap 2: Gemini showroom-compositing ──
  // cutout op wit flattend: Gemini ziet alleen de auto, geen ruis
  const geminiInput = await sharp(cutout)
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();

  const bgBytes = await readFile(cfg.GEMINI.backgroundPath);

  // Rand-restauratie: buitenste 4.5% vervangen door geblurde rand
  // tegen watermerken en randartefacten van Gemini
  const bandW = Math.round(cfg.CANVAS.width * 0.045);
  const ringSvg = Buffer.from(
    `<svg width="${cfg.CANVAS.width}" height="${cfg.CANVAS.height}" xmlns="http://www.w3.org/2000/svg">` +
      `<path fill-rule="evenodd" fill="white" d="M0 0 H${cfg.CANVAS.width} V${cfg.CANVAS.height} H0 Z ` +
      `M${bandW} ${bandW} H${cfg.CANVAS.width - bandW} V${cfg.CANVAS.height - bandW} H${bandW} Z"/></svg>`,
  );
  const ringMask = await sharp(ringSvg).blur(bandW / 3).png().toBuffer();

  let composited: Buffer | null = null;
  for (let attempt = 0; attempt < cfg.GENBG.maxAttempts; attempt++) {
    const scene = await generateComposite(
      geminiInput, bgBytes, cfg.GEMINI.showroomPrompt, cfg.GEMINI,
      CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
    );

    const sceneFull = await sharp(scene)
      .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "fill" })
      .png()
      .toBuffer();

    // Randband-restauratie
    const borderPatch = await sharp(sceneFull)
      .blur(24)
      .composite([{ input: ringMask, blend: "dest-in" }])
      .png()
      .toBuffer();

    composited = await sharp(sceneFull)
      .composite([{ input: borderPatch }])
      .png()
      .toBuffer();

    // Eerste poging = goed genoeg — de prompt is de hallucinatie-guard.
    // Vervolg-pogingen alleen als er visueel iets mis is (handmatig checken).
    break;
  }

  if (!composited) {
    return { file, ok: false, error: "Gemini gaf geen bruikbaar beeld terug" };
  }

  // ── Stap 3: Afwerking ──
  composited = await applyFinish(composited, cfg.FINISH);
  const branded = await applyBranding(composited, cfg.CANVAS, cfg.BRANDING);
  const outJpeg = await sharp(branded).jpeg({ quality: cfg.JPEG_QUALITY }).toBuffer();

  const outDir = path.join(OUT_DIR, path.parse(file).dir);
  await mkdir(outDir, { recursive: true });
  const outName = path.parse(file).name + ".jpg";
  await writeFile(path.join(outDir, outName), outJpeg);

  return { file, ok: true };
}

async function main(): Promise<void> {
  const { cfg, cli } = parseCli();

  for (const dir of [IN_DIR, OUT_DIR, CACHE_DIR]) {
    await mkdir(dir, { recursive: true });
  }

  let files: string[];
  if (cli.file) {
    if (!existsSync(path.join(IN_DIR, cli.file))) {
      throw new Error(`bestand niet gevonden: ${path.join(IN_DIR, cli.file)}`);
    }
    files = [cli.file];
  } else {
    files = await findImages(IN_DIR);
  }
  if (files.length === 0) {
    console.log(`geen afbeeldingen gevonden in ${IN_DIR}/ (jpg/jpeg/png)`);
    return;
  }

  console.log(`${files.length} beeld(en)`);

  const results: ImageResult[] = [];
  for (const file of files) {
    process.stdout.write(`→ ${file}\n`);
    try {
      results.push(await processImage(file, cfg, cli));
    } catch (err) {
      const message = err instanceof Error
        ? (err.message || ((err as any).body ? JSON.stringify((err as any).body).slice(0, 200) : err.name))
        : String(err);
      console.error(`  ✗ ${file}: ${message}`);
      results.push({ file, ok: false, error: message });
    }
  }

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => r.error);

  console.log("\n── samenvatting ──────────────────────────────");
  console.log(`verwerkt:    ${ok.length}/${results.length}`);
  console.log(`rembg:       ${localMaskStats.calls} calls, ${localMaskStats.cacheHits} cache-hits`);
  console.log(`Gemini NB:   ${geminiStats.calls} calls, ${geminiStats.cacheHits} cache-hits`);

  const runCost = localMaskStats.calls * 0 + geminiStats.calls * cfg.GEMINI.costPerCall;
  console.log(`\nkosten: $${runCost.toFixed(4)} deze run (lokaal masker = gratis)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
