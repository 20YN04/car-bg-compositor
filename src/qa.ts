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
  | "PLATE_NOT_FOUND"
  | "AI_MASK_SUSPECT"
  | "AI_NOT_GROUNDED";

export interface QAWarning {
  code: QACode;
  message: string;
}

/**
 * Niet-blokkerende kwaliteitschecks. Ze vangen precies de gevallen waar de
 * grondlijn niet betrouwbaar te bepalen is (afgesneden auto, interieurshot,
 * meerdere objecten opgepikt).
 */
export function runQA(
  analysis: AlphaAnalysis,
  imgWidth: number,
  imgHeight: number,
  placement: Placement | null,
  cfg: Config,
  cleanRemovedArea = 0,
): QAWarning[] {
  const warnings: QAWarning[] = [];
  const { bbox, area, blobCount } = analysis;
  const qa = cfg.QA;

  if (!bbox) {
    return [{ code: "EMPTY_MASK", message: "masker is leeg — niets gedetecteerd" }];
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

  if (cleanRemovedArea > 0 && cleanRemovedArea > 0.005 * (area + cleanRemovedArea)) {
    const pct = ((cleanRemovedArea / (area + cleanRemovedArea)) * 100).toFixed(1);
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

  return warnings;
}
