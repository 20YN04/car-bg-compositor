import "dotenv/config";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { analyzeAlpha, cleanAlpha, erodeAlpha, type AlphaAnalysis } from "./bbox.js";
import {
  compositeImage,
  computePlacement,
  generateDefaultBackground,
  type Placement,
} from "./composite.js";
import { defaultConfig, type Config } from "./config.js";
import { getCutout, maskStats } from "./mask.js";
import { runQA, type QAWarning } from "./qa.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const DEBUG_DIR = "./debug";
const CACHE_DIR = "./cache";
const BG_DIR = "./backgrounds";
const RUN_LOG = path.join(DEBUG_DIR, "run.jsonl");

interface CliOptions {
  file?: string;
  bg?: string;
  useCache: boolean;
  debug: boolean;
}

function parseCli(): { cfg: Config; cli: CliOptions } {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      bg: { type: "string" },
      "ground-y": { type: "string" },
      "car-width": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      "no-debug": { type: "boolean", default: false },
    },
  });

  const cfg: Config = structuredClone(defaultConfig);
  if (values["ground-y"] !== undefined) {
    cfg.GROUND_Y = Number(values["ground-y"]);
    if (!Number.isFinite(cfg.GROUND_Y)) throw new Error("--ground-y moet een getal zijn");
  }
  if (values["car-width"] !== undefined) {
    cfg.CAR_WIDTH_RATIO = Number(values["car-width"]);
    if (!Number.isFinite(cfg.CAR_WIDTH_RATIO) || cfg.CAR_WIDTH_RATIO <= 0 || cfg.CAR_WIDTH_RATIO > 1) {
      throw new Error("--car-width moet tussen 0 en 1 liggen");
    }
  }
  return {
    cfg,
    cli: {
      file: values.file,
      bg: values.bg,
      useCache: !values["no-cache"],
      debug: !values["no-debug"],
    },
  };
}

async function resolveBackground(cli: CliOptions, cfg: Config): Promise<string> {
  if (cli.bg) {
    const candidates = [cli.bg, path.join(BG_DIR, cli.bg)];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      throw new Error(`achtergrond niet gevonden: ${cli.bg} (gezocht in ${BG_DIR}/)`);
    }
    return found;
  }
  const defaultBg = path.join(BG_DIR, "default.png");
  if (!existsSync(defaultBg)) {
    console.log("geen default achtergrond gevonden — genereer neutrale gradient");
    await generateDefaultBackground(defaultBg, cfg.CANVAS);
  }
  return defaultBg;
}

interface ImageResult {
  file: string;
  ok: boolean;
  error?: string;
  warnings: QAWarning[];
}

