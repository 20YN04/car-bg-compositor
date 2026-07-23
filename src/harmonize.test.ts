import { describe, expect, it } from "vitest";
import { cutoutMeans, harmonizeColors } from "./harmonize.js";

const CFG = { enabled: true, strength: 0.35, maxGain: 0.12 };

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
