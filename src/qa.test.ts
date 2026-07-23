import { describe, expect, it } from "vitest";
import type { AlphaAnalysis } from "./bbox.js";
import type { Placement } from "./composite.js";
import { defaultConfig } from "./config.js";
import { runQA, type QAInput } from "./qa.js";

// AI_MASK_SUSPECT en AI_NOT_GROUNDED komen uit de VLM-checks in index.ts en
// vallen buiten runQA; alle overige codes worden hier afgedekt.

function baseAnalysis(): AlphaAnalysis {
  return {
    bbox: { left: 100, top: 400, right: 899, bottom: 699 }, // 800×300, aspect 2.67
    groundLine: 695,
    area: 240_000, // 24% van 1000×1000
    blobCount: 1,
    shadowBandHeight: 0,
    topBump: null,
  };
}

function basePlacement(): Placement {
  return { scale: 1, x: 0, y: 0, width: 800, height: 300, outOfCanvas: false };
}

function baseInput(overrides: Partial<QAInput> = {}): QAInput {
  return {
    analysis: baseAnalysis(),
    imgWidth: 1000,
    imgHeight: 1000,
    placement: basePlacement(),
    cleanRemovedArea: 0,
    detection: { enabled: true, found: true, outsideBoxRemoved: 0 },
    plate: { enabled: true, found: true },
    ...overrides,
  };
}

function codes(input: QAInput): string[] {
  return runQA(input, defaultConfig).map((w) => w.code);
}

describe("runQA", () => {
  it("geeft geen waarschuwingen voor een schoon beeld", () => {
    expect(codes(baseInput())).toEqual([]);
  });

  it("EMPTY_MASK bij leeg masker", () => {
    const input = baseInput();
    input.analysis = { ...baseAnalysis(), bbox: null, groundLine: null, area: 0 };
    expect(codes(input)).toContain("EMPTY_MASK");
  });

  it("NO_CAR_DETECTED wanneer de detector niets vindt", () => {
    const input = baseInput({ detection: { enabled: true, found: false, outsideBoxRemoved: 0 } });
    expect(codes(input)).toContain("NO_CAR_DETECTED");
  });

  it("geen NO_CAR_DETECTED wanneer detectie uit staat", () => {
    const input = baseInput({ detection: { enabled: false, found: false, outsideBoxRemoved: 0 } });
    expect(codes(input)).not.toContain("NO_CAR_DETECTED");
  });

  it("MASK_TOO_SMALL / MASK_TOO_LARGE op oppervlaktegrenzen", () => {
    const small = baseInput();
    small.analysis.area = 50_000; // 5%
    expect(codes(small)).toContain("MASK_TOO_SMALL");

    const large = baseInput();
    large.analysis.area = 800_000; // 80%
    expect(codes(large)).toContain("MASK_TOO_LARGE");
  });

  it("CUT_OFF_BOTTOM wanneer de bbox de onderrand raakt", () => {
    const input = baseInput();
    input.analysis.bbox = { left: 100, top: 400, right: 899, bottom: 999 };
    expect(codes(input)).toContain("CUT_OFF_BOTTOM");
  });

  it("TOUCHES_EDGE bij links/rechts/boven", () => {
    const input = baseInput();
    input.analysis.bbox = { left: 0, top: 400, right: 899, bottom: 699 };
    expect(codes(input)).toContain("TOUCHES_EDGE");
  });

  it("BAD_ASPECT buiten 1.2–4.5", () => {
    const input = baseInput();
    input.analysis.bbox = { left: 100, top: 100, right: 299, bottom: 699 }; // 0.33
    expect(codes(input)).toContain("BAD_ASPECT");
  });

  it("MULTIPLE_BLOBS bij meer dan één blob", () => {
    const input = baseInput();
    input.analysis.blobCount = 3;
    expect(codes(input)).toContain("MULTIPLE_BLOBS");
  });

  it("SHADOW_IN_MASK wanneer de shadow-band reject aansloeg", () => {
    const input = baseInput();
    input.analysis.shadowBandHeight = 40;
    expect(codes(input)).toContain("SHADOW_IN_MASK");
  });

  it("BACKGROUND_MERGE_SUSPECT bij een significante dakbult", () => {
    const input = baseInput();
    input.analysis.topBump = { width: 60, height: 50 }; // > 6% van 300 bbox-hoogte
    expect(codes(input)).toContain("BACKGROUND_MERGE_SUSPECT");
  });

  it("BACKGROUND_MERGE_SUSPECT bij veel masker buiten de auto-box", () => {
    const input = baseInput({
      detection: { enabled: true, found: true, outsideBoxRemoved: 50_000 },
    });
    expect(codes(input)).toContain("BACKGROUND_MERGE_SUSPECT");
  });

  it("geen BACKGROUND_MERGE_SUSPECT bij een verwaarloosbare bult", () => {
    const input = baseInput();
    input.analysis.topBump = { width: 10, height: 8 };
    expect(codes(input)).not.toContain("BACKGROUND_MERGE_SUSPECT");
  });

  it("STRAY_MASK_REMOVED wanneer de opschoning substantieel was", () => {
    const input = baseInput({ cleanRemovedArea: 10_000 });
    expect(codes(input)).toContain("STRAY_MASK_REMOVED");
  });

  it("OUT_OF_CANVAS wanneer de plaatsing buiten het canvas valt", () => {
    const input = baseInput();
    input.placement = { ...basePlacement(), outOfCanvas: true };
    expect(codes(input)).toContain("OUT_OF_CANVAS");
  });

  it("PLATE_NOT_FOUND alleen wanneer plaatdetectie aan stond en niets vond", () => {
    const missing = baseInput({ plate: { enabled: true, found: false } });
    expect(codes(missing)).toContain("PLATE_NOT_FOUND");

    const disabled = baseInput({ plate: { enabled: false, found: false } });
    expect(codes(disabled)).not.toContain("PLATE_NOT_FOUND");
  });
});
