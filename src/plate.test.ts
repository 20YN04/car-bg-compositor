import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { BBox } from "./bbox.js";
import { computePlacement } from "./composite.js";
import { defaultConfig } from "./config.js";
import {
  affinePlacementForQuad,
  anonymizePlates,
  computePlateRegions,
  fitPlateInRegion,
  inflateQuad,
  plateQuadFromMask,
} from "./plate.js";

const CANVAS = { width: 1920, height: 1440 };

describe("computePlateRegions", () => {
  const bbox: BBox = { left: 100, top: 200, right: 899, bottom: 599 };
  const placement = computePlacement(bbox, 599, CANVAS, 1200, 0.82);

  function alphaWithCar(): Uint8Array {
    const alpha = new Uint8Array(1000 * 700);
    for (let y = 200; y <= 599; y++) {
      for (let x = 100; x <= 899; x++) alpha[y * 1000 + x] = 255;
    }
    return alpha;
  }

  it("mapt een plaat op de auto naar een geklemde canvasregio met dekmarge", () => {
    const regions = computePlateRegions(
      [{ x: 400, y: 500, w: 100, h: 24 }],
      alphaWithCar(), 1000, 700, bbox, placement, CANVAS, 10,
    );
    expect(regions).toHaveLength(1);
    const r = regions[0]!;
    // marge: 10% breder en 8% hoger dan de kale mapping
    expect(r.width).toBeCloseTo(110 * placement.scale, -1);
    expect(r.height).toBeCloseTo(24 * 1.08 * placement.scale, -1);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y + r.height).toBeLessThanOrEqual(CANVAS.height);
  });

  it("verwerpt een reuzebox (hele auto) als onplausibele plaat", () => {
    const regions = computePlateRegions(
      [{ x: 100, y: 200, w: 790, h: 390 }], // ≈ de volledige auto-bbox
      alphaWithCar(), 1000, 700, bbox, placement, CANVAS, 10,
    );
    expect(regions).toHaveLength(0);
  });

  it("verwerpt detecties die niet op de gemaskeerde auto liggen", () => {
    const regions = computePlateRegions(
      [{ x: 10, y: 10, w: 100, h: 24 }], // buiten het masker
      alphaWithCar(), 1000, 700, bbox, placement, CANVAS, 10,
    );
    expect(regions).toHaveLength(0);
  });

  it("verwerpt regio's die na mapping te klein zijn", () => {
    const regions = computePlateRegions(
      [{ x: 400, y: 500, w: 2, h: 1 }],
      alphaWithCar(), 1000, 700, bbox, placement, CANVAS, 10,
    );
    expect(regions).toHaveLength(0);
  });
});

describe("fitPlateInRegion", () => {
  it("klemt de verhouding op plaatachtig (3.4:1) in een brede detectiezone", () => {
    const fit = fitPlateInRegion({ x: 100, y: 100, width: 200, height: 120 });
    expect(fit.width / fit.height).toBeCloseTo(3.4, 1);
    expect(fit.width).toBeLessThanOrEqual(200);
    expect(fit.height).toBeLessThanOrEqual(120);
    // gecentreerd
    expect(fit.left).toBeGreaterThan(100);
    expect(fit.top).toBeGreaterThan(100);
  });

  it("volgt de regioverhouding bij een plaatachtige zone en dekt die maximaal", () => {
    const fit = fitPlateInRegion({ x: 0, y: 0, width: 92, height: 20 });
    // regioverhouding 4.6, met ±0.1 speling door pixelafronding
    expect(fit.width / fit.height).toBeGreaterThan(4.4);
    expect(fit.width / fit.height).toBeLessThan(4.8);
    expect(fit.width).toBeGreaterThanOrEqual(88); // ≥97% dekking
  });
});

describe("plateQuadFromMask", () => {
  const W = 400;
  const H = 200;

  /** Parallellogram-masker: linkerrand op y=[80,120], rechterrand op y=[60,100]. */
  function slantedMask(): Uint8Array {
    const mask = new Uint8Array(W * H);
    for (let x = 100; x <= 300; x++) {
      const t = (x - 100) / 200;
      const top = Math.round(80 - 20 * t);
      const bot = Math.round(120 - 20 * t);
      for (let y = top; y <= bot; y++) mask[y * W + x] = 255;
    }
    return mask;
  }

  it("haalt een schuin plaatvlak uit het masker", () => {
    const quad = plateQuadFromMask(slantedMask(), W, H, { x: 100, y: 60, w: 200, h: 60 });
    expect(quad).not.toBeNull();
    // linkerrand lager dan rechterrand (plaat helt omhoog naar rechts)
    expect(quad!.tl.y).toBeGreaterThan(quad!.tr.y);
    expect(quad!.bl.y).toBeGreaterThan(quad!.br.y);
    // hoogte links ≈ hoogte rechts ≈ 40
    expect(quad!.bl.y - quad!.tl.y).toBeCloseTo(40, 0);
    expect(quad!.br.y - quad!.tr.y).toBeCloseTo(40, 0);
  });

  it("verwerpt een leeg of te smal masker", () => {
    expect(plateQuadFromMask(new Uint8Array(W * H), W, H, { x: 100, y: 60, w: 200, h: 60 }))
      .toBeNull();
  });

  it("verwerpt een niet-plaatachtige (te vierkante) segmentatie", () => {
    const mask = new Uint8Array(W * H);
    for (let x = 150; x <= 250; x++) {
      for (let y = 20; y <= 180; y++) mask[y * W + x] = 255;
    }
    expect(plateQuadFromMask(mask, W, H, { x: 150, y: 20, w: 100, h: 160 })).toBeNull();
  });
});

