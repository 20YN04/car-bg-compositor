import { describe, expect, it } from "vitest";
import {
  compressHighlights,
  cutoutMeans,
  harmonizeColors,
  medianMeans,
} from "./harmonize.js";

const CFG = { enabled: true, strength: 0.35, maxGain: 0.12, setConsistent: false };

function makeCutout(r: number, g: number, b: number): {
  rgba: Buffer;
  alpha: Uint8Array;
} {
  const rgba = Buffer.alloc(4 * 4 * 4);
  const alpha = new Uint8Array(16).fill(255);
  for (let i = 0; i < 16; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
  }
  return { rgba, alpha };
}

describe("cutoutMeans", () => {
  it("weegt met het alfakanaal en negeert transparante pixels", () => {
    const { rgba, alpha } = makeCutout(100, 150, 200);
    alpha.fill(0);
    alpha[0] = 255;
    rgba[0] = 10;
    expect(cutoutMeans(rgba, alpha, 4, 4).r).toBe(10);
  });
});

describe("harmonizeColors", () => {
  it("trekt een koele (blauwe) auto richting een neutrale achtergrond", () => {
    const { rgba, alpha } = makeCutout(120, 130, 170); // koel
    const car = cutoutMeans(rgba, alpha, 4, 4);
    const gains = harmonizeColors(
      rgba, alpha, 4, 4, car, { r: 180, g: 180, b: 180 }, CFG,
    );
    // blauw omlaag t.o.v. rood
    expect(gains.b).toBeLessThan(gains.r);
    expect(rgba[2]! / rgba[0]!).toBeLessThan(170 / 120);
  });

  it("respecteert de maxGain-cap", () => {
    const { rgba, alpha } = makeCutout(60, 60, 240); // extreem blauw
    const car = cutoutMeans(rgba, alpha, 4, 4);
    const gains = harmonizeColors(
      rgba, alpha, 4, 4, car, { r: 180, g: 180, b: 180 }, CFG,
    );
    for (const v of [gains.r, gains.g, gains.b]) {
      expect(v).toBeGreaterThanOrEqual((1 - CFG.maxGain) * (1 - CFG.maxGain));
      expect(v).toBeLessThanOrEqual((1 + CFG.maxGain) * (1 + CFG.maxGain));
    }
  });

  it("laat transparante pixels ongemoeid", () => {
    const { rgba, alpha } = makeCutout(120, 130, 170);
    alpha[5] = 0;
    const before = rgba[5 * 4];
    const car = cutoutMeans(rgba, alpha, 4, 4);
    harmonizeColors(rgba, alpha, 4, 4, car, { r: 180, g: 180, b: 180 }, CFG);
    expect(rgba[5 * 4]).toBe(before);
  });
});

