/**
 * Configuratie van de thumbnail-pipeline.
 *
 * De oude deterministische compositing-pipeline (matte → plaatsing op een
 * studioplate → plaat/ruiten/lak-bewerkingen) is verwijderd op 2026-07-30;
 * hij staat integraal onder de git-tag `composiet-pipeline-v1`. Wat hier
 * overblijft is de configuratie van de synth-flow: Gemini reconstrueert de
 * canonieke catalogushoek, en een reeks poorten (dimensie, identiteit, lak,
 * proporties) bewaakt het resultaat.
 */

import path from "node:path";

export interface GeminiConfig {
  /**
   * Model voor de poortoordelen. Het dagquotum van Gemini geldt per model,
   * dus inspecties op het beeldmodel eten het generatiebudget op: gemeten in
   * car-multiview waren 112 van de 138 calls op één auto poortoordelen
   * (2026-08-01). Bij een onbekende naam valt gemini.ts terug op `modelId`.
   */
  textModelId: string;
  /** Gemini 3 Pro met image-generation (Nano Banana Pro). */
  modelId: string;
  /**
   * Moet bij het vaste uitvoerraster van het model passen: 3:2@2K levert
   * exact 2528×1696 (gemeten 2026-07-30, rechtstreeks tegen de Google-API —
   * er zit geen proxy tussen die imageConfig kan strippen). De galerij is
   * 3:2; de dimensiepoort in index.ts test hierop.
   */
  aspectRatio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
  imageSize: "1K" | "2K" | "4K";
}

export type MatteProvider = "fal-rmbg" | "fal-birefnet" | "rembg";

/**
 * De matte wordt alléén nog gebruikt om lakpixels te selecteren voor de
 * kleurmeting — niet meer voor compositing. fal-rmbg is de kwaliteitsroute;
 * `rembg` (lokaal, gratis, isnet-general-use) is ruim goed genoeg als de
 * fal-key ooit weer sterft en kost alleen ~6 s/beeld op CPU.
 */
export interface MatteConfig {
  provider: MatteProvider;
  rmbgModelId: string; // fal-rmbg (BRIA RMBG 2.0)
  rembgModel: string; // lokaal rembg-model
}

/** fal BiRefNet-variant, alleen gebruikt bij provider "fal-birefnet". */
export interface FalConfig {
  modelId: string;
  model: string;
  operatingResolution: string;
  outputFormat: string;
  refineForeground: boolean;
}

export interface SynthConfig {
  seed: number;
  maxAttempts: number;
  /**
   * Aantal kleine afwijkingen waarbij de lus stopt in plaats van door te
   * zoeken naar een volmaakte kandidaat. De harde poorten zijn dan al door;
   * doorgaan kost generaties en levert zelden iets beters op.
   */
  goedGenoegAfwijkingen: number;
  /**
   * Na hoeveel keer dat ALLEEN de kwaliteitspoort nog blokkeert we stoppen.
   * Die poort vergelijkt met het anker — een zwarte AMG — en vindt een witte
   * hatchback stelselmatig 'minder scherp en minder premium'. Op de VW ID.3
   * sneuvelden zo zes van de zes pogingen op woordelijk dezelfde klacht,
   * terwijl de auto zelf al vanaf poging 1 klopte (2026-08-03). De klacht is
   * bovendien onuitvoerbaar: 'wees scherper' stuurt de volgende generatie
   * niet. Twee keer dezelfde uitkomst is genoeg bewijs dat doorzoeken niets
   * oplevert.
   */
  kwaliteitHerhaling: number;
  /**
   * Ondergrens voor de gemeten detaildichtheid van de uitvoer, als fractie
   * van de mediaan over de bronfoto's van dezelfde auto. Vergelijken met de
   * eigen bron is de eerlijke maat: het anker is een andere auto in een
   * andere kleur.
   *
   * Geijkt op alle tien de tot nu toe goedgekeurde thumbnails (2026-08-03).
   * Die spreiden van 0.65 (BMW i5, uitzonderlijk scherpe bronfoto's) tot
   * 1.39 (Renault Scenic, matige bronfoto's die de pipeline juist opknapt).
   * 0.55 laat dat hele veld door en vangt alleen een render die echt is
   * weggesmolten. Er zit nog geen enkel afgekeurd voorbeeld in de ijking,
   * dus de drempel is bewust laag: hij mag vangen, niet gokken.
   */
  minDetailRatio: number;
  /**
   * Deterministische lakcontrole: de gemiddelde lak van de kandidaat (via
   * de matte) moet binnen deze band van de bron-mediaan blijven. De
   * VLM-inspectie alleen bleek te vergeeflijk — zilver dat wit rendert kwam
   * erdoor.
   *
   * Geijkt op de EQE-set (2026-07-30): de échte foto van de doelhoek zat op
   * luminantieratio 1.007 en tintdelta's 0.040 (r/g) en 0.007 (b/g); de
   * afgekeurde te witte synthese op ratio 1.198 en b/g-delta 0.064.
   * Herijken zodra er meer sets door dit pad zijn gegaan.
   */
  minLumaRatio: number;
  maxLumaRatio: number;
  maxTintDelta: number; // max |Δ(r/g)| en |Δ(b/g)| t.o.v. de bron-mediaan
  /**
   * Compositie-anker: de eerste goedgekeurde thumbnail (EQE, 2026-07-30),
   * als vast referentiebeeld voor kader, camerahoogte en achtergrond.
   * Zonder anker koos het model die per auto zelf en week de Taycan
   * zichtbaar af van de EQE. Het anker dicteert nooit de karrosserie: de
   * prompt eist de eigen proporties uit de bronfoto's en de proportie-poort
   * keurt samengedrukte of uitgerekte koetsen af.
   */
  anchorPath: string;
  /**
   * Statische lege studio (eenmalig uit het anker gedestilleerd,
   * 2026-07-30). Na acceptatie wordt de achtergrond van elke kandidaat
   * deterministisch door déze plate vervangen — de achtergrond kan dus per
   * definitie niet meer per generatie verschillen.
   */
  backgroundPlatePath: string;
  /**
   * Vaste grondlijn (fractie van de beeldhoogte) waarop elke auto met zijn
   * bbox-onderkant landt na de schaalnormalisatie. Gemeten op het anker
   * (2026-07-30): de EQE staat met zijn onderkant op 0.813.
   */
  groundLineRatio: number;
}

