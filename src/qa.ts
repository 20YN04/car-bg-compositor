import type { AlphaAnalysis } from "./bbox.js";
import type { Config } from "./config.js";
import type { Placement } from "./composite.js";

export type QACode =
  | "EMPTY_MASK"
  | "MASK_TOO_SMALL"
  | "MASK_TOO_LARGE"
  | "CUT_OFF_BOTTOM"
  | "TOUCHES_EDGE"
  | "BAD_ASPECT"
  | "MULTIPLE_BLOBS"
  | "OUT_OF_CANVAS"
  | "STRAY_MASK_REMOVED"
  | "SHADOW_IN_MASK"
  | "GROUND_TRIM_CAPPED"
  | "NOT_EXTERIOR"
  | "BACKGROUND_MERGE_SUSPECT"
  | "NO_CAR_DETECTED"
  | "PLATE_NOT_FOUND"
  | "AI_MASK_SUSPECT"
  | "AI_NOT_GROUNDED"
  | "GENBG_REJECTED";

export interface QAWarning {
  code: QACode;
  message: string;
}

export interface QAInput {
  analysis: AlphaAnalysis;
  imgWidth: number;
  imgHeight: number;
  placement: Placement | null;
  cleanRemovedArea: number; // door MASK_CLEAN opgeschoonde pixels
  detection: {
    enabled: boolean;
    found: boolean;
    outsideBoxRemoved: number; // maskerpixels buiten de auto-box verwijderd
  };
  plate: {
    enabled: boolean;
    found: boolean;
  };
}

export interface ExteriorSignal {
  name: string;
  ok: boolean;
}

export interface ExteriorClassification {
  isExterior: boolean;
  score: number;
  total: number;
  signals: ExteriorSignal[];
}

/**
 * Is dit een exterieuropname van een hele auto?
 *
 * Een listing bevat naast exterieurshots ook interieurfoto's (dashboard,
 * stoelen, koffer) en detailopnames. Die mogen niet door de compositing:
 * achtergrondvervanging, grondlijn en wielcontact zijn er betekenisloos, en
 * het resultaat is een dashboard dat op een studiovloer zweeft.
 *
 * De classificatie kost niets: alle signalen worden al berekend voor de QA.
 * We eisen niet dat álle signalen kloppen — een exterieurshot met een
 * afgesneden auto faalt terecht op één signaal maar hoort wél door de
 * pipeline. Vandaar een drempel op het aantal kloppende signalen.
 */
export function classifyExterior(
  input: QAInput,
  cfg: Config,
  minSignals: number,
): ExteriorClassification {
  const { analysis, imgWidth, imgHeight } = input;
  const qa = cfg.QA;
  const bbox = analysis.bbox;
  const areaFraction = analysis.area / Math.max(1, imgWidth * imgHeight);
  const aspect = bbox
    ? (bbox.right - bbox.left + 1) / Math.max(1, bbox.bottom - bbox.top + 1)
    : 0;

  const signals: ExteriorSignal[] = [
    // detectie uit → neutraal (telt als kloppend), anders moet er een auto zijn
    { name: "auto gedetecteerd", ok: !input.detection.enabled || input.detection.found },
    { name: "één samenhangend masker", ok: analysis.blobCount === 1 },
    {
      name: "maskeroppervlak plausibel",
      ok: areaFraction >= qa.minMaskArea && areaFraction <= qa.maxMaskArea,
    },
    { name: "verhouding als een auto", ok: aspect >= qa.minAspect && aspect <= qa.maxAspect },
    {
      name: "wielcontact gevonden",
      ok: analysis.groundLine !== null && !analysis.groundFallback,
    },
  ];
  const score = signals.filter((s) => s.ok).length;
  return { isExterior: score >= minSignals, score, total: signals.length, signals };
}

/**
 * Niet-blokkerende kwaliteitschecks. Ze vangen precies de gevallen waar de
 * grondlijn niet betrouwbaar te bepalen is of het masker meer dan de auto
 * bevat (afgesneden auto, interieurshot, slagschaduw, background-merge).
 */
