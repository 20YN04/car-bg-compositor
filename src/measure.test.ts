import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { cutoutMeans, detailStrength, medianMeans } from "./measure.js";

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

describe("detailStrength", () => {
  // De poort staat of valt met de vraag of dit getal écht op onscherpte
  // reageert. Een vervaagde kopie van hetzelfde beeld moet meetbaar lager
  // uitkomen — anders meet het iets anders dan scherpte.
  it("meet een vervaagde kopie lager dan het origineel", async () => {
    const scherp = await sharp({
      create: { width: 400, height: 400, channels: 3, background: "#ffffff" },
    })
      .composite([
        {
          input: Buffer.from(
            '<svg width="400" height="400">' +
              '<rect x="40" y="40" width="120" height="320" fill="#101010"/>' +
              '<rect x="220" y="40" width="60" height="320" fill="#202020"/>' +
              "</svg>",
          ),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 98 })
      .toBuffer();
    const vaag = await sharp(scherp).blur(6).jpeg({ quality: 98 }).toBuffer();

    const a = await detailStrength(scherp);
    const b = await detailStrength(vaag);
    expect(b).toBeLessThan(a * 0.7);
  });
});
