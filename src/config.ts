export interface CanvasSize {
  width: number;
  height: number;
}

export interface ShadowConfig {
  widthRatio: number; // breedte van de schaduw t.o.v. de autobreedte
  height: number; // totale hoogte van de ellips in px
  blur: number; // gaussian blur sigma
  opacity: number;
  offsetX: number; // verschuiving t.o.v. bbox-midden ("iets naar achteren")
  offsetY: number; // verschuiving t.o.v. GROUND_Y
}

export interface MaskCleanConfig {
  enabled: boolean;
  openRadiusRatio: number; // erosieradius als fractie van de beeldbreedte
  minRadius: number;
  maxRadius: number;
}

export interface QAConfig {
  minMaskArea: number; // fractie van het beeldoppervlak
  maxMaskArea: number;
  minAspect: number;
  maxAspect: number;
  edgeMargin: number; // px afstand tot beeldrand waarbij "raakt rand" geldt
  minBlobArea: number; // fractie van het beeldoppervlak waaronder een blob genegeerd wordt
}

export interface FalConfig {
  modelId: string;
  model: string;
  operatingResolution: string;
  outputFormat: string;
  refineForeground: boolean;
}

export interface DetectConfig {
  enabled: boolean;
  modelId: string;
  prompt: string;
  /**
   * Drempel voor de heuristische detectiescore (oppervlak × centraliteit,
   * 0–1). Florence-2 geeft geen modelconfidence terug; deze score is onze
   * eigen maat voor "dit is dé auto van deze listing-foto".
   */
  minConfidence: number;
  boxMargin: number; // marge rond de auto-box als fractie van de boxmaat
}

export interface MatteConfig {
  /**
   * Instance-matte (fase 0): SAM2 met de auto-box als prompt levert een
   * instancemasker dat per definitie geen grondschaduw bevat; het BiRefNet-
   * alfa wordt ermee begrensd (per-pixel min). BiRefNet houdt de zachte
   * randen, SAM2 maakt de wielranden scherp.
   */
  enabled: boolean;
  dilateRadius: number; // bescherming van dunne delen tegen SAM2's grovere rand
  featherSigma: number;
}

export interface WindowsConfig {
  /**
   * Ruiten donker tinten: door de ramen blijft anders de oorspronkelijke
   * omgeving zichtbaar (bomen, hek), wat vloekt met de nieuwe achtergrond.
   * Detectie (Florence-2) + segmentatie (SAM2 met box-prompts) leveren een
   * raammasker; die pixels worden wiskundig richting tintColor verdonkerd —
   * reflecties blijven subtiel zichtbaar, geen generatieve bewerking.
   */
  enabled: boolean;
  detectPrompt: string;
  segmentModelId: string;
  tintOpacity: number; // 0..1: hoe sterk richting tintColor
  tintColor: { r: number; g: number; b: number };
  featherSigma: number; // blur op de maskrand voor een zachte overgang
}

export type PlateMode = "blur" | "replace" | "off";

export interface PlateConfig {
  /**
   * blur (default): plaatregio onherkenbaar maken (GDPR, EU/België).
   * replace: getekende plaat met AI.plateText, of overlayPath indien gezet.
   * off: plaat onaangetast laten.
   */
  mode: PlateMode;
  overlayPath?: string; // eigen plaatafbeelding voor mode 'replace'
  blurSigma: number;
  style: "gaussian" | "mosaic";
}

export interface AiConfig {
  enabled: boolean;
  plateText: string; // tekst op de vervangende nummerplaat
  detectionModelId: string; // plaatdetectie (bbox uit tekstprompt)
  vlmModelId: string; // visual question answering voor AI-kwaliteitscontrole
  costPerDetection: number;
  costPerQuery: number;
  costPerSegment: number;
}

export interface BackgroundProfile {
  /**
   * Kalibratie per achtergrond-plate (fase 1/2): plaatsing, schaal, licht en
   * reflectie slaan op de werkelijke vloer van déze plate. Willekeurige
   * plates werken niet — de camerahoogte/-hoek van de plate moet bij de
   * auto-shots passen; een mismatch is een plate-keuzeprobleem, geen codebug.
   */
  horizonY: number | null; // canvas-y van de vloer/wandovergang (documentatie/QA)
  contactTargetY: number; // canvas-y waar de wielcontactlijn moet landen
  floorScaleRef: number; // px per meter op de contactdiepte van deze plate
  /**
   * Zichtbare spanwijdte van de auto in meters: bij zij-/3/4-aanzichten is
   * dat de (deels verkorte) lengte (~4.4 m), niet de autobreedte van 1.8 m.
   * Per-hoek presets (fase 4) verfijnen dit.
   */
  carWidthMeters: number;
  lightDirX: number; // -1..1, richting waaruit het licht komt (negatief = links)
  lightSoftness: number; // multiplier op de schaduwblur
  floorReflectivity: number; // 0..1 sterkte van de vloerreflectie
  reflectionHeightRatio: number; // fractie van de autohoogte die meespiegelt
}