async function writeDebugOutput(
  file: string,
  inputPath: string,
  alpha: Uint8Array,
  width: number,
  height: number,
  analysis: AlphaAnalysis,
  placement: Placement | null,
  warnings: QAWarning[],
  cfg: Config,
): Promise<void> {
  const base = path.parse(file).name;

  await sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
    .png()
    .toFile(path.join(DEBUG_DIR, `${base}.mask.png`));

  // origineel + bbox (rood) + grondlijn (groen); origineel eventueel
  // geschaald naar de cutout-afmetingen zodat de coördinaten kloppen
  let overlaySvg = "";
  if (analysis.bbox) {
    const b = analysis.bbox;
    overlaySvg =
      `<rect x="${b.left}" y="${b.top}" width="${b.right - b.left + 1}" height="${b.bottom - b.top + 1}"` +
      ` fill="none" stroke="red" stroke-width="3"/>`;
    if (analysis.groundLine !== null) {
      overlaySvg +=
        `<line x1="0" y1="${analysis.groundLine}" x2="${width}" y2="${analysis.groundLine}"` +
        ` stroke="#00c800" stroke-width="3"/>`;
    }
  }
  const svg = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${overlaySvg}</svg>`,
  );
  await sharp(inputPath)
    .resize(width, height, { fit: "fill" })
    .composite([{ input: svg }])
    .png()
    .toFile(path.join(DEBUG_DIR, `${base}.overlay.png`));

  const line = {
    file,
    bbox: analysis.bbox,
    groundLine: analysis.groundLine,
    maskArea: analysis.area,
    blobCount: analysis.blobCount,
    scale: placement?.scale ?? null,
    position: placement ? { x: placement.x, y: placement.y } : null,
    groundY: cfg.GROUND_Y,
    qa: warnings.map((w) => w.code),
  };
  await appendFile(RUN_LOG, `${JSON.stringify(line)}\n`);
}

async function processImage(
  file: string,
  backgroundPath: string,
  cfg: Config,
  cli: CliOptions,
): Promise<ImageResult> {
  const inputPath = path.join(IN_DIR, file);
  const cutout = await getCutout(inputPath, CACHE_DIR, cfg.FAL, cli.useCache);

  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  let alpha: Uint8Array = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] ?? 0;

  let cleanRemovedArea = 0;
  if (cfg.MASK_CLEAN.enabled) {
    const radius = Math.min(
      cfg.MASK_CLEAN.maxRadius,
      Math.max(cfg.MASK_CLEAN.minRadius, Math.round(width * cfg.MASK_CLEAN.openRadiusRatio)),
    );
    const cleaned = cleanAlpha(alpha, width, height, cfg.ALPHA_THRESHOLD, radius);
    alpha = cleaned.alpha;
    cleanRemovedArea = cleaned.removedArea;
  }
  if (cfg.ERODE_MASK) {
    alpha = erodeAlpha(alpha, width, height);
  }
  if (cfg.MASK_CLEAN.enabled || cfg.ERODE_MASK) {
    for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i] ?? 0;
  }

  const analysis = analyzeAlpha(alpha, width, height, {
    threshold: cfg.ALPHA_THRESHOLD,
    groundPercentile: cfg.GROUND_PERCENTILE,
    minBlobArea: cfg.QA.minBlobArea,
  });

  let placement: Placement | null = null;
  if (analysis.bbox && analysis.groundLine !== null) {
    placement = computePlacement(
      analysis.bbox,
      analysis.groundLine,
      cfg.CANVAS,
      cfg.GROUND_Y,
      cfg.CAR_WIDTH_RATIO,
    );
  }
  const warnings = runQA(analysis, width, height, placement, cfg, cleanRemovedArea);

  if (analysis.bbox && placement) {
    const jpeg = await compositeImage(
      { rgba: data, width, height, bbox: analysis.bbox, placement, backgroundPath },
      cfg,
    );
    const outName = path.parse(file).name + ".jpg";
    await writeFile(path.join(OUT_DIR, outName), jpeg);
  }

  if (cli.debug) {
    await writeDebugOutput(
      file, inputPath, alpha, width, height, analysis, placement, warnings, cfg,
    );
  }

  for (const w of warnings) {
    console.warn(`  ⚠ ${file}: [${w.code}] ${w.message}`);
  }
  return { file, ok: analysis.bbox !== null, warnings };
}

function printSummary(results: ImageResult[], cfg: Config): void {
  const ok = results.filter((r) => r.ok && !r.error);
  const failed = results.filter((r) => r.error);

  console.log("\n── samenvatting ──────────────────────────────");
  console.log(`verwerkt:    ${ok.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`gefaald:     ${failed.length}`);
    for (const f of failed) console.log(`  ✗ ${f.file}: ${f.error}`);
  }
  console.log(`API-calls:   ${maskStats.apiCalls}`);
  console.log(`cache-hits:  ${maskStats.cacheHits}`);

  const byCode = new Map<string, string[]>();
  for (const r of results) {
    for (const w of r.warnings) {
      const list = byCode.get(w.code) ?? [];
      list.push(r.file);
      byCode.set(w.code, list);
    }
  }
  if (byCode.size > 0) {
    console.log("\nwaarschuwingen per categorie:");
    for (const [code, files] of [...byCode.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${code} (${files.length}): ${files.join(", ")}`);
    }
  } else {
    console.log("geen waarschuwingen");
  }

  const runCost = maskStats.apiCalls * cfg.COST_PER_CALL_USD;
  const monthly = 75_000 * cfg.COST_PER_CALL_USD;
  console.log(
    `\nkosten: $${runCost.toFixed(4)} deze run ` +
      `($${cfg.COST_PER_CALL_USD}/call — ijken op fal-dashboard)`,
  );
  console.log(`extrapolatie 75.000 beelden/maand: ~$${monthly.toFixed(0)}/maand`);
}

async function main(): Promise<void> {
  const { cfg, cli } = parseCli();
  for (const dir of [IN_DIR, OUT_DIR, DEBUG_DIR, CACHE_DIR, BG_DIR]) {
    await mkdir(dir, { recursive: true });
  }
  const backgroundPath = await resolveBackground(cli, cfg);

  let files: string[];
  if (cli.file) {
    if (!existsSync(path.join(IN_DIR, cli.file))) {
      throw new Error(`bestand niet gevonden: ${path.join(IN_DIR, cli.file)}`);
    }
    files = [cli.file];
  } else {
    files = (await readdir(IN_DIR)).filter((f) => /\.(jpe?g|png)$/i.test(f));
  }
  if (files.length === 0) {
    console.log(`geen afbeeldingen gevonden in ${IN_DIR}/ (jpg/jpeg/png)`);
    return;
  }

  if (cli.debug) await writeFile(RUN_LOG, "");
  console.log(
    `${files.length} beeld(en), achtergrond: ${backgroundPath}, ` +
      `ground-y: ${cfg.GROUND_Y}, car-width: ${cfg.CAR_WIDTH_RATIO}`,
  );

  const results: ImageResult[] = [];
  for (const file of files) {
    process.stdout.write(`→ ${file}\n`);
    try {
      results.push(await processImage(file, backgroundPath, cfg, cli));
    } catch (err) {
      // één mislukking mag de batch niet stoppen
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${file}: ${message}`);
      results.push({ file, ok: false, error: message, warnings: [] });
    }
  }

  printSummary(results, cfg);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
