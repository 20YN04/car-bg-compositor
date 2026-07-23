import { describe, expect, it } from "vitest";
import {
  analyzeAlpha,
  computeBBox,
  computeGroundLine,
  countBlobs,
  erodeAlpha,
} from "./bbox.js";

const OPTS = { threshold: 10, groundPercentile: 0.95, minBlobArea: 0.005 };

function makeAlpha(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height);
}

function fillRect(
  alpha: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value = 255,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      alpha[y * width + x] = value;
    }
  }
}

describe("computeBBox", () => {
  it("vindt de exacte bbox van een rechthoek", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 20, 30, 40);
    const { bbox, area } = computeBBox(alpha, 100, 100, 10);
    expect(bbox).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    expect(area).toBe(21 * 21);
  });

  it("negeert pixels op of onder de threshold", () => {
    const alpha = makeAlpha(50, 50);
    fillRect(alpha, 50, 5, 5, 10, 10, 10); // exact op threshold → telt niet
    fillRect(alpha, 50, 20, 20, 25, 25, 11);
    const { bbox } = computeBBox(alpha, 50, 50, 10);
    expect(bbox).toEqual({ left: 20, top: 20, right: 25, bottom: 25 });
  });

  it("geeft null bij een leeg masker", () => {
    const { bbox, area } = computeBBox(makeAlpha(50, 50), 50, 50, 10);
    expect(bbox).toBeNull();
    expect(area).toBe(0);
  });
});

describe("computeGroundLine", () => {
  it("is gelijk aan de onderkant bij een vlakke rechthoek", () => {
    const alpha = makeAlpha(200, 200);
    fillRect(alpha, 200, 20, 50, 179, 150);
    const { bbox } = computeBBox(alpha, 200, 200, 10);
    const ground = computeGroundLine(alpha, 200, 200, bbox!, 10, 0.95);
    expect(ground).toBe(150);
  });

  it("negeert een uitschieter onder de auto (percentiel-methode)", () => {
    const alpha = makeAlpha(200, 200);
    // "auto": brede rechthoek met onderkant op y=150
    fillRect(alpha, 200, 20, 50, 179, 150);
    // uitschieter: dunne sliert (3 kolommen) die 30px lager doorloopt,
    // zoals een meegemaskte slagschaduw of afhangend onderdeel
    fillRect(alpha, 200, 100, 150, 102, 180);
    const { bbox } = computeBBox(alpha, 200, 200, 10);
    expect(bbox!.bottom).toBe(180); // bbox ziet de uitschieter wél
    const ground = computeGroundLine(alpha, 200, 200, bbox!, 10, 0.95);
    expect(ground).toBe(150); // de grondlijn niet
  });

  it("volgt de bulk wanneer bijna alle kolommen lager doorlopen", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 89, 80); // 80 kolommen tot y=80
    const { bbox } = computeBBox(alpha, 100, 100, 10);
    const ground = computeGroundLine(alpha, 100, 100, bbox!, 10, 0.95);
    expect(ground).toBe(80);
  });
});

describe("countBlobs", () => {
  it("telt twee gescheiden vlakken als twee blobs", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 19, 19); // 100 px
    fillRect(alpha, 100, 60, 60, 69, 69); // 100 px
    expect(countBlobs(alpha, 100, 100, 10, 0.005)).toBe(2); // min = 50 px
  });

  it("negeert blobs onder het minimum-oppervlak", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 19, 19); // 100 px
    fillRect(alpha, 100, 60, 60, 61, 61); // 4 px speck
    expect(countBlobs(alpha, 100, 100, 10, 0.005)).toBe(1);
  });

  it("ziet een diagonaal gescheiden vorm als losse blobs (4-connectiviteit)", () => {
    const alpha = makeAlpha(10, 10);
    alpha[0] = 255; // (0,0)
    alpha[11] = 255; // (1,1) — alleen diagonaal verbonden
    expect(countBlobs(alpha, 10, 10, 10, 0)).toBe(2);
  });
});

describe("analyzeAlpha", () => {
  it("combineert bbox, grondlijn, oppervlak en blob-telling", () => {
    const alpha = makeAlpha(200, 200);
    fillRect(alpha, 200, 20, 50, 179, 150);
    fillRect(alpha, 200, 100, 150, 102, 180); // uitschieter
    const result = analyzeAlpha(alpha, 200, 200, OPTS);
    expect(result.bbox).toEqual({ left: 20, top: 50, right: 179, bottom: 180 });
    expect(result.groundLine).toBe(150);
    expect(result.blobCount).toBe(1);
    expect(result.area).toBeGreaterThan(0);
  });

  it("geeft een lege analyse bij een leeg masker", () => {
    const result = analyzeAlpha(makeAlpha(50, 50), 50, 50, OPTS);
    expect(result.bbox).toBeNull();
    expect(result.groundLine).toBeNull();
    expect(result.blobCount).toBe(0);
  });
});

describe("erodeAlpha", () => {
  it("krimpt een vlak met 1px aan alle kanten", () => {
    const alpha = makeAlpha(20, 20);
    fillRect(alpha, 20, 5, 5, 14, 14);
    const eroded = erodeAlpha(alpha, 20, 20);
    const { bbox } = computeBBox(eroded, 20, 20, 10);
    expect(bbox).toEqual({ left: 6, top: 6, right: 13, bottom: 13 });
  });
});
