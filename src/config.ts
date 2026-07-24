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

export type MatteProvider = "fal-birefnet" | "fal-rmbg" | "api4ai";

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
  /** Basis-matte-model; de SAM2-combine en box-begrenzing blijven gelijk. */
  provider: MatteProvider;
  rmbgModelId: string; // fal-ai/bria/background/remove (RMBG 2.0)
  /** Alfa-randen aanscherpen: overgangsband samenknijpen tot ~1px AA. */
  edgeSharpen: boolean;
  edgeLow: number; // alfa ≤ low → transparant
  edgeHigh: number; // alfa ≥ high → dekkend
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
  /** Aparte korte prompts werken beter dan één lange caption: Florence
   * ground-t een lange zin ook op "the car" en geeft dan full-frame boxes. */
  detectPrompts: string[];
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

export interface HarmonizeConfig {
  enabled: boolean;
  strength: number; // 0..1: hoe ver richting de achtergrondtoon
  maxGain: number; // cap op de per-kanaal gain-afwijking (bv. 0.12 = ±12%)
}

export interface HighlightConfig {
  /**
   * Specular-compressie: dempt de felle reflecties van de oorspronkelijke
   * omgeving (tl-balken, spots) in de lak via een soft-knee curve op de
   * luminantie boven `knee`. `strength` = fractie van het exces dat
   * weggenomen wordt (0.6 → spikkel op 255 zakt naar knee + 40% van het
   * exces). Normale lakverlopen onder de knee blijven exact gelijk.
   */
  enabled: boolean;
  knee: number; // 0..255
  strength: number; // 0..1
}

export interface GenBgConfig {
  /**
   * Hybride scène-stap: FLUX Fill herschildert achtergrond + contactschaduw
   * + vloerreflectie rond de auto (masker: wit = herschilderen, zwart = auto
   * behouden). De originele autopixels worden er daarna ALTIJD pixel-exact
   * terug overheen gelegd — velgen/badges kunnen dus niet vervormen. Dit is
   * de enige generatieve stap in de pipeline en raakt de auto nooit.
   */
  enabled: boolean;
  /**
   * hero: alleen de eerste bruikbare foto van de batch (de listing-hero)
   * krijgt de generatieve scène — premium eerste indruk, consistente
   * mathematische composieten voor de rest, en een fractie van de kosten.
   * all: elke foto. (Scenario-keuze 2026-07-24: hero.)
   */
  mode: "hero" | "all";
  modelId: string;
  prompt: string;
  costPerCall: number; // ijken op het fal-dashboard
  seed: number; // basisseed; per afgekeurde poging +1
  maxAttempts: number; // hallucinatie-poort: max scène-pogingen
  /**
   * FLUX Fill rekent $0.05 per megapixel, afgerond naar boven. Het volle
   * canvas (1920×1440 = 2.76 MP) kost dus $0.15/poging; op ≤1 MP genereren
   * en de scène opschalen kost $0.05. De achtergrond bestaat uit zachte
   * verlopen — de upscale is onzichtbaar; de auto gaat op volle resolutie
   * terug op de scène.
   */
  fillMaxMegapixels: number;
}

export type AnglePreset = "side" | "front34" | "rear34";

export interface PresetOverride {
  contactTargetY?: number;
  spanMeters?: number; // zichtbare spanwijdte voor deze hoek
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
  glowStrength: number; // zachte hotspot achter de auto (screen blend)
  vignetteStrength: number; // donkere hoeken
  toneBrightness: number; // 1 = ongewijzigd; <1 iets donkerder
  toneWarmth: number; // 0 = neutraal; >0 warmer (r omhoog, b omlaag)
}