describe("affinePlacementForQuad", () => {
  it("beeldt de badge-hoeken exact op het quad af", () => {
    const quad = {
      tl: { x: 10, y: 20 },
      tr: { x: 110, y: 10 },
      bl: { x: 12, y: 45 },
      br: { x: 112, y: 35 },
    };
    const w = 100;
    const h = 25;
    const { matrix, left, top } = affinePlacementForQuad(quad, w, h);
    const [a, b, c, d] = matrix;
    // basisvectoren: (w,0) → tl→tr en (0,h) → tl→bl
    expect(a * w + b * 0).toBeCloseTo(quad.tr.x - quad.tl.x, 5);
    expect(c * w + d * 0).toBeCloseTo(quad.tr.y - quad.tl.y, 5);
    // (0,h) → bl
    expect(a * 0 + b * h).toBeCloseTo(quad.bl.x - quad.tl.x, 5);
    expect(c * 0 + d * h).toBeCloseTo(quad.bl.y - quad.tl.y, 5);
    // offset = bovenste/linkse hoek van het getransformeerde vlak
    expect(left).toBe(10);
    expect(top).toBe(10);
  });
});

describe("inflateQuad", () => {
  it("blaast uniform op rond het zwaartepunt", () => {
    const q = {
      tl: { x: 0, y: 0 },
      tr: { x: 10, y: 0 },
      bl: { x: 0, y: 4 },
      br: { x: 10, y: 4 },
    };
    const grown = inflateQuad(q, 1.5);
    expect(grown.tl.x).toBeCloseTo(-2.5);
    expect(grown.br.x).toBeCloseTo(12.5);
    expect(grown.tl.y).toBeCloseTo(-1);
    expect(grown.br.y).toBeCloseTo(5);
  });
});

describe("anonymizePlates", () => {
  const canvas = { width: 200, height: 100 };
  const region = { x: 60, y: 40, width: 80, height: 20 };

  async function testImage(): Promise<Buffer> {
    // vlak grijs beeld met een fel geel "plaat"-blok in de regio
    const svg =
      `<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="200" height="100" fill="#808080"/>` +
      `<rect x="60" y="40" width="80" height="20" fill="#ffee00"/>` +
      `<text x="70" y="55" font-size="14" fill="#000">ABC123</text>` +
      `</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  async function pixel(buf: Buffer, x: number, y: number): Promise<number[]> {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
  }

  it("mode off laat het beeld ongemoeid", async () => {
    const img = await testImage();
    const { image, status } = await anonymizePlates(
      img, [{ region }], canvas, { ...defaultConfig.PLATE, mode: "off" }, "CARREDO",
    );
    expect(status).toBe("off");
    expect(image).toBe(img);
  });

  it("mode blur wijzigt de regio maar niet de omgeving", async () => {
    const img = await testImage();
    const { image, status } = await anonymizePlates(
      img, [{ region }], canvas, { ...defaultConfig.PLATE, mode: "blur" }, "CARREDO",
    );
    expect(status).toBe("blurred");
    // binnen de regio: de harde zwart-op-geel tekst is uitgesmeerd
    const inside = await pixel(image, 75, 52);
    const insideOrig = await pixel(img, 75, 52);
    expect(inside).not.toEqual(insideOrig);
    // buiten de regio: onaangetast grijs
    expect(await pixel(image, 10, 10)).toEqual(await pixel(img, 10, 10));
  });

  it("mode replace legt een donkere CARREDO-badge over de regio", async () => {
    const img = await testImage();
    const { image, status } = await anonymizePlates(
      img, [{ region }], canvas, { ...defaultConfig.PLATE, mode: "replace" }, "X",
    );
    expect(status).toBe("replaced");
    // plaatmidden: wit wordmark ("X") op de badge
    const [r, g, b] = await pixel(image, 100, 50);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    // plaatvlak naast het wordmark: donkere badge, geel origineel bedekt
    const [dr, dg, db] = await pixel(image, 72, 50);
    expect(dr).toBeLessThan(60);
    expect(dg).toBeLessThan(60);
    expect(db).toBeLessThan(60);
  });

  it("geen regio's → status none", async () => {
    const img = await testImage();
    const { status } = await anonymizePlates(
      img, [], canvas, defaultConfig.PLATE, "CARREDO",
    );
    expect(status).toBe("none");
  });
});
