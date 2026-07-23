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
  COST_PER_CALL_USD: number;
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
  // IJken op het fal.ai-dashboard: prijs staat niet in de publieke docs.
  COST_PER_CALL_USD: 0.002,
};