export interface BrandingConfig {
  enabled: boolean;
  text: string; // wordmark wanneer er geen logoPath is
  logoPath?: string; // eigen logo-afbeelding (png met transparantie)
  opacity: number;
  fontSize: number;
  margin: number; // afstand tot de rechterbenedenhoek
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
  CAR_SHARPEN_SIGMA: number; // milde sharpen op de geschaalde autolaag (0 = uit)
  QA: QAConfig;
  FAL: FalConfig;
  DETECT: DetectConfig;
  MATTE: MatteConfig;
  AI: AiConfig;
  PLATE: PlateConfig;
  WINDOWS: WindowsConfig;
  BRANDING: BrandingConfig;
  HIGHLIGHTS: HighlightConfig; // specular-compressie op de autolaag
  GENBG: GenBgConfig; // hybride generatieve scène rond de beschermde auto
  BACKGROUND_PROFILES: Record<string, BackgroundProfile>; // key = bestandsnaam
  DEFAULT_PROFILE: BackgroundProfile;
  HARMONIZE: HarmonizeConfig;
  PRESETS: Record<AnglePreset, PresetOverride>; // fase 4: per-hoek kadrering
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
    openRadiusRatio: 0.003, // ~6px bij 2048: windmolen weg, antenne blijft heel
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
  CAR_SHARPEN_SIGMA: 0.8,
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
    featherSigma: 1, // strakkere rand; 2 maakte de outline zichtbaar zacht
    // A/B op ARV/RV/RVV (2026-07-23): RMBG 2.0 geeft vollere, rondere
    // bandonderkanten (BiRefNet plat de band bij RV licht af) bij even
    // scherpe spaken; geen halo's in beide. Daarom default rmbg.
    provider: "fal-rmbg",
    rmbgModelId: "fal-ai/bria/background/remove",
    edgeSharpen: true,
    edgeLow: 64,
    edgeHigh: 192,
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
    // branded look: CARREDO-plaat i.p.v. blur (anonimiseert evengoed)
    mode: "replace",
    blurSigma: 12,
    style: "gaussian",
  },
  BRANDING: {
    enabled: true,
    text: "CARREDO",
    // echte Carredo-wordmark (navy, transparante PNG) zoals op de live site;
    // de tekst-fallback blijft voor wie zonder asset draait
    logoPath: "assets/carredo-logo.png",
    opacity: 0.92,
    fontSize: 40,
    margin: 56,
  },
  BACKGROUND_PROFILES: {
    // gegenereerde carredo-achtige studioplate (scripts/make-studio-bg.mjs)
    "studio.png": {
      horizonY: 576,
      contactTargetY: 985,
      floorScaleRef: 225, // ~0.52 canvasbreedte bij 4.4 m spanwijdte
      carWidthMeters: 4.4,
      lightDirX: -0.2,
      lightSoftness: 1.3,
      floorReflectivity: 0.22,
      reflectionHeightRatio: 0.28,
      glowStrength: 0.2,
      vignetteStrength: 0.3,
      toneBrightness: 0.94,
      toneWarmth: 0,
    },
    // gekalibreerd op de betonvloer-showroomplate (1440×938 → cover 1920×1440)
    "showroom.jpg": {
      horizonY: 867,
      // 1195 i.p.v. 1150: bij sterke 3/4-views staat het verre wiel door de
      // gebakken fotoperspectief tot ~300px hoger dan het nabije wiel; met de
      // contactlijn dieper op de vloer blijft ook dat wiel onder de
      // wand/vloerovergang (867) in plaats van "op de muur" te landen
      contactTargetY: 1195,
      floorScaleRef: 314,
      carWidthMeters: 4.4,
      lightDirX: -0.35, // plate is links het lichtst
      lightSoftness: 1.2,
      floorReflectivity: 0.12,
      reflectionHeightRatio: 0.18, // subtiel en snel uitgefaded
      glowStrength: 0.14,
      vignetteStrength: 0.18,
      toneBrightness: 0.96, // referentie is een tikje donkerder
      toneWarmth: 0.025, // en een tikje warmer grijs

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
    // ingetogen op de vloerloze gradient: een sterke spiegeling leest daar
    // als "natte vloer"-ghost in plaats van als subtiele verankering
    floorReflectivity: 0.08,
    reflectionHeightRatio: 0.16,
    glowStrength: 0.1,
    vignetteStrength: 0.12,
    toneBrightness: 1,
    toneWarmth: 0,
  },
  HARMONIZE: {
    enabled: true,
    strength: 0.35,
    maxGain: 0.12,
  },
  HIGHLIGHTS: {
    enabled: true,
    knee: 200, // ondergrens; schuift adaptief mee met de autohelderheid
    strength: 0.75,
  },
  GENBG: {
    enabled: true,
    mode: "hero",
    modelId: "fal-ai/flux-pro/v1/fill",
    // géén "showroom" in de prompt: dat nodigt het model uit om er andere
    // auto's en een dealerhal bij te verzinnen
    prompt:
      "A completely empty photo studio: one plain seamless light gray " +
      "backdrop wall and a smooth matte gray concrete floor. The room is " +
      "empty — no other cars, no objects, no people, no windows, no " +
      "ceiling, no visible light fixtures, no text. Soft diffuse studio " +
      "light matching the light on the car. A realistic soft contact " +
      "shadow under the tires and a subtle car reflection on the floor. " +
      "The car stands directly on the flat floor — no podium, no " +
      "turntable, no platform. Photorealistic.",
    costPerCall: 0.05, // 1 MP-fill @ $0.05/MP (afgerond naar boven)
    seed: 20260724,
    maxAttempts: 3,
    fillMaxMegapixels: 1,
  },
  PRESETS: {
    side: { spanMeters: 4.3 },
    front34: { spanMeters: 4.6 },
    rear34: { spanMeters: 4.6 },
  },
  WINDOWS: {
    enabled: true,
    detectPrompts: ["car window", "windshield"],
    segmentModelId: "fal-ai/sam2/image",
    tintOpacity: 0.68,
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
