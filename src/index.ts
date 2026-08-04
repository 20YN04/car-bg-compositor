import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { defaultConfig, type Config } from "./config.js";
import { geminiStats, generateNovelView, type ImagePart } from "./gemini.js";
import {
  checkBadgeCensus,
  checkBadgesVoted,
  checkPlate,
  checkProportions,
  checkQuality,
  compareAgainstSources,
  identifyVehicle,
  paintCorrectionGains,
  paintDeviation,
} from "./identify.js";
import { getCutout, maskStats, noteFalFailure } from "./mask.js";
import { cutoutMeans, detailStrength, medianMeans, type ChannelMeans } from "./measure.js";
import { carBox, measureFill, normalizeScale, replaceBackground } from "./background.js";
import { checkGeometry, wheelbaseRatio } from "./geometry.js";
import { florenceBoxes, mountPlate, tightPlateBox } from "./plate.js";

const IN_DIR = "./in";
const OUT_DIR = "./out";
const CACHE_DIR = "./cache";

interface CliOptions {
  /** Auto-map (onder in/) waarvoor de thumbnail wordt gesynthetiseerd. */
  synth?: string;
  /** Bestaande thumbnail van deze map alsnog van de Carredo-plaat voorzien. */
  mountPlate?: string;
  /**
   * Laat het model een blanco plaathouder tekenen en plak de Carredo-plaat
   * er daarna deterministisch op. Tekst en logo's zijn de zwakste
   * vaardigheid van een beeldmodel: het verprutste de plaat geregeld
   * (verkeerde kleuren, ontbrekend vleugellogo, te klein) en dat kostte
   * telkens een volledige poging. Een blanco rechthoek tekenen lukt wel, en
   * de echte plaat komt uit het asset — altijd correct.
   */
  plateAfter: boolean;
  /**
   * Wielbasis gedeeld door wieldiameter, uit de fabrieksspecs. Vult het
   * cijfer in dat de pipeline normaal uit een zuiver zijaanzicht meet. Zonder
   * zo'n foto ligt de wielbasis-poort stil en blijft alleen een VLM-oordeel
   * over ("lijkt een compacte auto"), wat geen bruikbare feedback oplevert.
   * Met dit getal wordt het een meting met een cijfer erbij, en dus feedback
   * waar de volgende poging iets mee kan.
   */
  wheelbaseRatio?: number;
  /**
   * Voertuigspec uit contract of database — overschrijft de AI-identificatie.
   * Uitvoeringen die alleen op badgeniveau verschillen (eDrive40 met
   * M-pakket versus M60) zijn uit foto's niet betrouwbaar te raden, en dan
   * gokt de identificatie. Wie de auto kent, wint.
   */
  vehicle?: string;
  useCache: boolean;
}