export interface Config {
  CANVAS: CanvasSize;
  GROUND_Y: number; // y-coördinaat waar de banden komen te staan
  CAR_WIDTH_RATIO: number; // fractie canvasbreedte
  ALPHA_THRESHOLD: number;
  GROUND_PERCENTILE: number;
  ERODE_MASK: boolean; // 1px erosie tegen kleurhalo's van de originele achtergrond
  MASK_CLEAN: MaskCleanConfig; // opschoning: dunne/losstaande structuren (windmolen, paal) weg
  SHADOW: ShadowConfig;
  JPEG_QUALITY: number;
  QA: QAConfig;
  FAL: FalConfig;
  DETECT: DetectConfig;
  MATTE: MatteConfig;
  AI: AiConfig;
  PLATE: PlateConfig;
  WINDOWS: WindowsConfig;
  BACKGROUND_PROFILES: Record<string, BackgroundProfile>; // key = bestandsnaam
  DEFAULT_PROFILE: BackgroundProfile;
  COST_PER_CALL_USD: number;
  MONTHLY_VOLUME: number; // verwacht beeldvolume voor de kostenextrapolatie
}

export const defaultConfig: Config = {
  CANVAS: { width: 1920, height: 1440 },
  GROUND_Y: 1200,
  CAR_WIDTH_RATIO: 0.82,
  ALPHA_THRESHOLD: 10,
  GROUND_PERCENTILE: 0.95,
  ERODE_MASK: false,
  MASK_CLEAN: {
    enabled: true,
    openRadiusRatio: 0.004, // ~8px bij 2048 breed: dunner dan ~16px verdwijnt
    minRadius: 2,
    maxRadius: 12,
  },
  SHADOW: {
    widthRatio: 0.9,
    height: 80,
    blur: 25,
    opacity: 0.45,
    offsetX: 20,
    offsetY: 0,
  },
  JPEG_QUALITY: 90,
  QA: {
    minMaskArea: 0.08,
    maxMaskArea: 0.75,
    minAspect: 1.2,
    maxAspect: 4.5,
    edgeMargin: 2,
    minBlobArea: 0.005,
  },
  FAL: {
    modelId: "fal-ai/birefnet/v2",
    model: "General Use (Heavy)",
    operatingResolution: "2048x2048",
    outputFormat: "png",
    refineForeground: true,
  },
  /**
   * Instance-aware masking (implementatie B): BiRefNet blijft het masker
   * leveren (zachte hoge-resolutie matting-randen — dat haalt SAM2's binaire
   * masker niet), maar het alfamasker wordt begrensd tot de gedetecteerde
   * auto-box. Zo verdwijnen mee-gemaskeerde slagschaduw op de grond en
   * aanpalende achtergrondobjecten (busje-dak) structureel.
   */
  DETECT: {
    enabled: true,
    modelId: "fal-ai/florence-2-large/open-vocabulary-detection",
    prompt: "car",
    minConfidence: 0.05,
    boxMargin: 0.02,
  },
  MATTE: {
    enabled: true,
    dilateRadius: 4,
    featherSigma: 2,
  },
  AI: {
    enabled: true,
    plateText: "CARREDO",
    detectionModelId: "fal-ai/florence-2-large/caption-to-phrase-grounding",
    vlmModelId: "fal-ai/moondream2/visual-query",
    // ijken op het fal-dashboard
    costPerDetection: 0.001,
    costPerQuery: 0.001,
    costPerSegment: 0.002,
  },
  PLATE: {
    mode: "blur",
    blurSigma: 12,
    style: "gaussian",
  },
  BACKGROUND_PROFILES: {
    // gekalibreerd op de betonvloer-showroomplate (1440×938 → cover 1920×1440)
    "showroom.jpg": {
      horizonY: 867,
      contactTargetY: 1150,
      floorScaleRef: 314,
      carWidthMeters: 4.4,
      lightDirX: -0.35, // plate is links het lichtst
      lightSoftness: 1.2,
      floorReflectivity: 0.16,
      reflectionHeightRatio: 0.35,
    },
  },
  // neutrale gradient: geen perspectief, dus de klassieke plaatsing
  DEFAULT_PROFILE: {
    horizonY: null,
    contactTargetY: 1200,
    floorScaleRef: 358, // ≈ oude CAR_WIDTH_RATIO 0.82 bij 4.4 m spanwijdte
    carWidthMeters: 4.4,
    lightDirX: 0,
    lightSoftness: 1,
    floorReflectivity: 0.12,
    reflectionHeightRatio: 0.3,
  },
  WINDOWS: {
    enabled: true,
    detectPrompt: "car window",
    segmentModelId: "fal-ai/sam2/image",
    tintOpacity: 0.45,
    tintColor: { r: 35, g: 40, b: 48 },
    featherSigma: 5,
  },
  /**
   * SCHATTING — de prijs per BiRefNet-call staat niet in de publieke docs.
   * IJk deze waarde (en AI.costPerDetection / AI.costPerQuery) op het
   * fal.ai-dashboard vóór er beslissingen op de extrapolatie worden gebaseerd.
   */
  COST_PER_CALL_USD: 0.002,
  MONTHLY_VOLUME: 75_000,
};
