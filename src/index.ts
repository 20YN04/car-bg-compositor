import "dotenv/config";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import {
  analyzeAlpha,
  applyInstanceMatte,
  cleanAlpha,
  clustersFromWheelBoxes,
  groundCutY,
  dilateMask,
  erodeAlpha,
  restrictAlphaToBox,
  sharpenAlphaEdges,
  trimAlphaBelow,
  type AlphaAnalysis,
} from "./bbox.js";
import {
  compositeImage,
  computePlacement,
  contactYForWheels,
  generateDefaultBackground,
  decideLevel,
  generateStudioSweep,
  scaleFromWheel,
  type Placement,
} from "./composite.js";
import {
  defaultConfig,
  geminiAspectForCanvas,
  type Config,
  type SegmentProvider,
} from "./config.js";
import {
  aiStats,
  detectPlates,
  detectWheels,
  detectCars,
  detectWindows,
  fillScene,
  type PlateBox,
  readSceneText,
  segmentByBoxes,
  visualYesNo,
} from "./ai.js";
import {
  generateNovelView,
  generateScene,
  generateShowroomComposite,
  geminiStats,
  positioningGrid,
  type ImagePart,
} from "./gemini.js";
import {
  compareAgainstSources,
  identifyVehicle,
  paintCorrectionGains,
  paintDeviation,
} from "./identify.js";
import { generateSceneQwen, qwenStats } from "./qwen.js";
import {
  applyGreenhouse,
  applyWindowTint,
  filterBoxesOnCar,
  filterPlausibleWindowBoxes,
} from "./windows.js";
import { getCarBox, getCutout, maskStats, noteFalFailure } from "./mask.js";
import { fetchUnionMask, sam3Stats, segmentByText } from "./sam3.js";
import { buildContactShadows, type CanvasRect } from "./composite.js";
import {
  anonymizePlates,
  computePlateRegions,
  plateQuadFromMask,
  plausiblePlatesOnCar,
  type PlateQuad,
  type PlateStatus,
  type PlateTarget,
} from "./plate.js";
import {
  applyFinish,
  backgroundMeans,
  compressHighlights,
  cutoutMeans,
  harmonizeColors,
  medianMeans,
  type ChannelMeans,
} from "./harmonize.js";
import { applyBranding } from "./branding.js";
import { adoptSceneLight, alignCarRegion, findCarBox } from "./relight.js";
import {
  analyzePaint,
  attenuateReflectionStructure,
  dampEnvironmentReflections,
  dampRimLight,
} from "./paint.js";
import { auditComposite, auditWarnings, type CompositeAudit } from "./audit.js";
import { classifyExterior, runQA, type QAWarning } from "./qa.js";
import { activeOperations, buildProvenance, provenanceXmp } from "./provenance.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const DEBUG_DIR = "./debug";
const CACHE_DIR = "./cache";
const BG_DIR = "./backgrounds";

interface CliOptions {
  file?: string;
  bg?: string;
  useCache: boolean;
  debug: boolean;
  ai: boolean;
  detect: boolean;
  groundYOverride?: number; // --ground-y wint van het BackgroundProfile
  carWidthOverride?: number; // --car-width (ratio) wint van floorScaleRef
  preset?: keyof Config["PRESETS"]; // fase 4: per-hoek kadrering
  /** Merk, model en uitvoering uit de listing, voor de relight-prompt. */
  vehicle?: string;
  /**
   * Auto-map waarvoor de ontbrekende Lizy-hoek (3/4 vóór-rechts) wordt
   * gesynthetiseerd uit de aanwezige foto's. Het resultaat gaat daarna door
   * de gewone deterministische pipeline voor kadrering, plaat en schaduw.
   */
  synth?: string;
  /** Eindbeeld door Gemini langs de bron laten leggen op weggevallen details. */
  checkDetails: boolean;
}

const MASK_PROMPT =
  "This is a cutout of a car on a plain gray background. Is the car complete " +
  "and intact, with no missing parts such as wheels, mirrors or roof, and " +
  "with no unrelated objects like poles, wind turbines or people attached " +
  "to it? Answer YES or NO, followed by a short reason.";

const OTHERS_PROMPT =
  "Besides the single main car, are there any other vehicles or people " +
  "visible in this image? Answer YES or NO, followed by a short reason.";

const PLATFORM_PROMPT =
  "Is the car standing on a round platform, podium or turntable, or are " +
  "there painted lines, arrows or markings on the floor? " +
  "Answer YES or NO, followed by a short reason.";

const EXHAUST_PROMPT =
  "Are metal exhaust pipes visible under the rear bumper of the car? " +
  "Answer YES or NO, followed by a short reason.";

const GROUND_PROMPT =
  "Does the car in this image appear to stand naturally on the floor, with " +
  "its tires touching the ground, not floating above it and not sunk into " +
  "it? Answer YES or NO, followed by a short reason.";

function parseCli(): { cfg: Config; cli: CliOptions } {
  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      vehicle: { type: "string" },
      bg: { type: "string" },
      "ground-y": { type: "string" },
      "car-width": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      "no-debug": { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      "no-qa": { type: "boolean", default: false },
      "no-detect": { type: "boolean", default: false },
      "no-windows": { type: "boolean", default: false },
      "no-harmonize": { type: "boolean", default: false },
      "no-paint": { type: "boolean", default: false },
      "no-lightwrap": { type: "boolean", default: false },
      "no-genbg": { type: "boolean", default: false },
      genbg: { type: "string" },
      "genbg-provider": { type: "string" },
      matte: { type: "string" },
      segment: { type: "string" },
      "rembg-model": { type: "string" },
      plate: { type: "string" },
      preset: { type: "string" },
      target: { type: "string" },
      synth: { type: "string" },
      "check-details": { type: "boolean", default: false },
    },
  });

  // Wat voor auto dit is, uit de listing. Wordt aan de relight-prompt
  // voorgevoegd zodat het model niet hoeft te raden welk model het tekent.
  const vehicle = typeof values.vehicle === "string" ? values.vehicle.trim() : "";
  const cfg: Config = structuredClone(defaultConfig);
  // het uitvoerdoel eerst: dat zet canvas, achtergrond en de plate-specifieke
  // nabewerkingen in één keer, en de losse vlaggen hieronder kunnen er daarna
  // nog overheen
  if (values.target !== undefined) {
    if (!["showroom", "white", "studio"].includes(values.target)) {
      throw new Error("--target moet showroom, white of studio zijn");
    }
    cfg.TARGET = values.target as Config["TARGET"];
  }
  const targetPreset = cfg.TARGETS[cfg.TARGET];
  cfg.CANVAS = { ...targetPreset.canvas };
  cfg.GRAIN.enabled = targetPreset.grain;
  cfg.LIGHTWRAP.enabled = targetPreset.lightWrap;
  cfg.HARMONIZE.enabled = targetPreset.harmonize;
  cfg.PAINT.enabled = targetPreset.paint;
  cfg.BRANDING.enabled = targetPreset.watermark;
  // de statische default (4:3) hoort bij het showroom-canvas; elk ander
  // target zou anders een scène in de verkeerde verhouding vragen en die
  // vervolgens cover-croppen
  cfg.GEMINI.aspectRatio = geminiAspectForCanvas(cfg.CANVAS);
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
  // ook op de config zetten, niet alleen op cli: de kostenraming leest de
  // config, dus anders rapporteert --no-ai/--no-detect een prijs voor stappen
  // die helemaal niet draaien
  if (values["no-ai"]) cfg.AI.enabled = false;
  if (values["no-qa"]) cfg.AI.qaChecks = false;
  if (values["no-detect"]) cfg.DETECT.enabled = false;
  if (values["no-windows"]) cfg.WINDOWS.enabled = false;
  if (values["no-harmonize"]) cfg.HARMONIZE.enabled = false;
  if (values["no-paint"]) cfg.PAINT.enabled = false;
  if (values["no-lightwrap"]) cfg.LIGHTWRAP.enabled = false;
  if (values["no-genbg"]) cfg.GENBG.enabled = false;
  if (values.genbg !== undefined) {
    if (!["hero", "all"].includes(values.genbg)) {
      throw new Error("--genbg moet hero of all zijn");
    }
    cfg.GENBG.mode = values.genbg as Config["GENBG"]["mode"];
    // GENBG staat default uit; expliciet een modus kiezen zet 'm ook aan
    cfg.GENBG.enabled = true;
  }
  if (values["genbg-provider"] !== undefined) {
    if (!["flux", "gemini", "qwen", "showroom"].includes(values["genbg-provider"])) {
      throw new Error("--genbg-provider moet flux, gemini, qwen of showroom zijn");
    }
    cfg.GENBG.provider = values["genbg-provider"] as Config["GENBG"]["provider"];
  }
  if (values.matte !== undefined) {
    if (!["fal-birefnet", "fal-rmbg", "rembg", "api4ai"].includes(values.matte)) {
      throw new Error("--matte moet fal-birefnet, fal-rmbg, rembg of api4ai zijn");
    }
    cfg.MATTE.provider = values.matte as Config["MATTE"]["provider"];
  }
  if (values.segment !== undefined) {
    if (!["florence-sam2", "sam3"].includes(values.segment)) {
      throw new Error("--segment moet florence-sam2 of sam3 zijn");
    }
    const v = values.segment as SegmentProvider;
    cfg.SEGMENT.providers = { car: v, windows: v, wheels: v };
  }
  if (values["rembg-model"] !== undefined) {
    cfg.MATTE.rembgModel = values["rembg-model"];
  }
  if (values.preset !== undefined && !(values.preset in cfg.PRESETS)) {
    throw new Error("--preset moet side, front34 of rear34 zijn");
  }
  if (values.plate !== undefined) {
    if (!["blur", "replace", "off"].includes(values.plate)) {
      throw new Error("--plate moet blur, replace of off zijn");
    }
    cfg.PLATE.mode = values.plate as Config["PLATE"]["mode"];
  }
  return {
    cfg,
    cli: {
      file: values.file,
      bg: values.bg,
      useCache: !values["no-cache"],
      debug: !values["no-debug"],
      ai: !values["no-ai"],
      detect: !values["no-detect"],
      groundYOverride: values["ground-y"] !== undefined ? cfg.GROUND_Y : undefined,
      carWidthOverride:
        values["car-width"] !== undefined ? cfg.CAR_WIDTH_RATIO : undefined,
      preset: values.preset as CliOptions["preset"],
      vehicle: vehicle || undefined,
      synth: values.synth,
      checkDetails: values["check-details"] ?? false,
    },
  };
}

