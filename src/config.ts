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

export interface GeminiConfig {
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
    maxAttempts: 4,
    minLumaRatio: 0.85,
    maxLumaRatio: 1.15,
    maxTintDelta: 0.05,
    anchorPath: "assets/thumbnail-composition-anchor.jpg",
  },
  PLATE: {
    assetPath: "assets/carredo-plate.png",
    detectPrompt: "license plate",
    detectionModelId: "fal-ai/florence-2-large/caption-to-phrase-grounding",
    segmentModelId: "fal-ai/sam2/image",
  },
};
