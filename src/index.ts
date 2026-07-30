import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { defaultConfig, type Config } from "./config.js";
import { geminiStats, generateNovelView, type ImagePart } from "./gemini.js";
import {
  checkProportions,
  compareAgainstSources,
  identifyVehicle,
  paintCorrectionGains,
  paintDeviation,
} from "./identify.js";
import { getCutout, maskStats, noteFalFailure } from "./mask.js";
import { cutoutMeans, medianMeans, type ChannelMeans } from "./measure.js";
import { mountPlate } from "./plate.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const CACHE_DIR = "./cache";

interface CliOptions {
  /** Auto-map (onder in/) waarvoor de thumbnail wordt gesynthetiseerd. */
  synth?: string;
  /** Bestaande thumbnail van deze map alsnog van de Carredo-plaat voorzien. */
  mountPlate?: string;
  useCache: boolean;
}

function parseCli(): { cfg: Config; cli: CliOptions } {
  const { values } = parseArgs({
    options: {
      synth: { type: "string" },
      "mount-plate": { type: "string" },
      matte: { type: "string" },
      "rembg-model": { type: "string" },
      "no-cache": { type: "boolean", default: false },
    },
  });
  const cfg: Config = structuredClone(defaultConfig);
  if (values.matte !== undefined) {
    if (!["fal-birefnet", "fal-rmbg", "rembg"].includes(values.matte)) {
      throw new Error("--matte moet fal-birefnet, fal-rmbg of rembg zijn");
    }
    cfg.MATTE.provider = values.matte as Config["MATTE"]["provider"];
  }
  if (values["rembg-model"] !== undefined) {
    cfg.MATTE.rembgModel = values["rembg-model"];
  }
  return {
    cfg,
    cli: {
      synth: values.synth,
      mountPlate: values["mount-plate"],
      useCache: !values["no-cache"],
    },
  };
}

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

function synthPrompt(spec: string, feedback: string[], hasAnchor: boolean): string {
  let p = `Create a professional catalogue photo of this exact vehicle: ${spec}.\n`;
  if (hasAnchor) {
    p +=
      "The FIRST image is a COMPOSITION ANCHOR showing a DIFFERENT " +
      "vehicle. Match it EXACTLY on: camera angle and height, vehicle " +
      "position in the frame, background, lighting, floor shadow and " +
      "reflection. The anchor does NOT dictate the vehicle's size or " +
      "shape: the vehicle keeps its OWN real length, height and " +
      "proportions from the source photos — a longer vehicle simply takes " +
      "more room in the frame. NEVER compress, shorten or squash the body " +
      "to fit the anchor's footprint. Take ZERO vehicle design details " +
      "from the anchor — no body parts, no wheels, no badges.\n" +
      "All OTHER images are source photos of the vehicle to reconstruct; ";
  } else {
    p += "The attached photos are source photos of the vehicle to reconstruct; ";
  }
  p +=
    "they are the ONLY truth for its design: body, paint colour, wheels, " +
    "badges, lights, grille, trim, mirrors and glass. Do not restyle, " +
    "modernise or invent anything, and KEEP THE REAL PROPORTIONS — " +
    "wheelbase, body length, height and wheel size exactly as in the " +
    "source photos, never stretched or compressed.\n" +
    "ANGLE: three-quarter FRONT view with the front of the car on the " +
    "RIGHT of the frame, roughly 30-35 degrees off axis, camera height " +
    "1.0-1.3 m.\n" +
    "BACKGROUND: a seamless light grey photo studio (wall around #f0f2f4 " +
    "fading into a slightly darker smooth floor), a soft contact shadow " +
    "under the tyres and a subtle floor reflection. Neutral studio " +
    "reflections in the paint — no trees, no buildings.\n" +
    "The car fills about three quarters of the frame width, horizontally " +
    "centred, whole car in frame with clear margin on every side. No " +
    "people, no text, no watermark, no props.\n" +
    "LICENCE PLATE: an empty blank pale-grey front plate in correct " +
    "European proportions — a WIDE SHORT rectangle, about 4.5 times wider " +
    "than tall, mounted flat where this car model carries its front plate. " +
    "No characters, no frame taller than the plate itself.";
  if (feedback.length > 0) {
    p +=
      "\nA previous attempt was rejected by inspection for these " +
      "deviations — correct every one of them:\n" +
      feedback.map((f) => `- ${f}`).join("\n");
  }
  return p;
}

/**
 * De canonieke catalogushoek genereren uit de foto's die er wél zijn.
 *
 * Volledige generatie, dus vierdubbel bewaakt: een harde dimensiepoort
 * (3:2-raster), een identiteitsinspectie tegen de bronfoto's, een
 * deterministische lakmeting (met correctie naar de bron-mediaan wanneer
 * alleen de meting afwijkt) en een gerichte proportie-poort. Afwijkingen
 * gaan als feedback de volgende poging in; zonder overtuigende kandidaat
 * wordt er niets geschreven.
 */