/**
 * De Carredo-kentekenplaat (wit, blauw wordmark, houder met leasing-strip)
 * wordt deterministisch op de gegenereerde plaathouder gewarpt — leesbare
 * tekst en het logo mogen nooit uit het model komen, hertekende tekens
 * gaan altijd mis. Florence vindt de houder, SAM2 geeft het plaatvlak.
 */
export interface PlateConfig {
  assetPath: string;
  detectPrompt: string;
  detectionModelId: string; // bbox uit tekstprompt (Florence-2 grounding)
  segmentModelId: string; // box-prompt → masker (SAM2)
}

export interface Config {
  GEMINI: GeminiConfig;
  MATTE: MatteConfig;
  FAL: FalConfig;
  SYNTH: SynthConfig;
  PLATE: PlateConfig;
}

export const defaultConfig: Config = {
  GEMINI: {
    modelId: "gemini-3-pro-image",
    textModelId: process.env["GEMINI_TEXT_MODEL"] || "gemini-2.5-flash",
    aspectRatio: "3:2",
    imageSize: "2K",
  },
  MATTE: {
    provider: "fal-rmbg",
    rmbgModelId: "fal-ai/bria/background/remove",
    rembgModel: "isnet-general-use",
  },
  FAL: {
    modelId: "fal-ai/birefnet/v2",
    model: "General Use (Heavy)",
    operatingResolution: "2048x2048",
    outputFormat: "png",
    refineForeground: true,
  },
  SYNTH: {
    seed: 20260724,
    // 4 sinds de decor-poort: die verbruikt geregeld een poging voordat de
    // inhoudelijke poorten aan de beurt komen
    // 6 sinds de geometrie- en decorpoorten: die verbruiken samen geregeld
    // drie pogingen voordat de inhoudelijke poorten aan bod komen
    maxAttempts: 6,
    goedGenoegAfwijkingen: 2,
    kwaliteitHerhaling: 2,
    minDetailRatio: 0.55,
    minLumaRatio: 0.85,
    maxLumaRatio: 1.15,
    maxTintDelta: 0.05,
    anchorPath: "assets/thumbnail-composition-anchor.jpg",
    // absoluut, ten opzichte van deze module: een relatief pad hing af van
    // de cwd van het proces, en een ontbrekende plate publiceerde de
    // achtergrond van het model (Yentl, 2026-09-28)
    backgroundPlatePath: path.resolve(import.meta.dirname, "..", "assets", "studio-empty.jpg"),
    groundLineRatio: 0.813,
  },
  PLATE: {
    assetPath: "assets/carredo-plate.png",
    detectPrompt: "license plate",
    detectionModelId: "fal-ai/florence-2-large/caption-to-phrase-grounding",
    segmentModelId: "fal-ai/sam2/image",
  },
};