async function resolveBackground(cli: CliOptions, cfg: Config): Promise<string> {
  if (cli.bg) {
    // absoluut pad is expliciete gebruikersintentie; een relatief pad moet
    // binnen BG_DIR blijven (geen traversal via ../)
    if (path.isAbsolute(cli.bg)) {
      if (!existsSync(cli.bg)) throw new Error(`achtergrond niet gevonden: ${cli.bg}`);
      return cli.bg;
    }
    const bgRoot = path.resolve(BG_DIR);
    const resolved = path.resolve(BG_DIR, cli.bg);
    if (!resolved.startsWith(bgRoot + path.sep)) {
      throw new Error(`--bg moet binnen ${BG_DIR}/ liggen (of een absoluut pad zijn)`);
    }
    if (!existsSync(resolved)) {
      throw new Error(`achtergrond niet gevonden: ${cli.bg} (gezocht in ${BG_DIR}/)`);
    }
    return resolved;
  }
  // het uitvoerdoel bepaalt de achtergrond; de vlakke gradient blijft de
  // fallback wanneer die plate lokaal ontbreekt
  const wanted = path.join(BG_DIR, cfg.TARGETS[cfg.TARGET].background);
  // wit en de studio-sweep zijn te genereren; een fotografische plate niet.
  // Een gegenereerde achtergrond wordt ook opnieuw gemaakt zodra de parameters
  // veranderen — met alleen een bestaat-check kalibreer je anders op een
  // achtergrond die niet meer bij de config hoort, en dat merk je pas als de
  // metingen onverklaarbaar niet bewegen.
  if (cfg.TARGET === "white" || cfg.TARGET === "studio") {
    const recipe = JSON.stringify(
      cfg.TARGET === "studio" ? { c: cfg.CANVAS, s: cfg.SWEEP } : { c: cfg.CANVAS },
    );
    const stamp = `${wanted}.recipe.json`;
    const current = existsSync(stamp) ? await readFile(stamp, "utf8") : null;
    if (!existsSync(wanted) || current !== recipe) {
      if (cfg.TARGET === "white") await generateWhiteBackground(wanted, cfg.CANVAS);
      else await generateStudioSweep(wanted, cfg.CANVAS, cfg.SWEEP);
      await writeFile(stamp, recipe);
    }
  }
  if (existsSync(wanted)) return wanted;

  const defaultBg = path.join(BG_DIR, "default.png");
  if (!existsSync(defaultBg)) {
    console.log("geen default achtergrond gevonden — genereer neutrale gradient");
    await generateDefaultBackground(defaultBg, cfg.CANVAS);
  }
  return defaultBg;
}

/** JPEG schrijven met de herkomstregistratie in de EXIF-beschrijving. */
async function withProvenance(
  png: Buffer,
  cfg: Config,
  input: Parameters<typeof buildProvenance>[0],
): Promise<Buffer> {
  const record = buildProvenance(input, cfg);
  return sharp(png)
    .withMetadata({
      exif: {
        IFD0: {
          ImageDescription: record["carbg:claim"] ?? "",
          Software: "car-bg-compositor",
        },
      },
    })
    // de volledige registratie gaat in XMP: libvips schrijft alleen erkende
    // EXIF-tags weg en liet een zelfbedachte sleutel stil vallen
    .withXmp(provenanceXmp(record))
    .jpeg({ quality: cfg.JPEG_QUALITY })
    .toBuffer();
}