async function synthesizeAngle(
  dir: string,
  cfg: Config,
  cli: CliOptions,
): Promise<Buffer> {
  const entries = await readdir(path.join(IN_DIR, dir), { withFileTypes: true });
  const refFiles = entries
    .filter((e) => e.isFile() && /\.(jpe?g|png)$/i.test(e.name))
    .map((e) => path.join(dir, e.name))
    .sort();
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

  // compositie-anker vooraan in de invoer; de bronfoto's volgen erna. De
  // inspecties vergelijken uitsluitend tegen de bronfoto's, dus het anker
  // kan daar geen identiteit in lekken.
  let genRefs = refs;
  let hasAnchor = false;
  if (existsSync(cfg.SYNTH.anchorPath)) {
    genRefs = [{ data: await readFile(cfg.SYNTH.anchorPath) }, ...refs];
    hasAnchor = true;
  } else {
    console.warn(
      `  ⚠ compositie-anker ontbreekt (${cfg.SYNTH.anchorPath}) — kadrering kan per auto verschillen`,
    );
  }

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
  for (let attempt = 0; attempt < cfg.SYNTH.maxAttempts; attempt++) {
    let img = await generateNovelView(
      genRefs, synthPrompt(spec, feedback, hasAnchor), cfg.GEMINI, CACHE_DIR,
      cli.useCache, cfg.SYNTH.seed + attempt,
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
    // aparte proportie-poort: in de brede inspectie verdronk deze vraag en
    // kwam een samengedrukte Cross Turismo erdoorheen
    const prop = await checkProportions(
      { data: img }, refs, spec, cfg.GEMINI, CACHE_DIR, cli.useCache,
    );
    // deterministische lakmeting naast de VLM-inspectie: zilver dat wit
    // rendert kwam door de inspectie heen, maar niet door de meting
    let paintIssue: string | null = null;
    if (srcMedian) {
      const candPath = path.join(CACHE_DIR, `synth-candidate-${cfg.SYNTH.seed + attempt}.jpg`);
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
          CACHE_DIR, `synth-corrected-${cfg.SYNTH.seed + attempt}.jpg`,
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
      ...(prop.distorted
        ? [`body proportions are wrong: ${prop.why || "stretched or compressed versus the sources"}`]
        : []),
    ];
    const acceptable =
      verdict.sameVehicle && verdict.paintMatch && paintIssue === null && !prop.distorted;
    if (acceptable && (best === null || verdict.issues.length < best.issues.length)) {
      best = { img, issues: verdict.issues };
    }
    if (acceptable && verdict.issues.length === 0) break;
    console.warn(
      `  ⚠ synth-poging ${attempt + 1} ` +
        (verdict.sameVehicle
          ? acceptable
            ? "met afwijkingen"
            : prop.distorted
              ? "afgekeurd (proporties)"
              : "afgekeurd (lak)"
          : "afgekeurd (andere auto)") +
        `: ${allIssues.join("; ") || "(geen detail opgegeven)"}`,
    );
    if (allIssues.length > 0) feedback = allIssues;
  }
  if (!best) {
    throw new Error(
      `synthese na ${cfg.SYNTH.maxAttempts} pogingen afgekeurd — geen enkele ` +
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
  for (const dir of [IN_DIR, OUT_DIR, CACHE_DIR]) {
    await mkdir(dir, { recursive: true });
  }

  // bestaande thumbnail alsnog van de plaat voorzien — de expliciete route
  // voor beelden die vóór de plaatmontage zijn goedgekeurd. Deterministisch:
  // er wordt niets hergenereerd, en de plaatloze versie blijft in
  // cache/accepted-synth-<map>.jpg staan.
  if (cli.mountPlate) {
    const thumb = path.join(OUT_DIR, cli.mountPlate, "thumbnail.jpg");
    if (!existsSync(thumb)) {
      throw new Error(`geen thumbnail gevonden: ${thumb}`);
    }
    const result = await mountPlate(await readFile(thumb), cfg.PLATE, CACHE_DIR, cli.useCache);
    if (!result.mounted) {
      throw new Error(`plaat niet gemonteerd: ${result.reason} — thumbnail onaangeroerd`);
    }
    await writeFile(thumb, result.image);
    console.log(`plaat gemonteerd: ${thumb}`);
    return;
  }

  if (!cli.synth) {
    const dirs = (await readdir(IN_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    console.log(
      "gebruik: pnpm start --synth <map>\n\n" +
        "beschikbare auto-mappen in ./in/:\n" +
        (dirs.length > 0 ? dirs.map((d) => `  - ${d}`).join("\n") : "  (geen)"),
    );
    return;
  }

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

  console.log(`→ ${cli.synth}`);
  let accepted = await synthesizeAngle(cli.synth, cfg, cli);

  // de Carredo-plaat deterministisch op de gegenereerde houder warpen —
  // leesbare tekst komt nooit uit het model. Faalt de montage, dan wordt de
  // plaatloze thumbnail gewoon gepubliceerd, met een luide melding.
  const mount = await mountPlate(accepted, cfg.PLATE, CACHE_DIR, cli.useCache);
  if (mount.mounted) {
    accepted = mount.image;
  } else {
    console.warn(`  ⚠ plaat niet gemonteerd: ${mount.reason} — thumbnail zonder plaat`);
  }

  // het goedgekeurde studiobeeld ÍS het eindresultaat (besluit 2026-07-30):
  // geen hercompositing, plaathouder blijft zoals gegenereerd. Publiceren =
  // wegschrijven, en out/<map>/ houdt exact één bestand over.
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile()) await rm(path.join(outDir, entry.name), { force: true });
  }
  await writeFile(thumbPath, accepted);
  console.log(`\nthumbnail: ${thumbPath} — enige beeld in ${outDir}/`);
  console.log(
    `Gemini: ${geminiStats.calls} calls, ${geminiStats.cacheHits} cache-hits · ` +
      `matte: ${maskStats.apiCalls} calls, ${maskStats.cacheHits} cache-hits`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
