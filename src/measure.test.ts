import { describe, expect, it } from "vitest";
import { cutoutMeans, medianMeans } from "./measure.js";

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

  it("valt op neutraal grijs terug bij een leeg masker", () => {
    const { rgba, alpha } = makeCutout(100, 150, 200);
    alpha.fill(0);
    expect(cutoutMeans(rgba, alpha, 4, 4)).toEqual({ r: 128, g: 128, b: 128 });
  });
});

describe("medianMeans", () => {
  it("is robuust tegen één afwijkende opname", () => {
    const ref = medianMeans([
      { r: 100, g: 100, b: 100 },
      { r: 104, g: 102, b: 101 },
      { r: 102, g: 101, b: 100 },
      { r: 250, g: 40, b: 40 }, // uitschieter
    ]);
    expect(ref.r).toBeCloseTo(103);
    expect(ref.g).toBeCloseTo(100.5);
  });

  it("geeft neutraal grijs voor een lege lijst", () => {
    expect(medianMeans([])).toEqual({ r: 128, g: 128, b: 128 });
  });
});
