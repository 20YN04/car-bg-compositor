import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { toAbsoluteBox, unionMasks } from "./sam3.js";

describe("toAbsoluteBox", () => {
  it("zet genormaliseerd [cx,cy,w,h] om naar absoluut [x,y,w,h]", () => {
    // gecentreerd blok van een kwart breed/hoog in een 1000×500 beeld
    const box = toAbsoluteBox([0.5, 0.5, 0.25, 0.25], 1000, 500);
    expect(box).not.toBeNull();
    expect(box!.x).toBeCloseTo(375);
    expect(box!.y).toBeCloseTo(187.5);
    expect(box!.w).toBeCloseTo(250);
    expect(box!.h).toBeCloseTo(125);
  });

  it("laat een box die al in pixels staat ongemoeid", () => {
    // guard voor het geval de API toch absolute coördinaten teruggeeft: zonder
    // deze check zou 620×110 met de beeldmaat vermenigvuldigd worden
    const box = toAbsoluteBox([620, 400, 240, 60], 1000, 500);
    expect(box!.x).toBeCloseTo(500);
    expect(box!.y).toBeCloseTo(370);
    expect(box!.w).toBeCloseTo(240);
    expect(box!.h).toBeCloseTo(60);
  });

  it("verwerpt een box zonder oppervlak of met ontbrekende waarden", () => {
    expect(toAbsoluteBox([0.5, 0.5, 0, 0.2], 100, 100)).toBeNull();
    expect(toAbsoluteBox([0.5, 0.5], 100, 100)).toBeNull();
  });

  it("klemt niet: een box die buiten beeld valt blijft meetbaar", () => {
    // de aanroeper filtert zelf (filterBoxesOnCar); stil bijknippen zou een
    // half-buiten-beeld raam ongemerkt verschuiven
    const box = toAbsoluteBox([0.05, 0.5, 0.4, 0.2], 1000, 500);
    expect(box!.x).toBeCloseTo(-150);
  });
});

describe("unionMasks", () => {
  const solid = (w: number, h: number, v: number): Promise<Buffer> =>
    sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } })
      .png()
      .toBuffer();

  async function pixel(buf: Buffer, x: number, y: number): Promise<number> {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels] ?? 0;
  }

  it("geeft een zwart masker terug zonder segmenten", async () => {
    const out = await unionMasks([], 20, 10);
    expect(await pixel(out, 5, 5)).toBe(0);
  });

  it("neemt per pixel het maximum van overlappende maskers", async () => {
    // twee halve maskers die elkaar overlappen: lighten mag niet optellen
    const left = await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: await solid(12, 10, 255), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const right = await sharp({
      create: { width: 20, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: await solid(12, 10, 255), left: 8, top: 0 }])
      .png()
      .toBuffer();

    const out = await unionMasks([left, right], 20, 10);
    expect(await pixel(out, 2, 5)).toBe(255); // alleen links
    expect(await pixel(out, 18, 5)).toBe(255); // alleen rechts
    expect(await pixel(out, 10, 5)).toBe(255); // overlap: niet 510/clip-artefact
  });

  it("schaalt segmenten naar het gevraagde formaat", async () => {
    const small = await solid(10, 5, 255);
    const out = await unionMasks([small], 40, 20);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
    expect(await pixel(out, 20, 10)).toBe(255);
  });
});
