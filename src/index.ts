import "dotenv/config";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import {
  analyzeAlpha,
  applyInstanceMatte,
  cleanAlpha,
  clustersFromWheelBoxes,
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
  generateDefaultBackground,
  type Placement,
} from "./composite.js";
import { defaultConfig, type Config } from "./config.js";
import {
  aiStats,
  detectPlates,
  detectWheels,
  detectCars,
  detectWindows,
  fillScene,
  readSceneText,
  segmentByBoxes,
  visualYesNo,
} from "./ai.js";
import { applyWindowTint, filterBoxesOnCar, filterPlausibleWindowBoxes } from "./windows.js";
import { getCarBox, getCutout, maskStats } from "./mask.js";
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
} from "./harmonize.js";
import { applyBranding } from "./branding.js";
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
  ai: boolean;
  detect: boolean;
  groundYOverride?: number; // --ground-y wint van het BackgroundProfile
  carWidthOverride?: number; // --car-width (ratio) wint van floorScaleRef
  preset?: keyof Config["PRESETS"]; // fase 4: per-hoek kadrering
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
      bg: { type: "string" },
      "ground-y": { type: "string" },
      "car-width": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      "no-debug": { type: "boolean", default: false },
      "no-ai": { type: "boolean", default: false },
      "no-detect": { type: "boolean", default: false },
      "no-windows": { type: "boolean", default: false },
      "no-harmonize": { type: "boolean", default: false },
      "no-genbg": { type: "boolean", default: false },
      genbg: { type: "string" },
      matte: { type: "string" },
      plate: { type: "string" },
      preset: { type: "string" },
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
  if (values["no-windows"]) cfg.WINDOWS.enabled = false;
  if (values["no-harmonize"]) cfg.HARMONIZE.enabled = false;
  if (values["no-genbg"]) cfg.GENBG.enabled = false;
  if (values.genbg !== undefined) {
    if (!["hero", "all"].includes(values.genbg)) {
      throw new Error("--genbg moet hero of all zijn");
    }
    cfg.GENBG.mode = values.genbg as Config["GENBG"]["mode"];
  }
  if (values.matte !== undefined) {
    if (!["fal-birefnet", "fal-rmbg", "api4ai"].includes(values.matte)) {
      throw new Error("--matte moet fal-birefnet, fal-rmbg of api4ai zijn");
    }
    cfg.MATTE.provider = values.matte as Config["MATTE"]["provider"];
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
  extras: Record<string, unknown> = {},
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
    shadowBandHeight: analysis.shadowBandHeight,
    topBump: analysis.topBump,
    qa: warnings.map((w) => w.code),
    ...extras,
  };
  await appendFile(RUN_LOG, `${JSON.stringify(line)}\n`);
}

interface RunContext {
  heroPending: boolean; // hero-modus: is de generatieve scène nog te vergeven?
}