function parseCli(): { cfg: Config; cli: CliOptions } {
  const { values } = parseArgs({
    options: {
      synth: { type: "string" },
      vehicle: { type: "string" },
      "wheelbase-ratio": { type: "string" },
      "plate-after": { type: "boolean", default: false },
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
      vehicle: typeof values.vehicle === "string" && values.vehicle.trim()
        ? values.vehicle.trim()
        : undefined,
      wheelbaseRatio: values["wheelbase-ratio"] !== undefined
        ? Number(values["wheelbase-ratio"])
        : undefined,
      plateAfter: values["plate-after"] === true,
      mountPlate: values["mount-plate"],
      useCache: !values["no-cache"],
    },
  };
}

/**
 * Gemiddelde kleur van de studio-achtergrond: bovenste strook plus de
 * bovenhelften van de zijranden (de vloer is by design donkerder en blijft
 * buiten de meting). Gemeten op een verkleind beeld — de achtergrond is een
 * egaal verloop, dus 64px breed volstaat.
 */
async function backgroundMeans(img: Buffer): Promise<ChannelMeans> {
  const { data, info } = await sharp(img)
    .resize(64, 43, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0, n = 0;
  const px = (x: number, y: number) => {
    const p = (y * info.width + x) * 3;
    r += data[p] ?? 0;
    g += data[p + 1] ?? 0;
    b += data[p + 2] ?? 0;
    n++;
  };
  for (let y = 0; y < 7; y++) for (let x = 0; x < info.width; x++) px(x, y);
  for (let y = 7; y < 24; y++) {
    for (let x = 0; x < 5; x++) px(x, y);
    for (let x = info.width - 5; x < info.width; x++) px(x, y);
  }
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * Deterministische decor-poort: de studio van de kandidaat moet die van het
 * anker zijn. De bronfoto's zijn zelf professionele studiobeelden met een
 * eigen (donkerder/warmer) decor, en met tien van die referenties overstemde
 * dat het anker — de ID.3 kwam in de bron-studio terug, de e-tron met een
 * beige zweem. Meten in plaats van hopen.
 */
function backgroundDeviation(cand: ChannelMeans, anchor: ChannelMeans): string | null {
  const luma = (m: ChannelMeans) => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
  const ratio = luma(cand) / Math.max(1e-6, luma(anchor));
  const dRG = Math.abs(cand.r / cand.g - anchor.r / anchor.g);
  const dBG = Math.abs(cand.b / cand.g - anchor.b / anchor.g);
  const parts: string[] = [];
  if (ratio < 0.94 || ratio > 1.06) {
    parts.push(
      `the studio background is ${ratio > 1 ? "lighter" : "darker"} than the anchor ` +
        `(luminance x${ratio.toFixed(2)}) — render the SAME light grey studio as the ` +
        "anchor image, never the background of the source photos. The VEHICLE still " +
        "comes from the source photos only — never show the anchor's vehicle",
    );
  }
  // streng (2026-07-30, besluit Yentl: elk beeld exact de EQE-belichting):
  // de poort meet ná de deterministische normalisatie, dus binnen de
  // gain-cap hoort het residu vrijwel nul te zijn — wat overblijft is een
  // structureel ander decor en hoort afgekeurd
  if (dRG > 0.03 || dBG > 0.03) {
    parts.push(
      `the studio background has a colour cast the anchor does not have ` +
        `(Δr/g ${dRG.toFixed(3)}, Δb/g ${dBG.toFixed(3)}) — the studio must be neutral ` +
        "light grey like the anchor. The VEHICLE still comes from the source photos " +
        "only — never show the anchor's vehicle",
    );
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Per-kanaal gains alléén op de autopixels toepassen, via de matte met een
 * zachte rand. De lakcorrectie mag de achtergrond niet meer raken: die is
 * zonet al exact op het anker genormaliseerd, en een globale gain zou hem
 * weer wegtrekken.
 */
async function applyMaskedGains(
  img: Buffer,
  cutout: Buffer,
  gains: [number, number, number],
  excludeBox: { x: number; y: number; w: number; h: number } | null = null,
): Promise<Buffer> {
  const meta = await sharp(img).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  // het masker moet als écht alfakanaal aangehecht worden: een greyscale-PNG
  // zonder alfa wordt door dest-in als volledig dekkend gelezen en dan zijn
  // de "gemaskeerde" gains stiekem globaal (gemeten op de eerste batch: de
  // achtergrond schoof exact mee met de lak-gains)
  const maskRaw = await sharp(cutout)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(3)
    .blur(1)
    .raw()
    .toBuffer();
  if (excludeBox) {
    // plaatzone uit het gain-masker — exact op plaatmaat (2% marge): een
    // ruimere zone liet een rechthoek ongecorrigeerde lak rond de plaat staan
    const x0 = Math.max(0, Math.round(excludeBox.x - excludeBox.w * 0.02));
    const x1 = Math.min(width - 1, Math.round(excludeBox.x + excludeBox.w * 1.02));
    const y0 = Math.max(0, Math.round(excludeBox.y - excludeBox.h * 0.02));
    const y1 = Math.min(height - 1, Math.round(excludeBox.y + excludeBox.h * 1.02));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) maskRaw[y * width + x] = 0;
    }
  }
  // let op: geen removeAlpha in deze pipeline — sharp voert operaties in
  // vaste interne volgorde uit en stript dan het zojuist aangehechte
  // alfakanaal weer (gemeten: 3 kanalen uit, masker genegeerd)
  const maskedCar = await sharp(img)
    .linear(gains, [0, 0, 0])
    .joinChannel(maskRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return sharp(img)
    .composite([{ input: maskedCar }])
    .jpeg({ quality: 97 })
    .toBuffer();
}

/**
 * Achtergrond-gains die de auto nooit raken. De normalisatie naar de
 * anker-belichting is een decor-ingreep, maar als globale gain kleurde hij
 * ook de ramen en de nummerplaat mee (tot ×1.4 bij bronsets uit een donkere
 * studio — dáár kwam de "verkleurde ruiten"-klacht vandaan). De originele
 * autopixels gaan er via de matte exact overheen terug.
 */
async function applyBackgroundGains(
  img: Buffer,
  cutout: Buffer,
  gains: [number, number, number],
): Promise<Buffer> {
  const meta = await sharp(img).metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const maskRaw = await sharp(cutout)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .extractChannel(3)
    .blur(1)
    .raw()
    .toBuffer();
  const carLayer = await sharp(img)
    .joinChannel(maskRaw, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  return sharp(img)
    .linear(gains, [0, 0, 0])
    .composite([{ input: carLayer }])
    .jpeg({ quality: 97 })
    .toBuffer();
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

/**
 * Doelvulling van het kader op basis van de echte wagenlengte: het anker
 * (EQE, 4.95 m) staat op 75% breedte, en elke auto schaalt daar reëel
 * tegenover — een 500e (3.6 m) hoort dus rond 55%, anders leest een kleine
 * stadsauto als een reuzenwagen.
 */
function targetFrameFill(lengthM: number): number {
  // het anker (EQE, 4.95 m) vult gemeten 88.4% van het kader
  return Math.min(0.88, Math.max(0.45, 0.884 * (lengthM / 4.95)));
}

/**
 * De auto zelf, uitgesneden en uitvergroot uit de bronfoto's.
 *
 * Dezelfde ingreep als de velg-close-up, maar dan voor de koets. Een
 * telefoonfoto is staand met veel omgeving eromheen; de auto beslaat er soms
 * maar een derde van. Het model leest de verhoudingen dan slecht af en valt
 * terug op zijn standaardbeeld — bij de BMW i5 Touring leverde dat elf keer
 * op rij een compacte X1 op, ook met de afmetingen letterlijk in de spec
 * (2026-08-03). Tekst wint het niet van wat het model ziet; uitvergroten wel.
 * We kiezen de foto waarop de auto het breedst in beeld staat, want daar is
 * de lengte het best af te lezen.
 */
async function bodyCloseUp(
  refFiles: string[],
  cfg: Config,
  useCache: boolean,
): Promise<ImagePart | null> {
  let best: { part: ImagePart; width: number; note: string } | null = null;
  for (const f of refFiles) {
    try {
      const file = path.join(IN_DIR, f);
      const cutout = await getCutout(file, CACHE_DIR, cfg.FAL, cfg.MATTE, useCache);
      const box = await carBox(cutout);
      if (!box) continue;
      const src = await readFile(file);
      const meta = await sharp(src).metadata();
      const w = meta.width ?? 0, h = meta.height ?? 0;
      if (!w || !h || box.width < w * 0.25) continue;
      // De auto moet er HELEMAAL op staan. Zonder deze eis wint de foto
      // waarop hij het breedst is — en dat is juist de opname waarop hij is
      // aangesneden, want dan raakt de omtrek beide beeldranden. Als
      // referentie voor verhoudingen is een afgesneden auto waardeloos
      // (gemeten op de EQE AMG, 2026-08-03: gekozen foto besloeg "100% van
      // de breedte", oftewel links en rechts eraf).
      const marge = Math.max(4, Math.round(w * 0.01));
      const volledig =
        box.left > marge && box.left + box.width < w - marge &&
        box.top > marge && box.top + box.height < h - marge;
      if (!volledig) continue;
      if (best && box.width <= best.width) continue;
      const pad = Math.round(box.width * 0.04);
      const left = Math.max(0, box.left - pad);
      const top = Math.max(0, box.top - pad);
      const width = Math.min(w - left, box.width + pad * 2);
      const height = Math.min(h - top, box.height + pad * 2);
      best = {
        width: box.width,
        note: `${f}, ${width}x${height}px (auto besloeg ${Math.round((box.width / w) * 100)}% van de breedte)`,
        part: {
          data: await sharp(src)
            .extract({ left, top, width, height })
            .resize({ width: 1600, withoutEnlargement: false })
            .jpeg({ quality: 95 })
            .toBuffer(),
        },
      };
    } catch (err) {
      noteFalFailure(err);
    }
  }
  if (best) console.log(`  koetsreferentie: ${best.note}`);
  else console.log("  ⚠ geen foto met de auto volledig in beeld — geen koetsreferentie");
  return best?.part ?? null;
}

/**
 * Uitvergrote close-up van het beste wiel uit de bronfoto's, als extra
 * referentie voor de generatie. Het model kopieert een velg niet, het verzint
 * er een plausibele bij; in een volledige foto is de velg te klein om af te
 * lezen. Score = oppervlak x rondheid, want een wiel recht van opzij toont
 * het spaakpatroon en een schuin wiel is een ellips waarin niets te zien is.
 * Overgenomen uit car-multiview (2026-08-03), waar dit het velgprobleem
 * oploste dat zes pogingen op rij kostte.
 */
async function wheelCloseUp(
  refs: ImagePart[],
  cfg: Config,
  useCache: boolean,
): Promise<ImagePart | null> {
  let best: { part: ImagePart; score: number; note: string } | null = null;
  for (const [i, ref] of refs.entries()) {
    try {
      const boxes = await florenceBoxes(
        ref.data, "wheel", "wheelref", cfg.PLATE.detectionModelId, CACHE_DIR, useCache,
      );
      const meta0 = await sharp(ref.data).metadata();
      const iw = meta0.width ?? 0, ih = meta0.height ?? 0;
      for (const box of boxes) {
        if (box.w < 120 || box.h < 120) continue;
        // Een wiel is klein. Zonder bovengrens wint een detectie die het hele
        // beeld beslaat — op de EQE koos hij een kader van 1200x1600, dus de
        // volledige foto (2026-08-03). Een wiel haalt in een autofoto zelden
        // meer dan een derde van de beeldbreedte.
        if (!iw || !ih) continue;
        if (box.w > iw * 0.4 || box.h > ih * 0.4) continue;
        const roundness = 1 - Math.abs(1 - box.w / Math.max(1, box.h));
        if (roundness < 0.75) continue;
        const score = box.w * box.h * roundness;
        if (best && score <= best.score) continue;
        const meta = await sharp(ref.data).metadata();
        const w = meta.width ?? 0, h = meta.height ?? 0;
        if (!w || !h) continue;
        const pad = box.w * 0.12;
        const left = Math.max(0, Math.round(box.x - pad));
        const top = Math.max(0, Math.round(box.y - pad));
        const width = Math.min(w - left, Math.round(box.w + pad * 2));
        const height = Math.min(h - top, Math.round(box.h + pad * 2));
        if (width < 120 || height < 120) continue;
        best = {
          score,
          note: `foto ${i + 1}, ${width}x${height}px, rondheid ${roundness.toFixed(2)}`,
          part: {
            data: await sharp(ref.data)
              .extract({ left, top, width, height })
              .resize({ width: 1100, withoutEnlargement: false })
              .jpeg({ quality: 95 })
              .toBuffer(),
          },
        };
      }
    } catch {
      // detectie mislukt op dit beeld: volgende proberen
    }
  }
  if (best) console.log(`  velgreferentie: ${best.note}`);
  return best?.part ?? null;
}

/** Sterkte van de kleurzweem over een heel beeld: 0 is neutraal. */
async function sceneCast(filePath: string): Promise<number> {
  const stats = await sharp(filePath).stats();
  const r = stats.channels[0]?.mean ?? 128;
  const g = stats.channels[1]?.mean ?? 128;
  const b = stats.channels[2]?.mean ?? 128;
  const luma = (r + g + b) / 3;
  return Math.max(
    Math.abs(r / luma - 1),
    Math.abs(g / luma - 1),
    Math.abs(b / luma - 1),
  );
}

function synthPrompt(
  spec: string,
  feedback: string[],
  hasAnchor: boolean,
  hasPlate: boolean,
  hasWheelRef: boolean,
  hasBodyRef: boolean,
  fillPct: number,
  heeftVorige = false,
): string {
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
      "from the anchor — no body parts, no wheels, no badges. If your " +
      "output shows the anchor's vehicle (or a blend of it) instead of the " +
      "source vehicle, the image is invalid.\n" +
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
    // Badges komen van de FOTO'S, nooit uit de modelnaam: in car-multiview
    // plakte het model een 4MATIC-badge en een tweede EQE-badge op de AMG
    // omdat de spec die naam noemde (2026-08-04).
    "BADGES AND LETTERING: reproduce ONLY the badges that are visible in " +
    "the source photos, each in its exact location — nothing more. NEVER " +
    "add a badge or lettering because the model name or trim level implies " +
    "it, and NEVER repeat a badge on additional panels: a badge the photos " +
    "show once appears once. When a badge is clearly PRESENT in the photos " +
    "but its lettering is too small to read, render exactly the badge the " +
    "factory places at that position on this model and trim — never " +
    "invented text.\n" +
    "ANGLE: three-quarter FRONT view with the front of the car on the " +
    "RIGHT of the frame, roughly 30-35 degrees off axis, camera height " +
    "1.0-1.3 m.\n" +
    "BACKGROUND: a seamless light grey photo studio (wall around #f0f2f4 " +
    "fading into a slightly darker smooth floor), a soft contact shadow " +
    "under the tyres and a subtle floor reflection. Neutral studio " +
    "reflections in the paint — no trees, no buildings. NEVER copy the " +
    "background, floor, lighting mood or any watermark from the source " +
    "photos — the studio comes ONLY from the anchor. Render no watermark, " +
    "no logo overlay and no floating text anywhere in the image.\n" +
    `The car fills about ${Math.round(fillPct * 100)}% of the frame width — ` +
    "this follows from its REAL size: a small city car occupies clearly " +
    "less of the frame than a large sedan in the same studio; never blow a " +
    "small car up to fill the frame. Horizontally centred, whole car in " +
    "frame with clear margin on every side. No people, no watermark, no " +
    "props.\n" +
    "QUALITY: tack-sharp professional studio photography, regardless of " +
    "the source photo quality — reconstruct crisp panel lines, badges and " +
    "reflections cleanly; never reproduce blur, noise, compression " +
    "artifacts or watermarks from the source photos.\n" +
    (hasBodyRef
      ? "PROPORTIONS: one of the attached images is the same car CROPPED " +
        "TIGHT, so its body fills the frame. Read the proportions from that " +
        "image: the length of the bonnet, the length of the wheelbase, how " +
        "low the roof sits relative to the body, and the overhangs. Those " +
        "proportions are binding — never render a shorter, taller or more " +
        "compact car than the one in that crop.\n"
      : "") +
    (hasWheelRef
      ? "WHEELS: one of the attached images is a CLOSE-UP of this car's " +
        "actual wheel. Copy that wheel exactly: the number of spokes, their " +
        "shape and thickness, which parts are dark and which are bright " +
        "machined metal, and the centre cap. Do not substitute a different " +
        "alloy design, however plausible it looks.\n"
      : "") +
    (hasPlate
      ? "LICENCE PLATE: the LAST attached image is the exact Carredo " +
        "dealer plate (white plate, blue Carredo wordmark, holder with a " +
        "green-to-blue leasing strip at the bottom). It is a DEALER plate, " +
        "not a registration plate: it has NO blue EU band on the left, NO " +
        "circle of stars, NO country letter and NO registration characters. " +
        "Never add one. Mount THIS plate on " +
        "the front of the car, in the car's own plate position, at " +
        "REALISTIC size — a standard European front plate, about 52 cm " +
        "wide on the real car — angled with the bumper perspective. " +
        "Reproduce the logo, wordmark and strip EXACTLY as in the " +
        "reference; never stretch, squash or enlarge the plate beyond " +
        "its natural size."
      : "LICENCE PLATE: an empty blank pale-grey front plate in correct " +
        "European proportions — a WIDE SHORT rectangle, about 4.5 times " +
        "wider than tall. No characters.");
  if (feedback.length > 0 && heeftVorige) {
    p +=
      "\nThe LAST attached image is your own PREVIOUS ATTEMPT. It was " +
      "already right in most respects. Reproduce it as closely as you can — " +
      "the same car, the same camera angle, the same framing and size in " +
      "the frame, the same studio, the same lighting and shadow — and " +
      "change ONLY the points listed here. Do not restyle anything that is " +
      "not on this list:\n" +
      feedback.map((f) => `- ${f}`).join("\n");
  } else if (feedback.length > 0) {
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
): Promise<{
  img: Buffer;
  fillPct: number;
  srcMedian: ChannelMeans | null;
  tintReliable: boolean;
}> {
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
  // Spec-bestand per auto: in/<map>/vehicle.txt. Eén keer vastleggen wat de
  // uitvoering is en het staat er voorgoed — geen vlag meer typen, en geen
  // AI die badgeniveau-uitvoeringen zit te raden. Een optionele eerste regel
  // "wielbasis: 4.11" vult het cijfer voor de geometriepoort in, dat anders
  // uit een zuiver zijaanzicht gemeten moet worden.
  let bestandSpec: string | null = null;
  let bestandWielbasis: number | null = null;
  const specPad = path.join(IN_DIR, dir, "vehicle.txt");
  if (existsSync(specPad)) {
    const regels = (await readFile(specPad, "utf8")).split("\n");
    const rest: string[] = [];
    for (const r of regels) {
      const m = r.match(/^\s*wielbasis\s*:\s*([0-9.]+)\s*$/i);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) bestandWielbasis = n;
      } else {
        rest.push(r);
      }
    }
    const tekst = rest.join("\n").trim();
    if (tekst) bestandSpec = tekst;
  }

  const identity = await identifyVehicle(refs, cfg.GEMINI, CACHE_DIR, cli.useCache);
  const spec = cli.vehicle ?? bestandSpec ?? identity.spec;
  if (cli.vehicle) console.log(`  voertuig (vlag): ${spec.slice(0, 90)}…`);
  else if (bestandSpec) console.log(`  voertuig (${specPad}): ${spec.slice(0, 90)}…`);
  const fillPct = targetFrameFill(identity.lengthM);
  console.log(
    `  voertuig: ${spec}\n  lengte ~${identity.lengthM.toFixed(2)} m → kadervulling ~${Math.round(fillPct * 100)}%`,
  );

  // compositie-anker vooraan in de invoer, plaat-asset achteraan; de
  // bronfoto's zitten ertussen. De identiteitsinspecties vergelijken
  // uitsluitend tegen de bronfoto's, dus anker en plaat kunnen daar geen
  // identiteit in lekken.
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
  let plateAsset: ImagePart | null = null;
  if (cli.plateAfter) {
    console.log(
      "  plaat: door het model laten plaatsen, daarna deterministisch overschrijven",
    );
  }
  if (existsSync(cfg.PLATE.assetPath)) {
    plateAsset = { data: await readFile(cfg.PLATE.assetPath), mime: "image/png" };
    genRefs = [...genRefs, plateAsset];
  } else {
    console.warn(
      `  ⚠ plaat-asset ontbreekt (${cfg.PLATE.assetPath}) — auto krijgt een lege plaat`,
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
  // Kleurzweem van de bronset. Is die sterk — avondzon, kunstlicht, een
  // gekleurde muur — dan is de gemeten bronkleur vervuild en zegt een
  // tintvergelijking niets. We dwingen de tint dan niet af en corrigeren
  // alleen de lichtheid; de neutraal-daglicht-inspectie bewaakt de kleur.
  // Overgenomen uit car-multiview (2026-08-01), waar dit dezelfde BMW
  // redde: die foto's zijn in avondlicht genomen.
  let castSum = 0, castN = 0;
  for (const f of refFiles) {
    try {
      castSum += await sceneCast(path.join(IN_DIR, f));
      castN++;
    } catch {
      // onleesbaar beeld telt niet mee
    }
  }
  const tintReliable = castN === 0 ? true : castSum / castN <= 0.05;
  if (!tintReliable) {
    console.warn(
      `  ⚠ bronset heeft een sterke kleurcast (gem. ${(castSum / castN).toFixed(3)}) — ` +
        "tint wordt niet deterministisch afgedwongen, alleen lichtheid",
    );
  }
  // Detaildichtheid van de bronfoto's: de eerlijke maatstaf voor de scherpte
  // van de uitvoer, want het is dezelfde auto in dezelfde kleur. Het anker is
  // dat niet, en dat is precies waar de oude kwaliteitspoort op strandde.
  const srcDetails: number[] = [];
  for (const r of refs) srcDetails.push(await detailStrength(r.data));
  srcDetails.sort((a, b) => a - b);
  const srcDetail = srcDetails.length > 0
    ? srcDetails[Math.floor((srcDetails.length - 1) / 2)]!
    : null;
  if (srcDetail !== null) {
    console.log(`  detaildichtheid bronfoto's (mediaan): ${srcDetail.toFixed(1)}`);
  }
  const srcMedian = srcMeans.length > 0 ? medianMeans(srcMeans) : null;
  if (!srcMedian) {
    console.warn(
      "  ⚠ geen bron-lakmediaan meetbaar (matte faalde op alle bronfoto's) — " +
        "lakbewaking draait alleen op de VLM-inspectie",
    );
  }

  const bodyRef = await bodyCloseUp(refFiles, cfg, cli.useCache);
  if (bodyRef) genRefs = [...genRefs, bodyRef];
  const wheelRef = await wheelCloseUp(refs, cfg, cli.useCache);
  if (!wheelRef) {
    console.log("  ⚠ geen bruikbaar wiel in de bronfoto's — geen velgreferentie");
  } else {
    // vóór de plaat invoegen: die moet de laatste blijven, daar verwijst de
    // prompt naar
    const plateIdx = genRefs.findIndex((r) => r === plateAsset);
    genRefs = plateIdx >= 0
      ? [...genRefs.slice(0, plateIdx), wheelRef, genRefs[plateIdx]!]
      : [...genRefs, wheelRef];
  }
  const anchorBg = hasAnchor ? await backgroundMeans(genRefs[0]!.data) : null;

  // geometrie-referentie: het meest zijdelingse bronbeeld geeft de echte
  // wielbasis/wieldiameter-verhouding. Zonder betrouwbaar zijaanzicht
  // (ratio < 3.3) vervalt de geometriepoort, met melding.
  let sideRatio: number | null = null;
  for (const r of refs) {
    try {
      const wr = await wheelbaseRatio(r.data, cfg.PLATE.detectionModelId, CACHE_DIR, cli.useCache);
      if (wr !== null && (sideRatio === null || wr > sideRatio)) sideRatio = wr;
    } catch (err) {
      noteFalFailure(err);
    }
  }
  if (sideRatio !== null && sideRatio < 3.3) sideRatio = null;
  const opgegevenWielbasis = cli.wheelbaseRatio !== undefined && Number.isFinite(cli.wheelbaseRatio)
    ? cli.wheelbaseRatio
    : bestandWielbasis;
  // De vlag overschrijft altijd — dat is expliciete invoer. Het getal uit
  // vehicle.txt vult alleen aan: staat er een zuiver zijaanzicht in de set,
  // dan gaan kandidaat en bron langs dezelfde meetlat en valt de systematische
  // fout weg, terwijl een getypt getal zijn eigen afrondingsfout meebrengt.
  const uitVlag = cli.wheelbaseRatio !== undefined && Number.isFinite(cli.wheelbaseRatio);
  if (opgegevenWielbasis !== null && opgegevenWielbasis !== undefined &&
      (uitVlag || sideRatio === null)) {
    sideRatio = opgegevenWielbasis;
    console.log(
      `  wielbasis/wieldiameter uit specs: ${sideRatio.toFixed(2)} — ` +
        "geometriepoort actief zonder zijaanzicht in de bronset",
    );
  } else if (sideRatio !== null && opgegevenWielbasis !== null && opgegevenWielbasis !== undefined) {
    console.log(
      `  wielbasis gemeten op het zijaanzicht: ${sideRatio.toFixed(2)} ` +
        `(vehicle.txt zei ${opgegevenWielbasis.toFixed(2)}; de meting wint)`,
    );
  }
  if (sideRatio === null) {
    console.warn("  ⚠ geen betrouwbaar zijaanzicht in de bronset — geometriepoort inactief");
  }

  let best: { img: Buffer; issues: string[] } | null = null;
  let fallback: { img: Buffer; issues: string[] } | null = null;
  let kwaliteitAlleen = 0;
  let feedback: string[] = [];
  // De vorige poging als vertrekpunt. Bij een afkeuring is de rest van dat
  // beeld meestal wél goed — de auto, de hoek, het licht, het decor. Alles
  // weggooien betekent dat je al die geslaagde eigenschappen opnieuw moet
  // winnen, en dat is waarom elke poging op iets ánders faalde dan de
  // vorige (Yentl, 2026-08-03).
  let vorigeKandidaat: ImagePart | null = null;
  for (let attempt = 0; attempt < cfg.SYNTH.maxAttempts; attempt++) {
    const refsNu = vorigeKandidaat ? [...genRefs, vorigeKandidaat] : genRefs;
    let img = await generateNovelView(
      refsNu,
      synthPrompt(
        spec, feedback, hasAnchor, plateAsset !== null, wheelRef !== null,
        bodyRef !== null, fillPct, vorigeKandidaat !== null,
      ),
      cfg.GEMINI, CACHE_DIR, cli.useCache, cfg.SYNTH.seed + attempt,
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
    const candPath = path.join(CACHE_DIR, `synth-candidate-${cfg.SYNTH.seed + attempt}.jpg`);
    await writeFile(candPath, img);
    const candCutout = await getCutout(candPath, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);
    // belichting deterministisch naar het anker normaliseren — maar alléén
    // de achtergrond: als globale gain kleurde dit ook ramen en plaat mee.
    // De cap houdt een structureel ander decor (donkere bronstudio) buiten
    // bereik; dat vangt de poort hieronder.
    if (anchorBg) {
      const candBg = await backgroundMeans(img);
      const cap = 1.45;
      const g = ([candBg.r, candBg.g, candBg.b].map((v, i) =>
        Math.min(cap, Math.max(1 / cap, [anchorBg.r, anchorBg.g, anchorBg.b][i]! / Math.max(1e-6, v))),
      )) as [number, number, number];
      if (Math.max(...g.map((v) => Math.abs(v - 1))) > 0.015) {
        img = await applyBackgroundGains(img, candCutout, g);
      }
      const bgIssue = backgroundDeviation(await backgroundMeans(img), anchorBg);
      if (bgIssue) {
        console.warn(`  ⚠ synth-poging ${attempt + 1} verworpen (decor): ${bgIssue}`);
        feedback = [bgIssue];
        continue;
      }
    }
    // De vier poorten hieronder weten niets van elkaar en draaien daarom
    // tegelijk. Achter elkaar telden hun wachttijden op — gemeten kost één
    // oordeel 4 tot 7 s (2026-08-04). Nu duurt het geheel zo lang als de
    // traagste; de uitkomsten veranderen niet.
    //
    // - proporties: in de brede inspectie verdronk die vraag en kwam een
    //   samengedrukte Cross Turismo erdoorheen
    // - plaat: het model monteert de plaat zelf, dus er moet apart gecheckt
    //   worden dat logo en tekst kloppen en de plaat niet uitgerekt is.
    //   Wordt hij achteraf overschreven, dan hoeft hij nu niet te kloppen en
    //   kost een mislukte modelplaat geen poging.
    // - kwaliteit: slechte bronfoto's zijn nooit een excuus voor een zachte
    //   of plastic-achtige render
    let [verdict, prop, plate, qual, badgeVote, badgeCensus] = await Promise.all([
      compareAgainstSources(
        { data: img }, refs, spec, cfg.GEMINI, CACHE_DIR, cli.useCache,
      ),
      checkProportions(
        { data: img }, refs, spec, cfg.GEMINI, CACHE_DIR, cli.useCache,
      ),
      plateAsset && !cli.plateAfter
        ? checkPlate({ data: img }, plateAsset, cfg.GEMINI, CACHE_DIR, cli.useCache)
        : Promise.resolve({ plateOk: true, issues: [] as string[] }),
      hasAnchor
        ? checkQuality({ data: img }, genRefs[0]!, cfg.GEMINI, CACHE_DIR, cli.useCache)
        : Promise.resolve({ qualityOk: true, issues: [] as string[] }),
      // toegewijde badgepoort met twee stemmen: het badges_match-veld in de
      // brede inspectie flipte per poging op dit detail van twintig pixels
      checkBadgesVoted(
        { data: img }, refs,
        spec.split(/[—.]/)[0]?.trim().slice(0, 90) ?? spec.slice(0, 90),
        cfg.GEMINI, CACHE_DIR, cli.useCache,
      ),
      // badge-telling op uitvergrote crops, getoetst aan de beschrijving:
      // de enige schaal waarop een verdubbelde badge betrouwbaar telbaar is
      gridCrops(img, candCutout).then((crops) =>
        checkBadgeCensus(crops, spec, cfg.GEMINI, CACHE_DIR, cli.useCache),
      ),
    ]);
    // Scherpte wordt gemeten, niet beoordeeld: de detaildichtheid van de
    // uitvoer tegen die van de bronfoto's van dezelfde auto.
    if (srcDetail !== null && srcDetail > 0) {
      const ratio = (await detailStrength(img)) / srcDetail;
      if (ratio < cfg.SYNTH.minDetailRatio) {
        qual.qualityOk = false;
        qual.issues.push(
          `detaildichtheid ${(ratio * 100).toFixed(0)}% van de bronfoto's ` +
            `(ondergrens ${(cfg.SYNTH.minDetailRatio * 100).toFixed(0)}%) — ` +
            "de render is zichtbaar zachter dan de echte foto's",
        );
      } else {
        console.log(`  scherpte gemeten: ${(ratio * 100).toFixed(0)}% van de bronfoto's`);
      }
    }
    // deterministische geometrie-poorten vóór de (betaalde) inspecties: een
    // te klein gerenderde of samengedrukte koets is meetbaar — de VLM liet
    // op een ongelukkige worp een 74%-Tesla door waar 85% hoorde
    {
      const geomIssues: string[] = [];
      const fillNow = await measureFill(candCutout);
      if (fillNow < fillPct - 0.06) {
        geomIssues.push(
          `the car is rendered too small: it fills ${Math.round(fillNow * 100)}% of the ` +
            `frame width but must fill about ${Math.round(fillPct * 100)}% — render the ` +
            "car larger in the frame",
        );
      }
      try {
        const candRatio = await wheelbaseRatio(
          img, cfg.PLATE.detectionModelId, CACHE_DIR, cli.useCache,
        );
        const geom = checkGeometry(candRatio, sideRatio);
        if (!geom.ok && geom.issue) geomIssues.push(geom.issue);
      } catch (err) {
        noteFalFailure(err);
      }
      if (geomIssues.length > 0) {
        console.warn(
          `  ⚠ synth-poging ${attempt + 1} verworpen (geometrie): ${geomIssues.join("; ")}`,
        );
        feedback = geomIssues;
        continue;
      }
    }
    // deterministische lakmeting naast de VLM-inspectie: zilver dat wit
    // rendert kwam door de inspectie heen, maar niet door de meting
    let paintIssue: string | null = null;
    if (srcMedian) {
      const cand = await paintMeansOf(candPath, cfg, cli.useCache);
      paintIssue = paintDeviation(cand, srcMedian, cfg.SYNTH, tintReliable);
      // corrigeren i.p.v. afkeuren: een tintverschuiving is met per-kanaal
      // curves exact te repareren, ontbrekende metallic-flake of een andere
      // kleurfamilie niet. De correctie wordt altijd nagemeten. Vond de VLM
      // de lak óók fout, dan telt zijn oordeel over het óngecorrigeerde
      // beeld niet meer: de gecorrigeerde kandidaat gaat opnieuw door de
      // inspectie en moet daar alsnog schoon doorheen (de IONIQ-case:
      // Transmission Blue dreef alleen in tint, en dat is precies wat de
      // curves rechtzetten).
      if (
        paintIssue && verdict.sameVehicle &&
        verdict.issues.length === 0 && !prop.distorted
      ) {
        const gains = paintCorrectionGains(cand, srcMedian, 1.45, !tintReliable);
        // de plaat uit de correctie houden: zonder exclusie kreeg de witte
        // Carredo-plaat de donker-gains van de koets mee. Strak op
        // plaatmaat via het SAM2-vlak — een ruime box liet een rechthoek
        // ongecorrigeerde lak rond de plaat staan.
        let plateBox: { x: number; y: number; w: number; h: number } | null = null;
        try {
          plateBox = await tightPlateBox(img, cfg.PLATE, CACHE_DIR, cli.useCache);
        } catch {
          // zonder box corrigeert de gain ook de plaat — jammer maar geen blokkade
        }
        const corrected = await applyMaskedGains(img, candCutout, gains, plateBox);
        const corrPath = path.join(
          CACHE_DIR, `synth-corrected-${cfg.SYNTH.seed + attempt}.jpg`,
        );
        await writeFile(corrPath, corrected);
        const remeasured = await paintMeansOf(corrPath, cfg, cli.useCache);
        const residual = paintDeviation(remeasured, srcMedian, cfg.SYNTH, tintReliable);
        if (residual === null) {
          const approved = verdict.paintMatch
            ? true
            : await (async () => {
                const reVerdict = await compareAgainstSources(
                  { data: corrected }, refs, spec, cfg.GEMINI, CACHE_DIR, cli.useCache,
                );
                if (
                  reVerdict.sameVehicle && reVerdict.paintMatch &&
                  reVerdict.issues.length === 0
                ) {
                  verdict = reVerdict;
                  return true;
                }
                return false;
              })();
          if (approved) {
            img = corrected;
            paintIssue = null;
            console.log(
              `  lak deterministisch naar de bron-mediaan gecorrigeerd ` +
                `(gains ${gains.map((g) => g.toFixed(3)).join("/")})`,
            );
          }
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
      ...plate.issues.map((i) => `licence plate: ${i}`),
      ...qual.issues.map((i) => `image quality: ${i}`),
      ...badgeCensus.issues.map(
        (i) => `${i} — the description lists the car's badges exhaustively; ` +
          "render those and no others, never a second copy on a nearby panel",
      ),
      ...badgeVote.issues.map(
        (i) => `${i} — render ONLY the badges the source photos show; when a ` +
          "badge is present but unreadable, use the factory badge for this model",
      ),
      ...(verdict.badgesMatch ? [] : ["broad inspection doubts the badges — see other findings"]),
    ];
    // De kwaliteitspoort telt bewust NIET mee in `acceptable`. Die geeft
    // geregeld smaakoordelen ("iets minder scherp", "reflecties wat vlakker")
    // en die blokkeerden een kandidaat even hard als een verkeerde auto —
    // waarna de hoek helemaal niets opleverde. Een wat zachter beeld is beter
    // dan géén beeld, dus kwaliteit degradeert naar tweede keus. Overgenomen
    // uit car-multiview (2026-08-02).
    // badgesMatch hard erin: een verzonnen of verdubbelde badge is nooit een
    // kleine afwijking — via de terugvalroute belandde in car-multiview de
    // AMG mét 4MATIC-badge in de uitvoer (2026-08-04)
    // de stempoort beslist over badges (twee eensgezinde stemmen); het
    // brede badges_match-veld bleek wisselvallig en telt als zachte melding
    const acceptable =
      verdict.sameVehicle && verdict.paintMatch && badgeVote.badgesOk &&
      badgeCensus.badgesOk &&
      paintIssue === null && !prop.distorted && plate.plateOk;
    if (acceptable) {
      const cand = { img, issues: verdict.issues };
      if (qual.qualityOk) {
        if (best === null || verdict.issues.length < best.issues.length) best = cand;
      } else if (fallback === null || verdict.issues.length < fallback.issues.length) {
        fallback = {
          ...cand,
          issues: [...cand.issues, ...qual.issues.map((i) => `beeldkwaliteit: ${i}`)],
        };
      }
    }
    // Stoppen zodra het goed genoeg is. De lus brak alleen af bij een
    // volmaakt schone kandidaat, dus na een geaccepteerde poging 1 draaide
    // hij er nog vijf die niets beters opleverden — puur verlies (gemeten op
    // de BMW, 2026-08-03). Nu is een handvol kleine opmerkingen genoeg reden
    // om te publiceren; de harde poorten zijn dan toch al door.
    // De kwaliteitspoort blokkeert, maar de auto klopt. Die poort meet tegen
    // het anker en vindt een witte hatchback altijd minder rijk dan een zwarte
    // AMG; herhaalt hij zich, dan levert doorzoeken aantoonbaar niets op.
    if (acceptable && !qual.qualityOk) {
      kwaliteitAlleen++;
      if (kwaliteitAlleen >= cfg.SYNTH.kwaliteitHerhaling) {
        console.log(
          `  gestopt na poging ${attempt + 1}: alleen de kwaliteitspoort ` +
            `blokkeert nog, ${kwaliteitAlleen} keer op rij — de auto zelf klopt`,
        );
        break;
      }
    }
    if (acceptable && qual.qualityOk && verdict.issues.length <= cfg.SYNTH.goedGenoegAfwijkingen) {
      if (verdict.issues.length > 0) {
        console.log(
          `  goed genoeg na poging ${attempt + 1}: ${verdict.issues.length} kleine ` +
            "afwijking(en), geen reden om door te zoeken",
        );
      }
      break;
    }
    console.warn(
      `  ⚠ synth-poging ${attempt + 1} ` +
        (verdict.sameVehicle
          ? acceptable
            ? "met afwijkingen"
            : prop.distorted
              ? "afgekeurd (proporties)"
              : !plate.plateOk
                ? "afgekeurd (plaat)"
                : !qual.qualityOk
                  ? "afgekeurd (kwaliteit)"
                  : "afgekeurd (lak)"
          : "afgekeurd (andere auto)") +
        `: ${allIssues.join("; ") || "(geen detail opgegeven)"}`,
    );
    if (allIssues.length > 0) feedback = allIssues;
    // deze poging wordt het vertrekpunt voor de volgende
    vorigeKandidaat = { data: img };
  }
  if (!best && fallback) {
    console.warn(
      "  ⚠ geen kandidaat die ook de kwaliteitspoort haalt — beste " +
        `inhoudelijk correcte beeld gepubliceerd: ${fallback.issues.join("; ")}`,
    );
    best = fallback;
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
  return { img: best.img, fillPct, srcMedian, tintReliable };
}

/**
 * Uitvergrote rastercrops over de koets (3x2 met overlap): de schaal waarop
 * badges van twintig pixels leesbaar worden. Zelfde recept als de
 * plaatwerkpoort in car-multiview.
 */
async function gridCrops(img: Buffer, cutout: Buffer): Promise<ImagePart[]> {
  const box = await carBox(cutout);
  const meta = await sharp(img).metadata();
  if (!box || !meta.width || !meta.height) return [];
  const cols = 3, rows = 2, overlap = 0.08;
  const crops: ImagePart[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tw = box.width / cols, th = box.height / rows;
      const left = Math.max(0, Math.round(box.left + c * tw - tw * overlap));
      const top = Math.max(0, Math.round(box.top + r * th - th * overlap));
      const width = Math.min(meta.width - left, Math.round(tw * (1 + 2 * overlap)));
      const height = Math.min(meta.height - top, Math.round(th * (1 + 2 * overlap)));
      if (width < 32 || height < 32) continue;
      crops.push({
        data: await sharp(img).extract({ left, top, width, height })
          .resize({ width: 1400, withoutEnlargement: false }).jpeg({ quality: 95 }).toBuffer(),
      });
    }
  }
  return crops;
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
  // de plaat zit sinds 2026-07-30 ín de generatie (asset als referentie +
  // eigen poort); de deterministische naderhand-montage bestaat alleen nog
  // als handmatige --mount-plate voor beelden zonder plaat
  const synth = await synthesizeAngle(cli.synth, cfg, cli);
  let accepted = synth.img;

  // Deterministische lak-afwerklaag: exact naar de bron-mediaan, hetzelfde
  // doel als de rondganghoeken in car-multiview. De poortband (±15%) bewaakt
  // per beeld; zonder dit convergeren thumbnail en rondgang van dezelfde
  // auto niet — front34 en side scheelden onderling 13% luma bij gelijke
  // tint (gemeten op de AMG, 2026-08-04). Puur pixelwerk, geen API.
  if (synth.srcMedian) {
    try {
      const accPath0 = path.join(CACHE_DIR, "accepted-paint.jpg");
      await writeFile(accPath0, accepted);
      const gemeten = await paintMeansOf(accPath0, cfg, cli.useCache);
      const lumaVan = (m: ChannelMeans): number => 0.2126 * m.r + 0.7152 * m.g + 0.0722 * m.b;
      const ratio = lumaVan(gemeten) / lumaVan(synth.srcMedian);
      if (Math.abs(ratio - 1) > 0.03) {
        const gains = paintCorrectionGains(gemeten, synth.srcMedian, 1.45, !synth.tintReliable);
        const cutout0 = await getCutout(accPath0, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);
        let plateBox: { x: number; y: number; w: number; h: number } | null = null;
        try {
          plateBox = await tightPlateBox(accepted, cfg.PLATE, CACHE_DIR, cli.useCache);
        } catch {
          // zonder box corrigeert de gain ook de plaat — geen blokkade
        }
        accepted = await applyMaskedGains(accepted, cutout0, gains, plateBox);
        console.log(
          `  lak-afwerklaag: luma x${ratio.toFixed(2)} → bron-mediaan ` +
            `(gains ${gains.map((g) => g.toFixed(3)).join("/")})`,
        );
      }
    } catch (err) {
      console.warn(
        `  ⚠ lak-afwerklaag mislukt (${err instanceof Error ? err.message : err}) — kandidaat ongewijzigd`,
      );
    }
  }

  // geometrie in code: eerst de auto deterministisch op zijn reële
  // kadervulling en de vaste grondlijn zetten (alleen downscalen), daarna
  // de achtergrond vervangen door de statische plate. Faalt een stap, dan
  // publiceren we niet half — de kandidaat gaat er ongewijzigd door, met
  // melding.
  if (existsSync(cfg.SYNTH.backgroundPlatePath)) {
    try {
      const accPath = path.join(CACHE_DIR, "accepted-tmp.jpg");
      await writeFile(accPath, accepted);
      const cutout = await getCutout(accPath, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);
      const scaled = await normalizeScale(
        accepted, cutout, synth.fillPct, cfg.SYNTH.groundLineRatio,
      );
      if (scaled.measuredFill - synth.fillPct > 0.02) {
        console.log(
          `  schaal genormaliseerd: ${Math.round(scaled.measuredFill * 100)}% → ${Math.round(synth.fillPct * 100)}% kadervulling`,
        );
      }
      accepted = await replaceBackground(
        scaled.img, scaled.cutout, cfg.SYNTH.backgroundPlatePath,
      );
      await rm(accPath, { force: true });
    } catch (err) {
      console.warn(
        `  ⚠ schaal/achtergrond-normalisatie mislukt (${err instanceof Error ? err.message : err}) — kandidaat ongewijzigd gepubliceerd`,
      );
    }
  } else {
    console.warn(
      `  ⚠ studio-plate ontbreekt (${cfg.SYNTH.backgroundPlatePath}) — achtergrond blijft uit het model komen`,
    );
  }

  // De plaat deterministisch overschrijven. Het model tekent hem zelf, want
  // plaatsing en perspectief kan het wél: het zet de plaat netjes in de
  // houder op de bumper. Wat het niet kan is de tekst en het logo — die
  // kwamen er verkeerd uit. Dus laten we hem de plaat plaatsen en warpen we
  // daarna het echte asset over precies dat vlak.
  //
  // Andersom werkte niet: met een blanco houder herkent de detectie het vlak
  // slecht en landde de plaat half naast de bumper in de achtergrond
  // (gemeten op de BMW, 2026-08-03).
  if (cli.plateAfter) {
    try {
      const mountPath = path.join(CACHE_DIR, "mount-tmp.jpg");
      await writeFile(mountPath, accepted);
      const mountCut = await getCutout(mountPath, CACHE_DIR, cfg.FAL, cfg.MATTE, cli.useCache);
      const bounds = await carBox(mountCut);
      await rm(mountPath, { force: true });
      const result = await mountPlate(
        accepted, cfg.PLATE, CACHE_DIR, cli.useCache, bounds,
      );
      if (result.mounted) {
        accepted = result.image;
        console.log("  plaat deterministisch gemonteerd");
      } else {
        console.warn(`  ⚠ plaat niet gemonteerd: ${result.reason ?? "onbekend"}`);
      }
    } catch (err) {
      console.warn(
        `  ⚠ plaatmontage mislukt (${err instanceof Error ? err.message : err})`,
      );
    }
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