/** Puur wit vlak: de canonieke cutout-achtergrond. */
async function generateWhiteBackground(file: string, canvas: Config["CANVAS"]): Promise<void> {
  await sharp({
    create: {
      width: canvas.width,
      height: canvas.height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toFile(file);
}

const warnedProfiles = new Set<string>();

/** Eén waarschuwing per plate, niet per beeld. */
function warnProfileMissing(bgName: string): void {
  if (warnedProfiles.has(bgName)) return;
  warnedProfiles.add(bgName);
  console.warn(
    `  ⚠ geen BACKGROUND_PROFILES-entry voor "${bgName}" — plaatsing valt terug ` +
      `op DEFAULT_PROFILE (vlakke gradient). Kalibreer deze plate in src/config.ts.`,
  );
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
  extras: Record<string, unknown> = {},
): Promise<void> {
  const parsed = path.parse(file);
  const debugDir = path.join(DEBUG_DIR, parsed.dir);
  await mkdir(debugDir, { recursive: true });
  const base = parsed.name;

  await sharp(Buffer.from(alpha), { raw: { width, height, channels: 1 } })
    .png()
    .toFile(path.join(debugDir, `${base}.mask.png`));

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
    .toFile(path.join(debugDir, `${base}.overlay.png`));

  const runLog = path.join(debugDir, "run.jsonl");
  const line = {
    file,
    bbox: analysis.bbox,
    groundLine: analysis.groundLine,
    maskArea: analysis.area,
    blobCount: analysis.blobCount,
    scale: placement?.scale ?? null,
    position: placement ? { x: placement.x, y: placement.y } : null,
    groundY: cfg.GROUND_Y,
    shadowBandHeight: analysis.shadowBandHeight,
    topBump: analysis.topBump,
    qa: warnings.map((w) => w.code),
    ...extras,
  };
  await appendFile(runLog, `${JSON.stringify(line)}\n`);
}

interface RunContext {
  heroPending: boolean; // hero-modus: is de generatieve scène nog te vergeven?
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

async function processImage(
  file: string,
  backgroundPath: string,
  cfg: Config,
  cli: CliOptions,
  run: RunContext,
  setReference?: ChannelMeans,
): Promise<ImageResult> {
  const inputPath = path.join(IN_DIR, file);
  const inputBytes = await readFile(inputPath);

  // auto-detectie is een verfijning (masker begrenzen tot de auto-box), geen
  // voorwaarde: zonder detectie draait de pipeline op het onbegrensde masker
  const useDetect = cfg.DETECT.enabled && cli.detect;
  let detection: Awaited<ReturnType<typeof getCarBox>> = null;
  if (useDetect) {
    try {
      detection = await getCarBox(inputPath, CACHE_DIR, cfg.DETECT, cli.useCache);
    } catch (err) {
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: auto-detectie overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const cutout = await getCutout(inputPath, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);

  const cut = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // niet const: de rechtzet-stap hieronder draait de uitsnede en levert een
  // groter doek terug, dus buffer en afmetingen kunnen nog wijzigen
  let data = cut.data;
  let width = cut.info.width;
  let height = cut.info.height;

  let alpha: Uint8Array = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] ?? 0;

  // fase 0 — instance-matte: BiRefNet-alfa begrenzen met het SAM2-
  // instancemasker (auto-box als prompt); de aangesmolten grondschaduw ligt
  // buiten dat masker en verdwijnt zo bij de bron
  let matteRemoved = 0;
  let matteApplied = false;
  if (cfg.MATTE.enabled && cli.ai && detection) {
    try {
      const b = detection.box;
      const maskPng =
        cfg.SEGMENT.providers.car === "sam3"
          ? await fetchUnionMask(
              await segmentByText(
                inputBytes, cfg.SEGMENT.prompts.car, CACHE_DIR, cfg.SEGMENT, cli.useCache,
              ),
              width, height,
            )
          : await segmentByBoxes(
              inputBytes,
              [{ x: b.left, y: b.top, w: b.right - b.left + 1, h: b.bottom - b.top + 1 }],
              cfg.WINDOWS.segmentModelId, CACHE_DIR, cli.useCache,
            );
      const raw = await sharp(maskPng)
        .resize(width, height, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer();
      let mask: Uint8Array = dilateMask(
        new Uint8Array(raw.buffer, raw.byteOffset, width * height),
        width, height, cfg.MATTE.dilateRadius,
      );
      if (cfg.MATTE.featherSigma > 0) {
        // let op: zonder expliciet 1-kanaals doel promoveert sharp de blur
        // naar 3 kanalen en verschuiven de maskbytes
        const { data: feathered, info: fInfo } = await sharp(Buffer.from(mask), {
          raw: { width, height, channels: 1 },
        })
          .blur(cfg.MATTE.featherSigma)
          .toColourspace("b-w")
          .raw()
          .toBuffer({ resolveWithObject: true });
        if (fInfo.channels !== 1) {
          throw new Error(`feather gaf ${fInfo.channels} kanalen`);
        }
        mask = new Uint8Array(feathered.buffer, feathered.byteOffset, width * height);
      }
      const matted = applyInstanceMatte(alpha, mask, width, height, cfg.ALPHA_THRESHOLD);
      alpha = matted.alpha;
      matteRemoved = matted.removedArea;
      matteApplied = true;
    } catch (err) {
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: instance-matte overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // instance-aware masking (implementatie B): masker begrenzen tot de auto-box
  let outsideBoxRemoved = 0;
  if (detection) {
    const restricted = restrictAlphaToBox(
      alpha, width, height, detection.box, cfg.DETECT.boxMargin, cfg.ALPHA_THRESHOLD,
    );
    alpha = restricted.alpha;
    outsideBoxRemoved = restricted.removedArea;
  }

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
  if (cfg.MATTE.edgeSharpen) {
    alpha = sharpenAlphaEdges(alpha, cfg.MATTE.edgeLow, cfg.MATTE.edgeHigh);
  }
  for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i] ?? 0;

  const analyse = () =>
    analyzeAlpha(alpha, width, height, {
      threshold: cfg.ALPHA_THRESHOLD,
      groundPercentile: cfg.GROUND_PERCENTILE,
      minBlobArea: cfg.QA.minBlobArea,
    });
  let analysis = analyse();

  // De auto waterpas zetten voordat er iets geplaatst wordt. Een opname op een
  // helling of met een gerolde camera heeft een schuine wiellijn; de vloer van
  // de plate is waterpas. Zonder deze stap raakt één wiel de grond en hangt het
  // andere in de lucht — gemeten 73 px op de profielfoto van de Taycan. Geen
  // schaduw of reflectie herstelt dat.
  //
  // Roteren is een starre transformatie van de originele pixels: niets
  // bijverzonnen, alleen anders neergezet.
  let levelled = 0;
  // wat de detecties hierna te zien krijgen: gelijk aan inputBytes tenzij de
  // auto rechtgezet is
  let workBytes: Buffer = inputBytes;
  if (analysis.bbox) {
    const decision = decideLevel(analysis.contactClusters, analysis.bbox, cfg.LEVEL);
    if (decision.applied) {
      const turned = await sharp(data, { raw: { width, height, channels: 4 } })
        .rotate(decision.rotate, {
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .raw()
        .toBuffer({ resolveWithObject: true });
      data = turned.data;
      width = turned.info.width;
      height = turned.info.height;
      alpha = new Uint8Array(width * height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] ?? 0;
      // opnieuw meten: bbox, grondlijn en wielcontacten liggen nu anders
      analysis = analyse();
      // Het bronbeeld moet mee draaien. Alle detecties hierna (ruiten, plaat,
      // wielen) draaien op deze bytes en leveren coordinaten in dat frame; laat
      // je ze op het onbewerkte beeld staan, dan komt het raammasker scheef op
      // de gedraaide auto en landen de contactschaduwen op de oude wiellijn.
      // Naar dezelfde afmetingen forceren zodat de twee frames per definitie
      // samenvallen, ook als de matte ooit op een andere resolutie uitkomt.
      workBytes = await sharp(inputBytes)
        .rotate(decision.rotate, { background: { r: 128, g: 128, b: 128 } })
        .resize(width, height, { fit: "fill" })
        .jpeg({ quality: 95 })
        .toBuffer();
      levelled = decision.rotate;
    }
  }

  // fase 1 — plaatsing op de gekalibreerde vloer van deze plate: contactlijn
  // op contactTargetY, schaal via px/meter i.p.v. vaste canvasfractie
  // een plate zonder profiel valt terug op DEFAULT_PROFILE (vlakke gradient):
  // andere contactdiepte, schaal en reflectie. Dat is op een echte studioplate
  // altijd fout, dus luid melden i.p.v. stil degraderen
  const bgName = path.basename(backgroundPath);
  const profile = cfg.BACKGROUND_PROFILES[bgName] ?? cfg.DEFAULT_PROFILE;
  if (!cfg.BACKGROUND_PROFILES[bgName] && bgName !== "default.png") {
    warnProfileMissing(bgName);
  }
  const classification = classifyExterior(
    {
      analysis,
      imgWidth: width,
      imgHeight: height,
      detectionEnabled: useDetect,
      detectionFound: detection !== null,
    },
    cfg,
    cfg.ROUTING.minExteriorSignals,
  );
  // Een detailopname is geen exterieurfoto, hoe herkenbaar de auto er ook op
  // staat. De routeringspoort telt exterieursignalen en een close-up van een
  // koplamp of spiegel haalt die gewoon: het ís een auto.
  //
  // Het onderscheid dat wél werkt is de maskerfractie. Een listingfoto heeft
  // altijd lucht om de auto; gemeten op de Van Mossel-set vulde de koplamp
  // 75,4% van het beeld en de spiegel 88,6%, terwijl geen van de dertien
  // Taycan-exterieurfoto's boven de drempel kwam. Zonder deze poort belandde
  // een uitgesneden koplamp op de studiovloer, compleet met spiegeling.
  //
  // Zulke foto's krijgen nog wel de kleurcorrectie, de grade en de branding,
  // zodat de listing als geheel consistent blijft.
  const maskFraction =
    analysis.area / Math.max(1, width * height);
  const detailShot = maskFraction > cfg.QA.maxMaskArea;
  const compositeThisImage =
    (!cfg.ROUTING.enabled || classification.isExterior) && !detailShot;

  // wielposities via detectie: contour-geometrie mist verre wielen die
  // nauwelijks onder de onderbodemlijn uitsteken (RVV-achterwiel)
  let shadowClusters = analysis.contactClusters;
  let measuredWheels: PlateBox[] = [];
  if (cli.ai && analysis.bbox && compositeThisImage) {
    try {
      const rawWheels =
        cfg.SEGMENT.providers.wheels === "sam3"
          ? (
              await segmentByText(
                workBytes, cfg.SEGMENT.prompts.wheels, CACHE_DIR, cfg.SEGMENT, cli.useCache,
              )
            ).boxes
          : await detectWheels(workBytes, CACHE_DIR, cfg.AI, cli.useCache);
      const wheelBoxes = filterBoxesOnCar(
        rawWheels.filter(
          (w) =>
            w.w * w.h <=
              0.15 *
                (analysis.bbox!.right - analysis.bbox!.left + 1) *
                (analysis.bbox!.bottom - analysis.bbox!.top + 1) &&
            w.w <= 0.35 * (analysis.bbox!.right - analysis.bbox!.left + 1),
        ),
        alpha, width, height, cfg.ALPHA_THRESHOLD,
      );
      const detected = clustersFromWheelBoxes(
        wheelBoxes, alpha, width, height, analysis.bbox, cfg.ALPHA_THRESHOLD,
      );
      if (detected.length > 0) shadowClusters = detected;
      measuredWheels = wheelBoxes;
    } catch (err) {
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: wieldetectie overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }


  const preset = cli.preset ? cfg.PRESETS[cli.preset] : undefined;
  const contactY =
    cli.groundYOverride ?? preset?.contactTargetY ?? profile.contactTargetY;
  const spanMeters = preset?.spanMeters ?? profile.carWidthMeters;
  // schaal op de gemeten wieldiameter; zonder bruikbaar wiel terugvallen op de
  // oude bbox-breedte, die van de kijkhoek afhangt en dus per hoek verschilt
  const wheelScale =
    cfg.WHEEL_DIAMETER_M > 0 && analysis.bbox
      ? scaleFromWheel(
          measuredWheels,
          cfg.WHEEL_DIAMETER_M * cfg.FRAMING_GAIN,
          profile.floorScaleRef,
        )
      : null;
  const bboxWidthPx = analysis.bbox
    ? analysis.bbox.right - analysis.bbox.left + 1
    : cfg.CANVAS.width;
  // Het uitvoerdoel bepaalt waarop geschaald wordt. In een scene wil je
  // fysieke consistentie (wielmaat); in een cutout-catalogus wil je
  // consistente kadervulling, want daar staat de auto nergens.
  const target = cfg.TARGETS[cfg.TARGET];
  const widthRatio =
    cli.carWidthOverride ??
    (target.scaleMode === "frame"
      ? target.frameWidthRatio
      : wheelScale !== null
        ? (wheelScale * bboxWidthPx) / cfg.CANVAS.width
        : (spanMeters * profile.floorScaleRef) / cfg.CANVAS.width);

  // aangesmolten slagschaduw onder de wiellijn uit het masker snijden, zodat
  // die niet als grijze appendage onder de auto in het eindbeeld belandt
  let groundTrimmedPx = 0;
  let groundTrimCapped = false;
  if (analysis.bbox && analysis.groundLine !== null && analysis.groundTrim > 0) {
    // ruime marge: liever een paar schaduwpixels laten staan (vallen in de
    // contactschaduw) dan echte bandpixels wegsnijden
    const slack = Math.max(4, Math.round(height * 0.004));
    // de trim mag nooit een substantieel deel van de auto opeten: onder een
    // lage camera hangt de voorspoiler in projectie lager dan het
    // bandcontactpunt en zou hij hier als "schaduw" sneuvelen
    const bboxHeight = analysis.bbox.bottom - analysis.bbox.top + 1;
    const cut = groundCutY(
      analysis.bbox.top,
      analysis.bbox.bottom,
      analysis.groundLine,
      measuredWheels.map((w) => w.y + w.h),
      slack,
      cfg.GROUND_TRIM_MAX_RATIO,
    );
    const cutY = cut.cutY;
    groundTrimCapped = cut.capped;
    // wielkolommen beschermen: Florence-boxen onderschatten de bandonderkant
    // net vaak genoeg dat de wielgarde in groundCutY niet ingreep en de
    // vlakke snede de band platsloeg; de kolomranges zelf zijn wél
    // betrouwbaar, en anders geven de contactclusters uit het masker ze
    const protect =
      measuredWheels.length > 0
        ? measuredWheels.map((w) => ({ x0: w.x, x1: w.x + w.w }))
        : analysis.contactClusters.map((c) => ({ x0: c.x0, x1: c.x1 }));
    groundTrimmedPx = trimAlphaBelow(alpha, width, height, cutY, protect);
    if (groundTrimmedPx > 0) {
      for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i] ?? 0;
    }
  }

  let placement: Placement | null = null;
  let contactYUsed = contactY;
  if (analysis.bbox && analysis.groundLine !== null) {
    placement = computePlacement(
      analysis.bbox,
      analysis.groundLine,
      cfg.CANVAS,
      contactY,
      widthRatio,
      profile.horizontalBias,
    );
    // bij een sterke 3/4-hoek staat het verre wiel fors hoger in beeld en zou
    // het boven de wand/vloerovergang van de plate landen: één wiel op de
    // muur. De config verdiepte de contactlijn daarvoor handmatig voor élke
    // hoek; nu wordt per beeld gemeten of het nodig is.
    if (cfg.CONTACT_FIT.enabled) {
      contactYUsed = contactYForWheels(
        shadowClusters,
        analysis.bbox,
        contactY,
        placement.scale,
        placement.y,
        profile.horizonY,
        cfg.CONTACT_FIT.horizonMargin,
      );
      if (contactYUsed !== contactY) {
        placement = computePlacement(
          analysis.bbox, analysis.groundLine, cfg.CANVAS, contactYUsed, widthRatio,
          profile.horizontalBias,
        );
      }
    }
  }
  // ruiten donker tinten zodat de oorspronkelijke omgeving niet door het
  // glas zichtbaar blijft (detectie + SAM2-masker + wiskundige verdonkering)
  const windowInfo = { boxes: 0, tintedPixels: 0 };
  // Het raammasker wordt hier alleen opgebouwd. In modus "protect" wordt het
  // glas niet bewerkt maar juist afgeschermd van de lakstappen: die draaien op
  // álle autopixels en maakten de voorruit melkig en vlak.
  let glassMask: Uint8Array | null = null;
  if (cfg.WINDOWS.enabled && cli.ai && analysis.bbox) {
    try {

      // SAM 3 doet detectie én segmentatie in één call uit dezelfde
      // tekstprompt; de tweetraps-route blijft de default tot dat pad tegen
      // een echte respons geverifieerd is
      const useSam3 = cfg.SEGMENT.providers.windows === "sam3";
      const sam3Windows = useSam3
        ? await segmentByText(
            workBytes, cfg.SEGMENT.prompts.windows, CACHE_DIR, cfg.SEGMENT, cli.useCache,
          )
        : null;
      const detectedWindows = sam3Windows
        ? sam3Windows.boxes
        : (
            await Promise.all(
              cfg.WINDOWS.detectPrompts.map((prompt) =>
                detectWindows(workBytes, prompt, CACHE_DIR, cfg.AI, cli.useCache),
              ),
            )
          ).flat();
      const onCar = filterBoxesOnCar(
        filterPlausibleWindowBoxes(detectedWindows, analysis.bbox),
        alpha, width, height, cfg.ALPHA_THRESHOLD,
      );
      windowInfo.boxes = onCar.length;
      if (onCar.length > 0) {
        const maskPng = sam3Windows
          ? await fetchUnionMask(sam3Windows, width, height)
          : await segmentByBoxes(
              workBytes, onCar, cfg.WINDOWS.segmentModelId, CACHE_DIR, cli.useCache,
            );
        const maskRaw = await sharp(maskPng)
          .resize(width, height, { fit: "fill" })
          .greyscale()
          .blur(cfg.WINDOWS.featherSigma)
          .raw()
          .toBuffer();
        const windowMask = new Uint8Array(
          maskRaw.buffer, maskRaw.byteOffset, width * height,
        );
        glassMask = windowMask;
        if (cfg.WINDOWS.mode !== "protect" && cfg.WINDOWS.greenhouse) {
          // wat zou de studioplate hier spiegelen? De gemiddelde plate-kleur
          // is een goede benadering: de wand is een egaal verloop, dus een
          // ruit die hem spiegelt ziet vrijwel één toon
          const pm = await backgroundMeans(
            backgroundPath, cfg.CANVAS.width, cfg.CANVAS.height,
          );
          // lage frequentie van de luminantie: alles wat we vervangen
          const lowRaw = await sharp(data, { raw: { width, height, channels: 4 } })
            .greyscale()
            .blur(cfg.WINDOWS.greenhouseLowFreqRadius)
            .raw()
            .toBuffer();
          // fijne blur: de grens tussen "rand van de auto" en "gespiegelde
          // omgeving". Alles fijner blijft, de band ertussen wordt gedempt.
          const fineRaw = await sharp(data, { raw: { width, height, channels: 4 } })
            .greyscale()
            .blur(cfg.WINDOWS.greenhouseFineRadius)
            .raw()
            .toBuffer();
          // per-kanaal geblurd: het eigen verloop van het glas, in kleur.
          // Alleen de luminantie meegeven zou de mengstap kleurloos maken.
          // ensureAlpha na de blur: dan heeft deze buffer dezelfde stride van
          // vier kanalen als `data`, en kan applyGreenhouse beide met dezelfde
          // index lezen. Een 3-kanaals buffer met een 4-kanaals index gaf een
          // jaloezie-patroon over het glas.
          const lowColour = await sharp(data, { raw: { width, height, channels: 4 } })
            .removeAlpha()
            .blur(cfg.WINDOWS.greenhouseLowFreqRadius)
            .ensureAlpha()
            .raw()
            .toBuffer();
          windowInfo.tintedPixels = applyGreenhouse(
            data, alpha, windowMask,
            new Uint8Array(lowRaw.buffer, lowRaw.byteOffset, width * height),
            width, height, pm, cfg.WINDOWS, cfg.WINDOWS.greenhouseDetail,
            new Uint8Array(fineRaw.buffer, fineRaw.byteOffset, width * height),
            cfg.WINDOWS.greenhouseMidKeep,
            lowColour, cfg.WINDOWS.plateBlend,
          );
        } else if (cfg.WINDOWS.mode !== "protect") {
          windowInfo.tintedPixels = applyWindowTint(
            data, alpha, windowMask, width, height, cfg.WINDOWS,
          );
        }
      }
    } catch (err) {
      // tint is cosmetisch: een falende segmentatie mag het beeld niet blokkeren
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: ruit-tint overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // fase 3 — harmonisatie: buitenlicht-zweem subtiel richting de
  // achtergrondtoon trekken vóór de ruit-tint
  let harmonizeGains: { r: number; g: number; b: number } | null = null;
  if (cfg.HARMONIZE.enabled && analysis.bbox) {
    const bg = await backgroundMeans(backgroundPath, cfg.CANVAS.width, cfg.CANVAS.height);
    const car = cutoutMeans(data, alpha, width, height);
    harmonizeGains = harmonizeColors(
      data, alpha, width, height, car, bg, cfg.HARMONIZE, setReference,
    );
  }
  // omgevingsreflecties in de lak dempen: glanzende lak spiegelt de plek waar
  // de foto genomen is, dus een auto die onder bomen stond houdt een bomenrij
  // op de motorkap. Verzadiging naar neutraal, helderheid ongemoeid — de vorm
  // blijft, de kleur verdwijnt. Achterlichten en badges zijn beschermd.
  // Alfa zonder glas: de lakstappen zijn voor lak. Op een ruit halen ze de
  // reflecties eruit en blijft er een melkig vlak over — precies wat je van
  // glas juist niet wilt.
  const paintAlpha = glassMask
    ? (() => {
        const a = new Uint8Array(alpha);
        for (let i = 0; i < a.length; i++) {
          if ((glassMask[i] ?? 0) > 40) a[i] = 0;
        }
        return a;
      })()
    : alpha;
  let paintDamped = 0;
  let paintSmoothed = 0;
  // op functieniveau: de waarde ontstaat in de scène-stap maar wordt in
  // run.jsonl geschreven, buiten dat blok
  let relightStats: { meanShift: number; maxShift: number; clipped: number } | null = null;
  let alignBox: { hun: unknown; ons: unknown } | null = null;
  if (cfg.PAINT.enabled && analysis.bbox) {
    const stats = analyzePaint(data, paintAlpha, width, height, cfg.PAINT);
    // het gewicht per pixel bewaren: de tweede stap mag alleen aankomen waar
    // deze stap de pixel al als omgeving heeft aangewezen
    const weights = new Float32Array(width * height);
    paintDamped = dampEnvironmentReflections(
      data, paintAlpha, width, height, stats, cfg.PAINT, weights,
    );
    // randlicht: de structuurdemping laat de helderheid met rust, dus de
    // lichte lijn langs het silhouet staat er dan nog. Maten schalen mee met
    // de autohoogte zodat ze niet aan één bronresolutie vastzitten.
    const carH = analysis.bbox.bottom - analysis.bbox.top + 1;
    dampRimLight(
      data, paintAlpha, width, height,
      Math.max(2, Math.round(carH * cfg.PAINT.rimWidthRatio)),
      Math.max(8, Math.round(carH * cfg.PAINT.rimPaintRatio)),
      cfg.PAINT.rimStrength, cfg.PAINT.rimMinExcess,
    );
    paintSmoothed = attenuateReflectionStructure(
      data, paintAlpha, weights, width, height,
      cfg.PAINT.structureFineRadius, cfg.PAINT.structureCoarseRadius,
      cfg.PAINT.structureStrength,
    );
  }

  // specular-compressie: felle reflecties van de oorspronkelijke tl-balken/
  // spots in de lak dempen zodat ze niet vloeken met de rustige studio-look
  let highlightPixels = 0;
  if (cfg.HIGHLIGHTS.enabled && analysis.bbox) {
    highlightPixels = compressHighlights(data, paintAlpha, width, height, cfg.HIGHLIGHTS);
  }


  // nummerplaten detecteren en mappen naar canvascoördinaten
  let plates: CanvasRect[] = [];
  let plateTargets: PlateTarget[] = [];
  const plateEnabled =
    cfg.PLATE.mode !== "off" &&
    cli.ai &&
    analysis.bbox !== null &&
    placement !== null;
  if (plateEnabled && analysis.bbox && placement) {

    // plaatdetectie faalt → geen anonimisatie. Dat is een GDPR-relevante
    // degradatie, dus luid melden i.p.v. het beeld te laten falen; de
    // PLATE_NOT_FOUND-status verderop komt in run.jsonl terecht
    let detected: PlateBox[] = [];
    try {
      detected = await detectPlates(workBytes, CACHE_DIR, cfg.AI, cli.useCache);
    } catch (err) {
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: PLAATDETECTIE MISLUKT — plaat NIET geanonimiseerd: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
    plates = computePlateRegions(
      detected, alpha, width, height, analysis.bbox, placement,
      cfg.CANVAS, cfg.ALPHA_THRESHOLD,
    );
    // plaatvlak (quad) per plaat via SAM2: de badge kan dan met een affine
    // warp het bumperperspectief volgen i.p.v. als rechte sticker te hangen
    const srcPlates = plausiblePlatesOnCar(
      detected, alpha, width, height, analysis.bbox, cfg.ALPHA_THRESHOLD,
    );
    const bb = analysis.bbox;
    const pl = placement;
    const toCanvas = (p: { x: number; y: number }) => ({
      x: pl.x + (p.x - bb.left) * pl.scale,
      y: pl.y + (p.y - bb.top) * pl.scale,
    });
    plateTargets = plates.map((region) => ({ region }));
    for (let i = 0; i < srcPlates.length && i < plateTargets.length; i++) {
      const src = srcPlates[i]!;
      try {
        const maskPng = await segmentByBoxes(
          workBytes, [src], cfg.WINDOWS.segmentModelId, CACHE_DIR, cli.useCache,
        );
        const raw = await sharp(maskPng)
          .resize(width, height, { fit: "fill" })
          .greyscale()
          .raw()
          .toBuffer();
        const quad = plateQuadFromMask(
          new Uint8Array(raw.buffer, raw.byteOffset, width * height),
          width, height, src,
        );
        if (quad) {
          plateTargets[i]!.quad = {
            tl: toCanvas(quad.tl),
            tr: toCanvas(quad.tr),
            bl: toCanvas(quad.bl),
            br: toCanvas(quad.br),
          } satisfies PlateQuad;
        }
      } catch (err) {
        // quad is een verfijning: zonder blijft de rechte badge staan
        noteFalFailure(err);
        console.warn(
          `  ⚠ ${file}: plaatvlak-segmentatie overgeslagen: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  const warnings = runQA(
    {
      analysis,
      imgWidth: width,
      imgHeight: height,
      placement,
      cleanRemovedArea,
      detection: {
        enabled: useDetect,
        found: detection !== null,
        outsideBoxRemoved,
      },
      plate: { enabled: plateEnabled, found: plates.length > 0 },
    },
    cfg,
  );

  // routing: is dit überhaupt een exterieuropname? Een interieurshot heeft
  // geen grondlijn en geen wielcontact; die op de studiovloer plakken levert
  // een dashboard dat in een showroom zweeft — en dat werd tot nu toe gewoon
  // weggeschreven. Kost niets: alle signalen zijn al berekend voor de QA.
  if (!compositeThisImage) {
    const failed = classification.signals.filter((s) => !s.ok).map((s) => s.name);
    warnings.push({
      code: "NOT_EXTERIOR",
      message:
        `geen exterieuropname (${classification.score}/${classification.total} signalen) — ` +
        `achtergrond onaangeroerd gelaten; mist: ${failed.join(", ")}`,
    });
  }

  if (groundTrimCapped) {
    // de trim wilde meer wegsnijden dan GROUND_TRIM_MAX_RATIO toestaat; dat is
    // bijna altijd een lage 3/4-hoek waarin de voorspoiler onder de wiellijn
    // projecteert. Geklemd i.p.v. uitgevoerd — even nakijken.
    warnings.push({
      code: "GROUND_TRIM_CAPPED",
      message:
        `grondtrim geklemd op ${Math.round(cfg.GROUND_TRIM_MAX_RATIO * 100)}% van de bboxhoogte ` +
        `(gevraagd: ${analysis.groundTrim}px) — mogelijk carrosserie onder de wiellijn`,
    });
  }

  let outJpeg: Buffer | null = null;
  let plateStatus: PlateStatus = plateEnabled ? "none" : "off";
  let genbgApplied = false;
  if (analysis.bbox && placement && compositeThisImage) {
    const { image: mathComposite, carLayer } = await compositeImage(
      {
        rgba: data, width, height, bbox: analysis.bbox, placement, backgroundPath,
        contactShadows: buildContactShadows(
          shadowClusters, analysis.bbox, placement, cfg, profile.shadowHeightScale,
        ),
        profile,
        contactY: contactYUsed,
      },
      cfg,
    );

    // hybride scène-stap: FLUX Fill herschildert achtergrond + schaduw +
    // reflectie rond de auto; daarna gaan de originele autopixels er
    // pixel-exact terug overheen. Elke poging wordt door een VLM gecheckt op
    // hallucinaties buiten het beschermde masker (tweede auto, uitlaten
    // onder een EV-bumper, vloermarkeringen) — bij afkeuring een nieuwe
    // seed, en na GENBG.maxAttempts terug naar het mathematische composiet.
    let composited = mathComposite;
    const genbgEligible =
      cfg.GENBG.enabled &&
      cli.ai &&
      (cfg.GENBG.mode === "all" || run.heroPending);
    if (genbgEligible) {
      // hero-modus: deze foto verbruikt de hero-slot, ook bij afkeuring —
      // de hero blijft de hero, een afgekeurde scène wordt mathematisch
      if (cfg.GENBG.mode === "hero") run.heroPending = false;
      try {
        // masker: wit = herschilderen, zwart = alleen de auto behouden.
        // Beeldvullend wit geeft de mooiste, coherentste scènes; het
        // hallucinatierisico (tweede auto, podium, verzonnen onderdelen)
        // wordt afgevangen door de VLM-poort + reseed hieronder. Een tot
        // een band ingeperkt masker gaf lelijkere artefacten: FLUX maakte
        // van de maskerrand een draaiplateau onder de auto.
        // keep = exact de autovorm. Een eerdere "strook onder de bumper"
        // (autovorm omlaag geschoven mee-beschermen) werkte averechts: het
        // auto-vormige gat in het masker werd door FLUX ingevuld als een
        // tweede auto ónder de onze.
        const carMeta = await sharp(carLayer.input).metadata();
        const scaledCarW = carMeta.width ?? cfg.CANVAS.width;
        const keepShape = await sharp(carLayer.input)
          .ensureAlpha()
          .extractChannel(3)
          .threshold(8)
          .negate()
          .png()
          .toBuffer();
        const fillMask = await sharp({
          create: {
            width: cfg.CANVAS.width,
            height: cfg.CANVAS.height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        })
          .composite([{ input: keepShape, left: carLayer.left, top: carLayer.top }])
          .png()
          .toBuffer();

        // referentie voor de differentiële check: heeft de ECHTE auto
        // zichtbare uitlaten? (FLUX verzint ze graag onder een EV-bumper)
        const cutoutFlat = await sharp(cutout)
          .flatten({ background: "#808080" })
          .jpeg({ quality: 85 })
          .toBuffer();
        const realExhaust = await visualYesNo(
          cutoutFlat, EXHAUST_PROMPT, CACHE_DIR, cfg.AI, cli.useCache,
        );

        // fill op ≤ fillMaxMegapixels (FLUX rekent per MP, naar boven
        // afgerond): scène-verlopen overleven de upscale onzichtbaar, de
        // auto gaat sowieso op volle resolutie terug
        const mpScale = Math.min(
          1,
          Math.sqrt(
            (cfg.GENBG.fillMaxMegapixels * 1e6) / (cfg.CANVAS.width * cfg.CANVAS.height),
          ),
        );
        const fw = Math.max(16, Math.round((cfg.CANVAS.width * mpScale) / 16) * 16);
        const fh = Math.max(16, Math.round((cfg.CANVAS.height * mpScale) / 16) * 16);

        // Gemini: stuur het beeld met de auto zwart gemaskeerd — zo kan
        // het model de auto niet zien en dus ook niet dupliceren. FLUX
        // gebruikt het volledige composiet + separaat fill-mask.
        // showroom-provider: meerdere invoerbeelden en een eigen samenstelling.
        // De cutout gaat op transparantie mee (geen zwart gat), het
        // positioneringsraster dicteert waar de auto komt, en daarna leggen we
        // onze eigen autolaag exact in datzelfde rechthoek terug — dát is wat
        // paste-back mogelijk maakt bij een model dat de hele scene tekent.
        if (cfg.GENBG.provider === "showroom") {
          const target = {
            left: carLayer.left,
            top: carLayer.top,
            width: scaledCarW,
            height: (await sharp(carLayer.input).metadata()).height ?? 1,
          };
          const grid = await sharp(
            positioningGrid(cfg.CANVAS, target, profile.horizonY ?? contactYUsed - 200),
          )
            .png()
            .toBuffer();
          const cutoutPng = await sharp(carLayer.input).png().toBuffer();
          const platePng = await sharp(backgroundPath)
            .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "cover" })
            .png()
            .toBuffer();
          const refs: Buffer[] = [];
          for (const r of cfg.GEMINI.styleRefs) {
            if (existsSync(r)) refs.push(await readFile(r));
          }
          for (let attempt = 0; attempt < cfg.GENBG.maxAttempts; attempt++) {
            const scene = await generateShowroomComposite(
              cutoutPng, platePng, grid, refs, cfg.GEMINI.showroomPrompt,
              cfg.GEMINI, CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
            );
            const sceneFull = await sharp(scene)
              .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "cover", position: "centre" })
              .png()
              .toBuffer();
            // rasterresten meten: magenta en cyaan komen in een grijze studio
            // niet voor, dus elke overgebleven pixel is een mislukking
            const { data: sd, info: si } = await sharp(sceneFull)
              .raw()
              .toBuffer({ resolveWithObject: true });
            let gridPixels = 0;
            for (let i = 0; i < sd.length; i += si.channels) {
              const r = sd[i] ?? 0, g = sd[i + 1] ?? 0, b = sd[i + 2] ?? 0;
              if ((r > 150 && b > 150 && g < 100) || (g > 150 && b > 150 && r < 100)) gridPixels++;
            }
            const candidate = await sharp(sceneFull)
              .composite([carLayer])
              .png()
              .toBuffer();
            // tweede-auto-poort: het positioneringsraster bleek Gemini niet te
            // weerhouden van het tekenen van een eigen auto naast de onze, en
            // die staat buiten ons masker dus de paste-back dekt hem niet
            const checkJpeg = await sharp(candidate).jpeg({ quality: 85 }).toBuffer();
            const canvasArea = cfg.CANVAS.width * cfg.CANVAS.height;
            const ownRect = {
              x: carLayer.left, y: carLayer.top,
              w: target.width, h: target.height,
            };
            const iou = (b: { x: number; y: number; w: number; h: number },
                         r: { x: number; y: number; w: number; h: number }): number => {
              const ix = Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x));
              const iy = Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
              const inter = ix * iy;
              return inter / (b.w * b.h + r.w * r.h - inter);
            };
            let extraCars = 0;
            try {
              extraCars = (await detectCars(checkJpeg, CACHE_DIR, cfg.AI, cli.useCache))
                .filter((b) => b.w * b.h > 0.02 * canvasArea)
                .filter((b) => iou(b, ownRect) < 0.4).length;
            } catch (err) {
              noteFalFailure(err);
            }
            if (gridPixels < 500 && extraCars === 0) {
              composited = candidate;
              genbgApplied = true;
              break;
            }
            console.warn(
              `  ⚠ ${file}: showroom-poging ${attempt + 1} afgekeurd: ` +
                (extraCars > 0
                  ? `${extraCars} vreemde auto('s) — het model tekende er zelf een bij`
                  : `${gridPixels} rasterpixels in de uitvoer`),
            );
          }
        } else {
        const isGemini = cfg.GENBG.provider === "gemini";
        const showCar = isGemini && cfg.GENBG.relight.enabled && cfg.GENBG.relight.showCar;
        const isQwen = cfg.GENBG.provider === "qwen";
        // Zwart afdekken werkt NIET bij instructie-editors: ze lezen het
        // zwarte silhouet als inhoud. Gemini vulde het gat met een verzonnen
        // auto, Qwen maakte er een zwart paneel van dat rechtop op de vloer
        // stond. Beide gemeten op beeld (5) van de Taycan-set.
        //
        // Qwen krijgt daarom het composiet MET zichtbare auto plus de
        // instructie die te behouden; de paste-back van de originele pixels
        // blijft de garantie, niet de prompt. Gemini houdt voorlopig het
        // maskerpad omdat dat pad zo geconfigureerd is.
        const maskedInput = isGemini;
        // keepShape heeft de afmeting van de AUTOLAAG, niet van het canvas.
        // Hem naar fw×fh schalen rekte het silhouet uit tot bijna het hele
        // frame en plaatste dat ook nog op de auto-offset: het model kreeg een
        // reusachtig zwart blok in plaats van een autovormig gat, en vulde dat
        // met een witte spookauto. Schalen met dezelfde mpScale als de rest.
        const shapeMeta = await sharp(keepShape).metadata();
        const shapeW = Math.max(1, Math.round((shapeMeta.width ?? 1) * mpScale));
        const shapeH = Math.max(1, Math.round((shapeMeta.height ?? 1) * mpScale));
        const fillInput = maskedInput
          ? await sharp(mathComposite)
              .resize(fw, fh, { fit: "fill" })
              .composite([{
                input: await sharp(keepShape)
                  .resize(shapeW, shapeH, { fit: "fill" })
                  .negate()
                  .png()
                  .toBuffer(),
                left: Math.round(carLayer.left * mpScale),
                top: Math.round(carLayer.top * mpScale),
              }])
              .png()
              .toBuffer()
          : await sharp(mathComposite)
              .resize(fw, fh, { fit: "fill" })
              .png()
              .toBuffer();
        // Differential diffusion: een gradiënt-masker i.p.v. een binair. Bij een
        // harde 0/255-grens moet het model precies op de maskerrand van
        // "behouden" naar "genereren" springen en dat levert de mesrand op die
        // we langs de auto zagen. Met een zachte band beslist het model per
        // pixel hoeveel er mag veranderen en zit de overgang in de generatie
        // zelf, niet in een light wrap achteraf.
        const fillMaskSmall = await sharp(fillMask)
          .resize(fw, fh, { fit: "fill" })
          .blur(Math.max(0.3, cfg.GENBG.maskFeather))
          .png()
          .toBuffer();

        // rand-restauratie: FLUX-signatures, pseudo-watermerken en
        // achtergrondauto's hangen vrijwel altijd tegen de beeldrand; de
        // buitenste band van de scène wordt met feather teruggezet naar het
        // mathematische composiet — op een vlakke plate onzichtbaar, en
        // deterministischer dan welke detectiepoort ook
        const bandW = Math.round(cfg.CANVAS.width * 0.045);
        const ringSvg = Buffer.from(
          `<svg width="${cfg.CANVAS.width}" height="${cfg.CANVAS.height}" xmlns="http://www.w3.org/2000/svg">` +
            `<path fill-rule="evenodd" fill="white" d="M0 0 H${cfg.CANVAS.width} V${cfg.CANVAS.height} H0 Z ` +
            `M${bandW} ${bandW} H${cfg.CANVAS.width - bandW} V${cfg.CANVAS.height - bandW} H${bandW} Z"/></svg>`,
        );
        const ringMask = await sharp(ringSvg).blur(bandW / 3).png().toBuffer();

        for (let attempt = 0; attempt < cfg.GENBG.maxAttempts; attempt++) {
          const scene = isGemini
            ? await generateScene(
                // met showCar krijgt het model het composiet mét de auto en
                // alleen de opdracht om te belichten; het zwarte masker gaf
                // een zwart vlak terug en dus niets om over te nemen
                showCar ? mathComposite : fillInput,
                showCar
                  ? (cli.vehicle
                      ? `${cfg.GEMINI.vehiclePrefix}${cli.vehicle}. `
                      : "") + cfg.GEMINI.relightPrompt
                  : cfg.GEMINI.maskPrefix + cfg.GENBG.prompt,
                cfg.GEMINI, CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
              )
            : isQwen
            ? await generateSceneQwen(
                fillInput, cfg.QWEN.keepPrefix + cfg.GENBG.prompt, cfg.QWEN,
                CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
              )
            : await fillScene(
                fillInput, fillMaskSmall, cfg.GENBG.prompt, cfg.GENBG.modelId,
                CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
              );
          // cover + center-crop, nooit "fill": Gemini levert zijn eigen
          // ratio (alleen presets) en fill zou de hele scène — en daarmee
          // de schaduwgeometrie — oprekken. Cover behoudt de verhoudingen;
          // wat afvalt zit aan de randen, waar toch de randband overheen gaat
          const sceneFull = await sharp(scene)
            .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "cover", position: "centre" })
            .png()
            .toBuffer();
          // randband = de scène zelf, zwaar geblurd: artefacten (pseudo-
          // watermerk, randauto's) worden onleesbare smeer, maar de toon
          // blijft naadloos — een plate-ring gaf een zichtbare lichte lijst
          const borderPatch = await sharp(sceneFull)
            .blur(24)
            .composite([{ input: ringMask, blend: "dest-in" }])
            .png()
            .toBuffer();
          // GUARD: rond het autosilhouet wint het mathematische composiet.
          //
          // Zonder deze band kan het model carrosserie aangroeien buiten het
          // masker, en dat valt precies buiten de paste-back-garantie. Op
          // beeld (5) verlengde Qwen de achterkant met een compleet extra
          // wiel inclusief wielkast; de hallucinatie-poort miste dat omdat de
          // detectiebox ervan overlapte met onze eigen auto en door de
          // IoU-filter als "onze auto" werd weggegooid.
          //
          // De prijs is dat de vloer vlak onder de auto — waar de
          // contactschaduw zit — van de wiskunde blijft komen in plaats van
          // van het model. Verder weg mag het model zijn scène leveren, en
          // daar zit het grootste deel van de winst (vloertoon, verte, licht).
          const guardLayers: sharp.OverlayOptions[] = [{ input: borderPatch }];
          if (cfg.GENBG.guardBandRatio > 0) {
            const band = Math.max(2, Math.round(scaledCarW * cfg.GENBG.guardBandRatio));
            const carAlpha = await sharp(carLayer.input)
              .ensureAlpha()
              .extractChannel(3)
              .png()
              .toBuffer();
            // blur + drempel groeit het silhouet met ongeveer `band` px; de
            // tweede blur maakt er een zachte overgang van zodat de guard
            // zelf geen zichtbare rand achterlaat
            const grown = await sharp(carAlpha)
              .blur(band)
              .threshold(16)
              .blur(Math.max(1, band / 3))
              .removeAlpha()
              .toColourspace("b-w")
              .png()
              .toBuffer();
            const guardMask = await sharp({
              create: {
                width: cfg.CANVAS.width,
                height: cfg.CANVAS.height,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
              },
            })
              .composite([{ input: grown, left: carLayer.left, top: carLayer.top }])
              .removeAlpha()
              .toColourspace("b-w")
              .png()
              .toBuffer();
            guardLayers.push({
              input: await sharp(mathComposite)
                .removeAlpha()
                .joinChannel(guardMask)
                .png()
                .toBuffer(),
            });
          }
          guardLayers.push(carLayer);
          let candidate = await sharp(sceneFull)
            .composite(guardLayers)
            .png()
            .toBuffer();

          // Het licht van de scène overnemen zonder de auto te hertekenen.
          //
          // Zonder deze stap is de terugplak alles-of-niets: het model blendt
          // de auto werkelijk in de scène — de vloer kaatst terug op de
          // dorpel, de wand licht de flank op, onder de wielkast wordt het
          // donker — en dat zit ín de autopixels. Plakken we het origineel er
          // pixel-exact overheen, dan gooien we precies die integratie weg.
          // Identiteit behouden, blend verloren.
          //
          // De lage frequentie mag van het model komen (dat is belichting),
          // de hoge blijft van ons (dat is de auto). Begrensd en gemeten.
          if (cfg.GENBG.relight.enabled) {
            // Eerst uitlijnen. Het model verplaatst en herschaalt de auto —
            // gemeten schoof Gemini hem op en maakte hem groter — en dan komt
            // het lokale gemiddelde van carrosserie waar bij ons lucht zit.
            let lightSource = sceneFull;
            const grey = await sharp(sceneFull)
              .greyscale()
              .raw()
              .toBuffer();
            const theirs = findCarBox(
              grey, cfg.CANVAS.width, cfg.CANVAS.height, contactYUsed,
              cfg.GENBG.relight.carThreshold,
            );
            const ourBox = {
              left: Math.round(placement.x),
              top: Math.round(placement.y),
              width: Math.round(placement.width),
              height: Math.round(placement.height),
            };
            if (theirs) {
              alignBox = { hun: theirs, ons: ourBox };
              lightSource = await alignCarRegion(sceneFull, theirs, ourBox);
            }
            const carAlpha = await sharp(carLayer.input)
              .ensureAlpha()
              .extractChannel(3)
              .png()
              .toBuffer();
            const maskFull = await sharp({
              create: {
                width: cfg.CANVAS.width,
                height: cfg.CANVAS.height,
                channels: 3,
                background: { r: 0, g: 0, b: 0 },
              },
            })
              .composite([{ input: carAlpha, left: carLayer.left, top: carLayer.top }])
              .greyscale()
              .png()
              .toBuffer();
            const relit = await adoptSceneLight(
              lightSource, candidate, maskFull,
              Math.max(2, Math.round(cfg.CANVAS.width * cfg.GENBG.relight.radiusRatio)),
              cfg.GENBG.relight.maxShift,
            );
            relightStats = {
              meanShift: Number(relit.meanShift.toFixed(2)),
              maxShift: Number(relit.maxShift.toFixed(1)),
              clipped: Number(relit.clipped.toFixed(3)),
            };
            // Loopt een groot deel tegen de begrenzing aan, dan lag de
            // gegenereerde auto niet op de onze — een ander model, een andere
            // kleur, een verschoven plaatsing. Dan is dit geen belichting meer
            // en hoort het beeld afgekeurd te worden in plaats van gered.
            if (relit.clipped <= cfg.GENBG.relight.maxClipped) {
              candidate = relit.image;
            }
          }
          const checkJpeg = await sharp(candidate).jpeg({ quality: 85 }).toBuffer();
          // deterministische tweede-auto-check: Florence vindt auto's
          // betrouwbaarder dan een klein VLM ze in een ja/nee-vraag ziet.
          // Een box telt niet mee als hij grotendeels samenvalt met onze
          // eigen auto (placement) of met diens vloerreflectie — al het
          // andere is een vreemde auto. Bewust géén kolomfilter: die had
          // een blinde vlek recht onder de auto.
          const canvasArea = cfg.CANVAS.width * cfg.CANVAS.height;
          const iou = (b: { x: number; y: number; w: number; h: number },
                       r: { x: number; y: number; w: number; h: number }): number => {
            const ix = Math.max(0, Math.min(b.x + b.w, r.x + r.w) - Math.max(b.x, r.x));
            const iy = Math.max(0, Math.min(b.y + b.h, r.y + r.h) - Math.max(b.y, r.y));
            const inter = ix * iy;
            return inter / (b.w * b.h + r.w * r.h - inter);
          };
          const ownRect = {
            x: placement.x, y: placement.y,
            w: placement.width, h: placement.height,
          };
          const reflRect = {
            x: placement.x, y: contactYUsed,
            w: placement.width, h: placement.height * 0.6,
          };
          const carBoxes = (await detectCars(checkJpeg, CACHE_DIR, cfg.AI, cli.useCache))
            .filter((b) => b.w * b.h > 0.02 * canvasArea)
            .filter((b) => iou(b, ownRect) < 0.25 && iou(b, reflRect) < 0.25);
          const others = await visualYesNo(
            checkJpeg, OTHERS_PROMPT, CACHE_DIR, cfg.AI, cli.useCache,
          );
          const sceneExhaust = await visualYesNo(
            checkJpeg, EXHAUST_PROMPT, CACHE_DIR, cfg.AI, cli.useCache,
          );
          const platform = await visualYesNo(
            checkJpeg, PLATFORM_PROMPT, CACHE_DIR, cfg.AI, cli.useCache,
          );
          // tekst-poort: OCR op de scène met de auto zwart afgedekt (badge en
          // dealerstickers op de auto mogen geen false positive geven); FLUX
          // signeert lage-resolutiescènes graag met pseudo-tekst in de hoek
          const carBlack = await sharp(carLayer.input)
            .linear([0, 0, 0, 1], [0, 0, 0, 0])
            .png()
            .toBuffer();
          const sceneOnly = await sharp(candidate)
            .composite([{ input: carBlack, left: carLayer.left, top: carLayer.top }])
            .jpeg({ quality: 85 })
            .toBuffer();
          const sceneText = (await readSceneText(sceneOnly, CACHE_DIR, cli.useCache))
            .replace(/[^A-Za-z0-9]/g, "");
          const partsInvented = sceneExhaust.yes && !realExhaust.yes;
          // na de kolomfilter is élke overgebleven box een vreemde auto
          const extraCar = carBoxes.length > 0;
          if (!extraCar && !others.yes && !partsInvented && !platform.yes) {
            composited = candidate;
            genbgApplied = true;
            break;
          }
          const reason = extraCar
            ? `tweede auto gedetecteerd (${carBoxes.length} auto-boxes)`
            : others.yes
            ? `extra voertuig/persoon (${others.answer})`
            : partsInvented
              ? `verzonnen uitlaten (${sceneExhaust.answer})`
              : platform.yes
                ? `podium/vloermarkering (${platform.answer})`
                : `verzonnen tekst ("${sceneText.slice(0, 40)}")`;
          console.warn(`  ⚠ ${file}: scène-poging ${attempt + 1} afgekeurd: ${reason}`);
        }
        }
        if (!genbgApplied) {
          warnings.push({
            code: "GENBG_REJECTED",
            message: `alle ${cfg.GENBG.maxAttempts} scène-pogingen afgekeurd — mathematisch composiet gebruikt`,
          });
        }
      } catch (err) {
        noteFalFailure(err);
        console.warn(
          `  ⚠ ${file}: generatieve scène overgeslagen: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    composited = await applyFinish(composited, cfg.FINISH);
    const anonymized = plateEnabled
      ? await anonymizePlates(composited, plateTargets, cfg.CANVAS, cfg.PLATE, cfg.AI.plateText)
      : { image: composited, status: "off" as PlateStatus };
    plateStatus = anonymized.status;
    const branded = await applyBranding(anonymized.image, cfg.CANVAS, cfg.BRANDING);
    outJpeg = await withProvenance(branded, cfg, {
      generative: genbgApplied,
      models: genbgApplied
        ? [cfg.GENBG.provider === "gemini" ? cfg.GEMINI.modelId : cfg.GENBG.modelId]
        : [],
      operations: activeOperations(cfg, {
        windowsTinted: windowInfo.tintedPixels > 0,
        plateAnonymised: plateStatus === "replaced" || plateStatus === "blurred",
        paintDamped: paintDamped > 0,
        composited: true,
      }),
    });
    const outName = path.parse(file).name + ".jpg";
    const outDir = path.join(OUT_DIR, path.parse(file).dir);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, outName), outJpeg);
  } else if (!compositeThisImage) {
    // passthrough voor niet-exterieurfoto's: originele opname behouden, alleen
    // op canvasformaat brengen plus de gedeelde finishing grade en branding,
    // zodat de listing als geheel één look houdt.
    //
    // Bewust GEEN harmonisatie: die trekt kleuren naar de toon van de
    // studioplate, en een dashboard staat niet op die plate. En bewust geen
    // plaat-anonimisatie: de plaatregio's zijn via `placement` gemapt, dat
    // hier betekenisloos is. Staat er een plaat op een detailopname, dan moet
    // die apart worden afgehandeld — zie NOT_EXTERIOR in run.jsonl.
    const framed = await sharp(inputBytes)
      .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "cover", position: "centre" })
      .png()
      .toBuffer();
    const graded = await applyFinish(framed, cfg.FINISH);
    const branded = await applyBranding(graded, cfg.CANVAS, cfg.BRANDING);
    outJpeg = await withProvenance(branded, cfg, {
      generative: false,
      models: [],
      operations: activeOperations(cfg, {
        windowsTinted: false,
        plateAnonymised: false,
        paintDamped: false,
        composited: false,
      }),
    });
    const outName = path.parse(file).name + ".jpg";
    const outDir = path.join(OUT_DIR, path.parse(file).dir);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, outName), outJpeg);
  }

  // objectieve maten op het eindbeeld: korrelverschil tussen auto en scene en
  // hoeveel van de auto op zwart is dichtgeslagen. Kost niets en maakt van
  // "ziet er uitgeknipt uit" een getal in run.jsonl.
  let audit: CompositeAudit | null = null;
  if (outJpeg && placement && compositeThisImage) {
    audit = await auditComposite(outJpeg, placement, cfg.CANVAS);
    for (const message of audit ? auditWarnings(audit) : []) {
      warnings.push({ code: "COMPOSITE_AUDIT", message });
    }
  }

  // AI-kwaliteitscontrole: masker compleet? auto op de grond?
  if (cfg.AI.enabled && cfg.AI.qaChecks && cli.ai && analysis.bbox) {
    const flatCutout = await sharp(cutout)
      .flatten({ background: "#808080" })
      .jpeg({ quality: 85 })
      .toBuffer();
    // deze checks beoordelen alleen het al geschreven eindbeeld; ze mogen het
    // dus nooit alsnog laten falen
    try {
      const maskCheck = await visualYesNo(flatCutout, MASK_PROMPT, CACHE_DIR, cfg.AI, cli.useCache);
      if (!maskCheck.yes) {
        warnings.push({ code: "AI_MASK_SUSPECT", message: `AI-maskcheck: ${maskCheck.answer}` });
      }
      if (outJpeg) {
        const groundCheck = await visualYesNo(outJpeg, GROUND_PROMPT, CACHE_DIR, cfg.AI, cli.useCache);
        if (!groundCheck.yes) {
          warnings.push({ code: "AI_NOT_GROUNDED", message: `AI-grondcheck: ${groundCheck.answer}` });
        }
      }
    } catch (err) {
      noteFalFailure(err);
      console.warn(
        `  ⚠ ${file}: AI-kwaliteitscontrole overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (cli.debug) {
    await writeDebugOutput(
      file, inputPath, alpha, width, height, analysis, placement, warnings, cfg,
      {
        matteProvider: cfg.MATTE.provider,
        maskImpl: matteApplied
          ? `${cfg.MATTE.provider}+sam2+carbox`
          : detection
            ? `${cfg.MATTE.provider}+carbox`
            : cfg.MATTE.provider,
        detectConfidence: detection ? Number(detection.confidence.toFixed(4)) : null,
        carBox: detection?.box ?? null,
        outsideBoxRemoved,
        matteRemoved,
        plates: plates.length,
        plateQuads: plateTargets.filter((t) => t.quad).length,
        plateStatus,
        contactClusters: shadowClusters.length,
        wheelClusters: shadowClusters,
        groundTrim: analysis.groundTrim,
        groundTrimmedPx,
        groundFallback: analysis.groundFallback,
        windows: windowInfo,
        highlightPixels,
        paintDamped,
        audit,
        genbg: genbgApplied,
        exterior: classification.isExterior,
        exteriorScore: `${classification.score}/${classification.total}`,
        composited: compositeThisImage,
        contactY: contactYUsed,
        widthRatio: Number(widthRatio.toFixed(4)),
        wheelScale: wheelScale === null ? null : Number(wheelScale.toFixed(4)),
        wheelsMeasured: measuredWheels.length,
        preset: cli.preset ?? null,
        levelled: Number(levelled.toFixed(2)),
        relight: relightStats,
        relightAlign: alignBox,
        harmonizeGains: harmonizeGains
          ? {
              r: Number(harmonizeGains.r.toFixed(3)),
              g: Number(harmonizeGains.g.toFixed(3)),
              b: Number(harmonizeGains.b.toFixed(3)),
            }
          : null,
        profile: {
          background: path.basename(backgroundPath),
          contactTargetY: profile.contactTargetY,
          floorScaleRef: profile.floorScaleRef,
          lightDirX: profile.lightDirX,
          floorReflectivity: profile.floorReflectivity,
        },
      },
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
  console.log(`BiRefNet:    ${maskStats.apiCalls} calls, ${maskStats.cacheHits} cache-hits`);
  console.log(`auto-detect: ${maskStats.detectCalls} calls, ${maskStats.detectCacheHits} cache-hits`);
  console.log(`plaatdetect: ${aiStats.detectCalls} calls, ${aiStats.detectCacheHits} cache-hits`);
  console.log(`AI-checks:   ${aiStats.vlmCalls} calls, ${aiStats.vlmCacheHits} cache-hits`);
  console.log(
    `SAM2-segm.:  ${aiStats.segmentCalls} calls, ${aiStats.segmentCacheHits} cache-hits (matte + ruiten)`,
  );
  const sceneLabel =
    cfg.GENBG.provider === "gemini"
      ? "Gemini NB"
      : cfg.GENBG.provider === "qwen"
        ? "Qwen Edit"
        : "FLUX Fill";
  console.log(`${sceneLabel}:   ${aiStats.fillCalls} FLUX + ${geminiStats.calls} Gemini + ${qwenStats.calls} Qwen calls, ${aiStats.fillCacheHits + geminiStats.cacheHits + qwenStats.cacheHits} cache-hits (scène)`);
  const sam3For = (["windows", "wheels"] as const).filter(
    (k) => cfg.SEGMENT.providers[k] === "sam3",
  );
  if (sam3For.length > 0) {
    const wat = sam3For.map((k) => (k === "windows" ? "ruiten" : "wielen")).join(" + ");
    console.log(
      `SAM 3:       ${sam3Stats.calls} calls, ${sam3Stats.cacheHits} cache-hits (${wat})`,
    );
  }
  console.log(`OCR:         ${aiStats.ocrCalls} calls, ${aiStats.ocrCacheHits} cache-hits (tekst-poort)`);

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

  const genbgCostPerCall =
    cfg.GENBG.provider === "gemini"
      ? cfg.GEMINI.costPerCall
      : cfg.GENBG.provider === "qwen"
        ? cfg.QWEN.costPerCall
        : cfg.GENBG.costPerCall;
  const genbgCallCount = cfg.GENBG.provider === "gemini"
    ? geminiStats.calls
    : cfg.GENBG.provider === "qwen"
    ? qwenStats.calls
    : aiStats.fillCalls;
  const runCost =
    (cfg.MATTE.provider === "rembg" ? 0 : maskStats.apiCalls * cfg.COST_PER_CALL_USD) +
    maskStats.detectCalls * cfg.AI.costPerDetection +
    aiStats.detectCalls * cfg.AI.costPerDetection +
    aiStats.vlmCalls * cfg.AI.costPerQuery +
    aiStats.segmentCalls * cfg.AI.costPerSegment +
    genbgCallCount * genbgCostPerCall +
    aiStats.ocrCalls * cfg.AI.costPerDetection +
    sam3Stats.calls * cfg.SEGMENT.costPerCall;
  // de lokale rembg-matte kost niets; alleen de fal-providers tellen mee
  const sam3Wheels = cfg.SEGMENT.providers.wheels === "sam3";
  const sam3Windows = cfg.SEGMENT.providers.windows === "sam3";
  const matteCost = cfg.MATTE.provider === "rembg" ? 0 : cfg.COST_PER_CALL_USD;
  const perImage =
    matteCost +
    (cfg.DETECT.enabled ? cfg.AI.costPerDetection : 0) +
    // plaat- + wieldetectie; met sam3 gaat de wielquery via SAM 3
    (cfg.AI.enabled
      ? cfg.AI.costPerDetection +
        (sam3Wheels ? cfg.SEGMENT.costPerCall : cfg.AI.costPerDetection)
      : 0) +
    (cfg.AI.enabled && cfg.AI.qaChecks ? 2 * cfg.AI.costPerQuery : 0) +
    (cfg.WINDOWS.enabled
      ? sam3Windows
        ? cfg.SEGMENT.costPerCall
        : // één detect per prompt, niet één in totaal
          cfg.WINDOWS.detectPrompts.length * cfg.AI.costPerDetection +
          cfg.AI.costPerSegment
      : 0) +
    (cfg.MATTE.enabled ? cfg.AI.costPerSegment : 0) +
    (cfg.PLATE.mode === "replace" ? cfg.AI.costPerSegment : 0) +
    (cfg.GENBG.enabled && cfg.GENBG.mode === "all" ? cfg.GENBG.costPerCall : 0);
  const monthly = cfg.MONTHLY_VOLUME * perImage;
  console.log(
    `\nkosten: $${runCost.toFixed(4)} deze run ` +
      `(per beeld: $${perImage.toFixed(4)} — tarieven ijken op fal-dashboard)`,
  );
  if (cfg.GENBG.enabled && cfg.GENBG.mode === "hero") {
    console.log(
      `genbg (hero): ~$${cfg.GENBG.costPerCall.toFixed(2)}/poging, alleen de eerste bruikbare foto per batch`,
    );
  }
  console.log(
    `extrapolatie ${cfg.MONTHLY_VOLUME.toLocaleString("nl-BE")} beelden/maand: ~$${monthly.toFixed(0)}/maand`,
  );
}

/**
 * Set-referentie per auto: het gedeelde witpunt van álle foto's van één
 * voertuig (map = auto). Zonder dit krijgt elke foto zijn eigen
 * kleurcorrectie, en leest een set die half bij ochtendlicht en half in de
 * namiddagzon geschoten is als twee verschillende auto's.
 *
 * Kost geen extra API-calls: de cutout die hier gelezen wordt is dezelfde die
 * processImage straks uit de cache haalt.
 */
async function computeSetReferences(
  files: string[],
  cfg: Config,
  cli: CliOptions,
): Promise<Map<string, ChannelMeans>> {
  const perCar = new Map<string, ChannelMeans[]>();
  for (const file of files) {
    try {
      const cutout = await getCutout(
        path.join(IN_DIR, file), CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache,
      );
      const { data, info } = await sharp(cutout)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const n = info.width * info.height;
      const alpha = new Uint8Array(n);
      for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3] ?? 0;
      const key = path.dirname(file);
      const list = perCar.get(key) ?? [];
      list.push(cutoutMeans(data, alpha, info.width, info.height));
      perCar.set(key, list);
    } catch (err) {
      // een beeld dat hier faalt, faalt straks opnieuw mét nette melding;
      // de referentie wordt dan uit de overige foto's van deze auto bepaald
      noteFalFailure(err);
    }
  }
  const refs = new Map<string, ChannelMeans>();
  for (const [key, list] of perCar) refs.set(key, medianMeans(list));
  return refs;
}

function synthPrompt(spec: string, feedback: string[]): string {
  let p =
    `Create a professional catalogue photo of this exact vehicle: ${spec}.\n` +
    "The attached photos are the ONLY truth for this vehicle's design: " +
    "body, paint colour, wheels, badges, lights, grille, trim, mirrors and " +
    "glass. Reconstruct the car from them — do not restyle, modernise or " +
    "invent anything.\n" +
    "ANGLE: three-quarter FRONT view with the front of the car on the " +
    "RIGHT of the frame, roughly 30-35 degrees off axis, camera height " +
    "1.0-1.3 m.\n" +
    "BACKGROUND: a seamless light grey photo studio (wall around #f0f2f4 " +
    "fading into a slightly darker smooth floor), a soft contact shadow " +
    "under the tyres and a subtle floor reflection. Neutral studio " +
    "reflections in the paint — no trees, no buildings.\n" +
    "The whole car stays in frame with clear margin on every side. No " +
    "people, no text, no watermark, no props. Licence plate: plain dark " +
    "plate without readable characters.";
  if (feedback.length > 0) {
    p +=
      "\nA previous attempt was rejected by inspection for these " +
      "deviations — correct every one of them:\n" +
      feedback.map((f) => `- ${f}`).join("\n");
  }
  return p;
}

/**
 * De ontbrekende catalogushoek genereren uit de foto's die er wél zijn.
 *
 * Volledige generatie, dus dubbel bewaakt: Gemini identificeert eerst het
 * exacte model uit de set, en elke kandidaat moet daarna door een
 * inspecteursvergelijking tegen de bronfoto's (zelfde model, zelfde velgen,
 * geen weggevallen of verzonnen details). Afwijkingen gaan als feedback de
 * volgende poging in. Zonder overtuigende kandidaat wordt er niets
 * geschreven. Het geaccepteerde beeld gaat daarna als gewone input door de
 * deterministische pipeline — kadrering, plaat en schaduw blijven code.
 */
/** Gemiddelde lakkleur van één beeld, gemeten op de matte-pixels. */
async function paintMeansOf(
  filePath: string,
  cfg: Config,
  useCache: boolean,
): Promise<ChannelMeans> {
  const cutout = await getCutout(filePath, CACHE_DIR, cfg.FAL, cfg.MATTE, useCache);
  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const alpha = new Uint8Array(n);
  for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3] ?? 0;
  return cutoutMeans(data, alpha, info.width, info.height);
}

async function synthesizeAngle(
  dir: string,
  cfg: Config,
  cli: CliOptions,
): Promise<Buffer> {
  const all = await findImages(IN_DIR);
  const refFiles = all.filter(
    (f) => path.dirname(f) === dir && !path.basename(f).startsWith("_synth"),
  );
  if (refFiles.length === 0) {
    throw new Error(`geen bronfoto's gevonden in ${IN_DIR}/${dir}/`);
  }
  const refs: ImagePart[] = [];
  for (const f of refFiles) {
    refs.push({
      data: await readFile(path.join(IN_DIR, f)),
      mime: f.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
    });
  }
  const spec = await identifyVehicle(refs, cfg.GEMINI, CACHE_DIR, cli.useCache);
  console.log(`  voertuig: ${spec}`);

  // lak-referentie: mediaan over de bronfoto's, robuust tegen één afwijkende
  // opname. Faalt de matte op álle bronfoto's, dan is er niets om tegen te
  // meten en blijft alleen de VLM-inspectie over — met een melding, zodat
  // een stille terugval niet voor een strengere poort wordt aangezien.
  const srcMeans: ChannelMeans[] = [];
  for (const f of refFiles) {
    try {
      srcMeans.push(await paintMeansOf(path.join(IN_DIR, f), cfg, cli.useCache));
    } catch (err) {
      noteFalFailure(err);
    }
  }
  const srcMedian = srcMeans.length > 0 ? medianMeans(srcMeans) : null;
  if (!srcMedian) {
    console.warn(
      "  ⚠ geen bron-lakmediaan meetbaar (matte faalde op alle bronfoto's) — " +
        "lakbewaking draait alleen op de VLM-inspectie",
    );
  }

  let best: { img: Buffer; issues: string[] } | null = null;
  let feedback: string[] = [];
  for (let attempt = 0; attempt < cfg.GENBG.maxAttempts; attempt++) {
    let img = await generateNovelView(
      refs, synthPrompt(spec, feedback), cfg.GEMINI, CACHE_DIR, cli.useCache,
      cfg.GENBG.seed + attempt,
    );
    // harde dimensiepoort vóór de (betaalde) inspectie: het model rendert
    // alleen op zijn eigen vaste raster (3:2@2K = 2528×1696, gemeten
    // 2026-07-30) — wijkt de ratio af, dan is er iets mis met de transport
    // en heeft vergelijken geen zin
    const dims = await sharp(img).metadata();
    const ratio = (dims.width ?? 0) / Math.max(1, dims.height ?? 1);
    if (Math.abs(ratio - 3 / 2) > 0.02) {
      console.warn(
        `  ⚠ synth-poging ${attempt + 1} verworpen: ${dims.width}×${dims.height} is geen 3:2`,
      );
      continue;
    }
    const verdict = await compareAgainstSources(
      { data: img }, refs, spec, cfg.GEMINI, CACHE_DIR, cli.useCache,
    );
    // deterministische lakmeting naast de VLM-inspectie: zilver dat wit
    // rendert kwam door de inspectie heen, maar niet door de meting
    let paintIssue: string | null = null;
    if (srcMedian) {
      const candPath = path.join(CACHE_DIR, `synth-candidate-${cfg.GENBG.seed + attempt}.jpg`);
      await writeFile(candPath, img);
      const cand = await paintMeansOf(candPath, cfg, cli.useCache);
      paintIssue = paintDeviation(cand, srcMedian, cfg.SYNTH);
      // corrigeren i.p.v. afkeuren — maar alleen wanneer de VLM de lak wél
      // goed vond en enkel de meting klaagt: een tintverschuiving is met
      // per-kanaal curves exact te repareren, ontbrekende metallic-flake of
      // een andere kleurfamilie niet. De correctie wordt nagemeten; blijft
      // er afwijking over, dan blijft de poging gewoon afgekeurd.
      if (paintIssue && verdict.sameVehicle && verdict.paintMatch) {
        const gains = paintCorrectionGains(cand, srcMedian);
        const corrected = await sharp(img)
          .linear([gains[0], gains[1], gains[2]], [0, 0, 0])
          .jpeg({ quality: 97 })
          .toBuffer();
        const corrPath = path.join(
          CACHE_DIR, `synth-corrected-${cfg.GENBG.seed + attempt}.jpg`,
        );
        await writeFile(corrPath, corrected);
        const remeasured = await paintMeansOf(corrPath, cfg, cli.useCache);
        const residual = paintDeviation(remeasured, srcMedian, cfg.SYNTH);
        if (residual === null) {
          img = corrected;
          paintIssue = null;
          console.log(
            `  lak deterministisch naar de bron-mediaan gecorrigeerd ` +
              `(gains ${gains.map((g) => g.toFixed(3)).join("/")})`,
          );
        }
      }
    }
    const allIssues = [
      ...verdict.issues,
      ...(verdict.paintMatch ? [] : ["inspection judged the paint colour different from the sources"]),
      ...(paintIssue ? [paintIssue] : []),
    ];
    const acceptable = verdict.sameVehicle && verdict.paintMatch && paintIssue === null;
    if (acceptable && (best === null || verdict.issues.length < best.issues.length)) {
      best = { img, issues: verdict.issues };
    }
    if (acceptable && verdict.issues.length === 0) break;
    console.warn(
      `  ⚠ synth-poging ${attempt + 1} ` +
        (verdict.sameVehicle
          ? acceptable ? "met afwijkingen" : "afgekeurd (lak)"
          : "afgekeurd (andere auto)") +
        `: ${allIssues.join("; ") || "(geen detail opgegeven)"}`,
    );
    if (allIssues.length > 0) feedback = allIssues;
  }
  if (!best) {
    throw new Error(
      `synthese na ${cfg.GENBG.maxAttempts} pogingen afgekeurd — geen enkele ` +
        "kandidaat was overtuigend dezelfde auto; er wordt niets gepubliceerd",
    );
  }
  if (best.issues.length > 0) {
    console.warn(
      `  ⚠ [SYNTH_IDENTITY] beste kandidaat houdt afwijkingen: ${best.issues.join("; ")}`,
    );
  }
  // de geaccepteerde kandidaat duurzaam bewaren, los van de seed-gebonden
  // generatiecache: dit is het beeld dat door alle poorten kwam, en het
  // moet terug te vinden zijn ook nadat out/ is opgeruimd
  await writeFile(
    path.join(CACHE_DIR, `accepted-synth-${dir.replace(/[/\\]/g, "_")}.jpg`),
    best.img,
  );
  return best.img;
}

async function main(): Promise<void> {
  const { cfg, cli } = parseCli();
  for (const dir of [IN_DIR, OUT_DIR, DEBUG_DIR, CACHE_DIR, BG_DIR]) {
    await mkdir(dir, { recursive: true });
  }
  const backgroundPath = await resolveBackground(cli, cfg);

  let files: string[];
  if (cli.synth) {
    // een bestaande thumbnail is een goedgekeurd beeld en wordt nooit stil
    // vervangen: elke hergeneratie is non-deterministisch en kan slechter
    // uitvallen (gebeurd op 2026-07-30 — een prima thumbnail werd door een
    // rerun met een gewijzigde referentieset overschreven). Hergenereren is
    // een expliciete daad: verwijder het bestand eerst.
    const outDir = path.join(OUT_DIR, cli.synth);
    const thumbPath = path.join(outDir, "thumbnail.jpg");
    if (existsSync(thumbPath)) {
      console.log(
        `thumbnail bestaat al: ${thumbPath} — wordt niet vervangen. ` +
          "Verwijder het bestand als je bewust wil hergenereren.",
      );
      return;
    }
    // de galerij is 3:2 — los van welk target verder actief is
    cfg.GEMINI.aspectRatio = "3:2";
    // het goedgekeurde studiobeeld ÍS het eindresultaat (besluit 2026-07-30):
    // geen witte uitsnede, geen hercompositing, plaathouder blijft zoals
    // gegenereerd. Publiceren = wegschrijven, en out/<map>/ houdt exact
    // één bestand over.
    const accepted = await synthesizeAngle(cli.synth, cfg, cli);
    await mkdir(outDir, { recursive: true });
    for (const entry of await readdir(outDir, { withFileTypes: true })) {
      if (entry.isFile()) await rm(path.join(outDir, entry.name), { force: true });
    }
    await writeFile(thumbPath, accepted);
    console.log(`\nthumbnail: ${thumbPath} — enige beeld in ${outDir}/`);
    return;
  }
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

  if (cli.debug) {
    // per-auto debug: de eerste writeDebugOutput maakt de subdir + run.jsonl aan
  }
  console.log(
    `${files.length} beeld(en), achtergrond: ${backgroundPath}, ` +
      `ground-y: ${cfg.GROUND_Y}, car-width: ${cfg.CAR_WIDTH_RATIO}`,
  );

  const setRefs = cfg.HARMONIZE.setConsistent
    ? await computeSetReferences(files, cfg, cli)
    : new Map<string, ChannelMeans>();
  if (setRefs.size > 0) {
    console.log(`set-referentie bepaald voor ${setRefs.size} auto('s)`);
  }

  const results: ImageResult[] = [];
  const run: RunContext = { heroPending: true };
  for (const file of files) {
    process.stdout.write(`→ ${file}\n`);
    try {
      results.push(
        await processImage(
          file, backgroundPath, cfg, cli, run, setRefs.get(path.dirname(file)),
        ),
      );
    } catch (err) {
      // één mislukking mag de batch niet stoppen
      const message = err instanceof Error
        ? (err.message || ((err as any).body ? JSON.stringify((err as any).body).slice(0, 200) : err.name))
        : String(err);
      console.error(`  ✗ ${file}: ${message}`);
      results.push({ file, ok: false, error: message, warnings: [] });
    }
  }

  // detailcontrole achteraf: het eindbeeld langs de bron leggen en laten
  // benoemen wat er is weggevallen (matte at de antenne op, sierlijst weg).
  // Bewust ná de batch: de vergelijking verandert niets aan de beelden, ze
  // maakt het verlies alleen zichtbaar in de samenvatting.
  if (cli.checkDetails) {
    for (const r of results) {
      if (!r.ok) continue;
      const outPath = path.join(
        OUT_DIR, path.parse(r.file).dir, path.parse(r.file).name + ".jpg",
      );
      if (!existsSync(outPath)) continue;
      try {
        const source = await readFile(path.join(IN_DIR, r.file));
        const final = await readFile(outPath);
        const spec = await identifyVehicle(
          [{ data: source }], cfg.GEMINI, CACHE_DIR, cli.useCache,
        );
        const verdict = await compareAgainstSources(
          { data: final }, [{ data: source }], spec,
          cfg.GEMINI, CACHE_DIR, cli.useCache,
        );
        for (const issue of verdict.issues) {
          console.warn(`  ⚠ ${r.file}: [AI_DETAIL_LOSS] ${issue}`);
          r.warnings.push({ code: "AI_DETAIL_LOSS", message: issue });
        }
      } catch (err) {
        console.warn(
          `  ⚠ ${r.file}: detailcontrole mislukt: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  printSummary(results, cfg);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