async function processImage(
  file: string,
  backgroundPath: string,
  cfg: Config,
  cli: CliOptions,
  run: RunContext,
): Promise<ImageResult> {
  const inputPath = path.join(IN_DIR, file);
  const inputBytes = await readFile(inputPath);

  const useDetect = cfg.DETECT.enabled && cli.detect;
  const detection = useDetect
    ? await getCarBox(inputPath, CACHE_DIR, cfg.DETECT, cli.useCache)
    : null;

  const cutout = await getCutout(inputPath, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);

  const { data, info } = await sharp(cutout)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

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
      const maskPng = await segmentByBoxes(
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

  const analysis = analyzeAlpha(alpha, width, height, {
    threshold: cfg.ALPHA_THRESHOLD,
    groundPercentile: cfg.GROUND_PERCENTILE,
    minBlobArea: cfg.QA.minBlobArea,
  });

  // fase 1 — plaatsing op de gekalibreerde vloer van deze plate: contactlijn
  // op contactTargetY, schaal via px/meter i.p.v. vaste canvasfractie
  const profile =
    cfg.BACKGROUND_PROFILES[path.basename(backgroundPath)] ?? cfg.DEFAULT_PROFILE;
  const preset = cli.preset ? cfg.PRESETS[cli.preset] : undefined;
  const contactY =
    cli.groundYOverride ?? preset?.contactTargetY ?? profile.contactTargetY;
  const spanMeters = preset?.spanMeters ?? profile.carWidthMeters;
  const widthRatio =
    cli.carWidthOverride ?? (spanMeters * profile.floorScaleRef) / cfg.CANVAS.width;

  // aangesmolten slagschaduw onder de wiellijn uit het masker snijden, zodat
  // die niet als grijze appendage onder de auto in het eindbeeld belandt
  let groundTrimmedPx = 0;
  if (analysis.bbox && analysis.groundLine !== null && analysis.groundTrim > 0) {
    // ruime marge: liever een paar schaduwpixels laten staan (vallen in de
    // contactschaduw) dan echte bandpixels wegsnijden
    const slack = Math.max(4, Math.round(height * 0.004));
    groundTrimmedPx = trimAlphaBelow(alpha, width, height, analysis.groundLine + slack);
    if (groundTrimmedPx > 0) {
      for (let i = 0; i < alpha.length; i++) data[i * 4 + 3] = alpha[i] ?? 0;
    }
  }

  let placement: Placement | null = null;
  if (analysis.bbox && analysis.groundLine !== null) {
    placement = computePlacement(
      analysis.bbox,
      analysis.groundLine,
      cfg.CANVAS,
      contactY,
      widthRatio,
    );
  }
  // fase 3 — harmonisatie: buitenlicht-zweem subtiel richting de
  // achtergrondtoon trekken vóór de ruit-tint
  let harmonizeGains: { r: number; g: number; b: number } | null = null;
  if (cfg.HARMONIZE.enabled && analysis.bbox) {
    const bg = await backgroundMeans(backgroundPath, cfg.CANVAS.width, cfg.CANVAS.height);
    const car = cutoutMeans(data, alpha, width, height);
    harmonizeGains = harmonizeColors(data, alpha, width, height, car, bg, cfg.HARMONIZE);
  }
  // specular-compressie: felle reflecties van de oorspronkelijke tl-balken/
  // spots in de lak dempen zodat ze niet vloeken met de rustige studio-look
  let highlightPixels = 0;
  if (cfg.HIGHLIGHTS.enabled && analysis.bbox) {
    highlightPixels = compressHighlights(data, alpha, width, height, cfg.HIGHLIGHTS);
  }

  // ruiten donker tinten zodat de oorspronkelijke omgeving niet door het
  // glas zichtbaar blijft (detectie + SAM2-masker + wiskundige verdonkering)
  const windowInfo = { boxes: 0, tintedPixels: 0 };
  if (cfg.WINDOWS.enabled && cli.ai && analysis.bbox) {
    try {

      const detectedWindows = (
        await Promise.all(
          cfg.WINDOWS.detectPrompts.map((prompt) =>
            detectWindows(inputBytes, prompt, CACHE_DIR, cfg.AI, cli.useCache),
          ),
        )
      ).flat();
      const onCar = filterBoxesOnCar(
        filterPlausibleWindowBoxes(detectedWindows, analysis.bbox),
        alpha, width, height, cfg.ALPHA_THRESHOLD,
      );
      windowInfo.boxes = onCar.length;
      if (onCar.length > 0) {
        const maskPng = await segmentByBoxes(
          inputBytes, onCar, cfg.WINDOWS.segmentModelId, CACHE_DIR, cli.useCache,
        );
        const maskRaw = await sharp(maskPng)
          .resize(width, height, { fit: "fill" })
          .greyscale()
          .blur(cfg.WINDOWS.featherSigma)
          .raw()
          .toBuffer();
        windowInfo.tintedPixels = applyWindowTint(
          data, alpha,
          new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, width * height),
          width, height, cfg.WINDOWS,
        );
      }
    } catch (err) {
      // tint is cosmetisch: een falende segmentatie mag het beeld niet blokkeren
      console.warn(
        `  ⚠ ${file}: ruit-tint overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
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

    const detected = await detectPlates(inputBytes, CACHE_DIR, cfg.AI, cli.useCache);
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
          inputBytes, [src], cfg.WINDOWS.segmentModelId, CACHE_DIR, cli.useCache,
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

  // wielposities via detectie: contour-geometrie mist verre wielen die
  // nauwelijks onder de onderbodemlijn uitsteken (RVV-achterwiel)
  let shadowClusters = analysis.contactClusters;
  if (cli.ai && analysis.bbox) {
    try {
      const wheelBoxes = filterBoxesOnCar(
        (await detectWheels(inputBytes, CACHE_DIR, cfg.AI, cli.useCache)).filter(
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
    } catch (err) {
      console.warn(
        `  ⚠ ${file}: wieldetectie overgeslagen: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  let outJpeg: Buffer | null = null;
  let plateStatus: PlateStatus = plateEnabled ? "none" : "off";
  let genbgApplied = false;
  if (analysis.bbox && placement) {
    const { image: mathComposite, carLayer } = await compositeImage(
      {
        rgba: data, width, height, bbox: analysis.bbox, placement, backgroundPath,
        contactShadows: buildContactShadows(
          shadowClusters, analysis.bbox, placement, cfg,
        ),
        profile,
        contactY,
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
        const fillInput = await sharp(mathComposite)
          .resize(fw, fh, { fit: "fill" })
          .png()
          .toBuffer();
        const fillMaskSmall = await sharp(fillMask)
          .resize(fw, fh, { fit: "fill" })
          .threshold(128)
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
          const scene = await fillScene(
            fillInput, fillMaskSmall, cfg.GENBG.prompt, cfg.GENBG.modelId,
            CACHE_DIR, cli.useCache, cfg.GENBG.seed + attempt,
          );
          const sceneFull = await sharp(scene)
            .resize(cfg.CANVAS.width, cfg.CANVAS.height, { fit: "fill" })
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
          const candidate = await sharp(sceneFull)
            .composite([{ input: borderPatch }, carLayer])
            .png()
            .toBuffer();
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
            x: placement.x, y: contactY,
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
        if (!genbgApplied) {
          warnings.push({
            code: "GENBG_REJECTED",
            message: `alle ${cfg.GENBG.maxAttempts} scène-pogingen afgekeurd — mathematisch composiet gebruikt`,
          });
        }
      } catch (err) {
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
    outJpeg = await sharp(branded)
      .jpeg({ quality: cfg.JPEG_QUALITY })
      .toBuffer();
    const outName = path.parse(file).name + ".jpg";
    await writeFile(path.join(OUT_DIR, outName), outJpeg);
  }

  // AI-kwaliteitscontrole: masker compleet? auto op de grond?
  if (cfg.AI.enabled && cli.ai && analysis.bbox) {
    const flatCutout = await sharp(cutout)
      .flatten({ background: "#808080" })
      .jpeg({ quality: 85 })
      .toBuffer();
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
        genbg: genbgApplied,
        contactY,
        widthRatio: Number(widthRatio.toFixed(4)),
        preset: cli.preset ?? null,
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
  console.log(`FLUX Fill:   ${aiStats.fillCalls} calls, ${aiStats.fillCacheHits} cache-hits (scène)`);
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

  const runCost =
    maskStats.apiCalls * cfg.COST_PER_CALL_USD +
    maskStats.detectCalls * cfg.AI.costPerDetection +
    aiStats.detectCalls * cfg.AI.costPerDetection +
    aiStats.vlmCalls * cfg.AI.costPerQuery +
    aiStats.segmentCalls * cfg.AI.costPerSegment +
    aiStats.fillCalls * cfg.GENBG.costPerCall +
    aiStats.ocrCalls * cfg.AI.costPerDetection;
  const perImage =
    cfg.COST_PER_CALL_USD +
    (cfg.DETECT.enabled ? cfg.AI.costPerDetection : 0) +
    (cfg.AI.enabled ? 2 * cfg.AI.costPerDetection + 2 * cfg.AI.costPerQuery : 0) +
    (cfg.WINDOWS.enabled ? cfg.AI.costPerDetection + cfg.AI.costPerSegment : 0) +
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
  const run: RunContext = { heroPending: true };
  for (const file of files) {
    process.stdout.write(`→ ${file}\n`);
    try {
      results.push(await processImage(file, backgroundPath, cfg, cli, run));
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