describe("set-consistentie", () => {
  const BG = { r: 180, g: 180, b: 180 };

  it("medianMeans is robuust tegen één afwijkende opname", () => {
    const ref = medianMeans([
      { r: 100, g: 100, b: 100 },
      { r: 104, g: 102, b: 101 },
      { r: 102, g: 101, b: 100 },
      { r: 250, g: 40, b: 40 }, // uitschieter
    ]);
    // r sorteert naar 100/102/104/250 → (102+104)/2; de uitschieter valt buiten
    expect(ref.r).toBeCloseTo(103);
    // g sorteert naar 40/100/101/102 → (100+101)/2
    expect(ref.g).toBeCloseTo(100.5);
  });

  it("brengt twee verschillend belichte opnames van dezelfde auto samen", () => {
    // zelfde auto, ochtend (koel) en namiddag (warm)
    const koel = makeCutout(110, 125, 165);
    const warm = makeCutout(165, 130, 105);
    const mKoel = cutoutMeans(koel.rgba, koel.alpha, 4, 4);
    const mWarm = cutoutMeans(warm.rgba, warm.alpha, 4, 4);
    const ref = medianMeans([mKoel, mWarm]);

    // zonder set-referentie: elk beeld gaat zijn eigen kant op
    const soloKoel = makeCutout(110, 125, 165);
    const soloWarm = makeCutout(165, 130, 105);
    harmonizeColors(soloKoel.rgba, soloKoel.alpha, 4, 4, mKoel, BG, CFG);
    harmonizeColors(soloWarm.rgba, soloWarm.alpha, 4, 4, mWarm, BG, CFG);
    const soloSpread =
      Math.abs(soloKoel.rgba[0]! - soloWarm.rgba[0]!) +
      Math.abs(soloKoel.rgba[2]! - soloWarm.rgba[2]!);

    // mét set-referentie: beide naar hetzelfde witpunt
    harmonizeColors(koel.rgba, koel.alpha, 4, 4, mKoel, BG, CFG, ref);
    harmonizeColors(warm.rgba, warm.alpha, 4, 4, mWarm, BG, CFG, ref);
    const setSpread =
      Math.abs(koel.rgba[0]! - warm.rgba[0]!) +
      Math.abs(koel.rgba[2]! - warm.rgba[2]!);

    expect(setSpread).toBeLessThan(soloSpread);
  });

  it("laat een set van één foto ongemoeid t.o.v. het oude gedrag", () => {
    // referentie = de foto zelf → stap 1 is de identiteit
    const a = makeCutout(120, 130, 170);
    const b = makeCutout(120, 130, 170);
    const means = cutoutMeans(a.rgba, a.alpha, 4, 4);
    const zonder = harmonizeColors(a.rgba, a.alpha, 4, 4, means, BG, CFG);
    const met = harmonizeColors(b.rgba, b.alpha, 4, 4, means, BG, CFG, means);
    expect(met.r).toBeCloseTo(zonder.r, 6);
    expect(met.g).toBeCloseTo(zonder.g, 6);
    expect(met.b).toBeCloseTo(zonder.b, 6);
  });
});

describe("compressHighlights", () => {
  const cfg = { enabled: true, knee: 200, strength: 0.5 };

  /** 10×10 grijze auto (150) met één felle spikkel op index 0. */
  function speckledCar(speckle: [number, number, number], bodyAlpha = 255) {
    const n = 100;
    const rgba = Buffer.alloc(n * 4);
    const alpha = new Uint8Array(n).fill(bodyAlpha);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = 150;
      rgba[i * 4 + 1] = 150;
      rgba[i * 4 + 2] = 150;
      rgba[i * 4 + 3] = 255;
    }
    rgba[0] = speckle[0];
    rgba[1] = speckle[1];
    rgba[2] = speckle[2];
    return { rgba, alpha };
  }

  it("comprimeert alleen de spikkel en behoudt de hue-verhouding", () => {
    const { rgba, alpha } = speckledCar([250, 240, 230]);
    const touched = compressHighlights(rgba, alpha, 10, 10, cfg);
    expect(touched).toBe(1);
    // mean max ≈ 151 → adaptieve knee blijft op de ondergrens 200;
    // max 250 → 200 + 50*0.5 = 225; alle kanalen schalen met 225/250
    expect(rgba[0]).toBe(225);
    expect(rgba[1]).toBe(216);
    expect(rgba[2]).toBe(207);
    // carrosserie onder de knee: exact onaangetast
    expect(rgba[4]).toBe(150);
  });

  it("schuift de knee mee op een witte auto (geen afvlakking)", () => {
    const n = 100;
    const rgba = Buffer.alloc(n * 4);
    const alpha = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = 235;
      rgba[i * 4 + 1] = 235;
      rgba[i * 4 + 2] = 235;
      rgba[i * 4 + 3] = 255;
    }
    // mean max = 235 → knee 270 → niets boven de knee
    expect(compressHighlights(rgba, alpha, 10, 10, cfg)).toBe(0);
    expect(rgba[0]).toBe(235);
  });

  it("slaat transparante pixels over", () => {
    const { rgba, alpha } = speckledCar([255, 255, 255], 0);
    expect(compressHighlights(rgba, alpha, 10, 10, cfg)).toBe(0);
    expect(rgba[0]).toBe(255);
  });

  it("doet niets wanneer uitgeschakeld", () => {
    const { rgba, alpha } = speckledCar([255, 255, 255]);
    expect(compressHighlights(rgba, alpha, 10, 10, { ...cfg, enabled: false })).toBe(0);
    expect(rgba[0]).toBe(255);
  });
});
