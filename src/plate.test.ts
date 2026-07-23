import { describe, expect, it } from "vitest";
import sharp from "sharp";
import type { BBox } from "./bbox.js";
import { computePlacement } from "./composite.js";
import { defaultConfig } from "./config.js";
import { anonymizePlates, computePlateRegions } from "./plate.js";

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
      img, [region], canvas, { ...defaultConfig.PLATE, mode: "off" }, "CARREDO",
    );
    expect(status).toBe("off");
    expect(image).toBe(img);
  });

  it("mode blur wijzigt de regio maar niet de omgeving", async () => {
    const img = await testImage();
    const { image, status } = await anonymizePlates(
      img, [region], canvas, { ...defaultConfig.PLATE, mode: "blur" }, "CARREDO",
    );
    expect(status).toBe("blurred");
    // binnen de regio: de harde zwart-op-geel tekst is uitgesmeerd
    const inside = await pixel(image, 75, 52);
    const insideOrig = await pixel(img, 75, 52);
    expect(inside).not.toEqual(insideOrig);
    // buiten de regio: onaangetast grijs
    expect(await pixel(image, 10, 10)).toEqual(await pixel(img, 10, 10));
  });

  it("mode replace legt een plaatoverlay over de regio", async () => {
    const img = await testImage();
    const { image, status } = await anonymizePlates(
      img, [region], canvas, { ...defaultConfig.PLATE, mode: "replace" }, "X",
    );
    expect(status).toBe("replaced");
    // de gele plaat is bedekt door de lichte overlay (#f4f4f4)
    const [r, g, b] = await pixel(image, 65, 50);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it("geen regio's → status none", async () => {
    const img = await testImage();
    const { status } = await anonymizePlates(
      img, [], canvas, defaultConfig.PLATE, "CARREDO",
    );
    expect(status).toBe("none");
  });
});