export function runQA(input: QAInput, cfg: Config): QAWarning[] {
  const { analysis, imgWidth, imgHeight, placement } = input;
  const warnings: QAWarning[] = [];
  const { bbox, area, blobCount } = analysis;
  const qa = cfg.QA;

  if (input.detection.enabled && !input.detection.found) {
    warnings.push({
      code: "NO_CAR_DETECTED",
      message:
        "detector vond geen auto — masker onbegrensd (oude gedrag), plaatsing mogelijk onbetrouwbaar",
    });
  }

  if (!bbox) {
    warnings.push({ code: "EMPTY_MASK", message: "masker is leeg — niets gedetecteerd" });
    return warnings;
  }

  const areaFraction = area / (imgWidth * imgHeight);
  if (areaFraction < qa.minMaskArea) {
    warnings.push({
      code: "MASK_TOO_SMALL",
      message: `mask-oppervlak ${(areaFraction * 100).toFixed(1)}% < ${qa.minMaskArea * 100}%`,
    });
  } else if (areaFraction > qa.maxMaskArea) {
    warnings.push({
      code: "MASK_TOO_LARGE",
      message: `mask-oppervlak ${(areaFraction * 100).toFixed(1)}% > ${qa.maxMaskArea * 100}%`,
    });
  }

  if (bbox.bottom >= imgHeight - 1 - qa.edgeMargin) {
    warnings.push({
      code: "CUT_OFF_BOTTOM",
      message: "bbox raakt de onderrand — auto afgesneden, grondlijn onbetrouwbaar",
    });
  }
  const touched: string[] = [];
  if (bbox.left <= qa.edgeMargin) touched.push("links");
  if (bbox.right >= imgWidth - 1 - qa.edgeMargin) touched.push("rechts");
  if (bbox.top <= qa.edgeMargin) touched.push("boven");
  if (touched.length > 0) {
    warnings.push({
      code: "TOUCHES_EDGE",
      message: `bbox raakt beeldrand: ${touched.join(", ")}`,
    });
  }

  const aspect =
    (bbox.right - bbox.left + 1) / Math.max(1, bbox.bottom - bbox.top + 1);
  if (aspect < qa.minAspect || aspect > qa.maxAspect) {
    warnings.push({
      code: "BAD_ASPECT",
      message: `aspect ratio ${aspect.toFixed(2)} buiten ${qa.minAspect}–${qa.maxAspect} — waarschijnlijk geen volledige auto`,
    });
  }

  if (blobCount > 1) {
    warnings.push({
      code: "MULTIPLE_BLOBS",
      message: `${blobCount} losse blobs in het masker — model heeft mogelijk iets anders opgepikt`,
    });
  }

  if (analysis.shadowBandHeight > 0 || analysis.groundTrim > 2) {
    const parts: string[] = [];
    if (analysis.shadowBandHeight > 0) {
      parts.push(`${analysis.shadowBandHeight} rijen uitwaaierende schaduw genegeerd`);
    }
    if (analysis.groundTrim > 2) {
      parts.push(
        `${analysis.groundTrim}px masker onder de wiellijn weggesneden (aangesmolten contactschaduw)`,
      );
    }
    warnings.push({ code: "SHADOW_IN_MASK", message: parts.join("; ") });
  }

  const bumpSuspect =
    analysis.topBump !== null &&
    analysis.topBump.height > Math.max(10, (bbox.bottom - bbox.top + 1) * 0.06);
  const outsideSuspect =
    input.detection.found &&
    input.detection.outsideBoxRemoved > 0.01 * (area + input.detection.outsideBoxRemoved);
  if (bumpSuspect || outsideSuspect) {
    const parts: string[] = [];
    if (outsideSuspect) {
      parts.push(
        `${input.detection.outsideBoxRemoved}px masker buiten de auto-box verwijderd`,
      );
    }
    if (bumpSuspect && analysis.topBump) {
      parts.push(
        `bult van ${analysis.topBump.height}px boven de daklijn (${analysis.topBump.width} kolommen)`,
      );
    }
    warnings.push({
      code: "BACKGROUND_MERGE_SUSPECT",
      message: `model plakte mogelijk een achtergrondobject aan de auto: ${parts.join("; ")}`,
    });
  }

  if (input.cleanRemovedArea > 0 && input.cleanRemovedArea > 0.005 * (area + input.cleanRemovedArea)) {
    const pct = ((input.cleanRemovedArea / (area + input.cleanRemovedArea)) * 100).toFixed(1);
    warnings.push({
      code: "STRAY_MASK_REMOVED",
      message: `${pct}% van het masker was dun/losstaand materiaal en is opgeschoond — model pikte mogelijk iets anders op (paal, windmolen)`,
    });
  }

  if (placement?.outOfCanvas) {
    warnings.push({
      code: "OUT_OF_CANVAS",
      message: "geplaatste auto valt (deels) buiten het canvas",
    });
  }

  if (input.plate.enabled && !input.plate.found) {
    warnings.push({
      code: "PLATE_NOT_FOUND",
      message: "geen nummerplaat op de auto gedetecteerd — plaat niet geanonimiseerd",
    });
  }

  return warnings;
}
