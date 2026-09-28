import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { defaultConfig } from "./config.js";
import { assertPlate, normaliseToPlate, plateDeviation, replaceBackground } from "./background.js";

// Eis van Yentl (2026-09-28): "Een andere achtergrond zou niet mogen." Een
// gepubliceerde thumbnail staat altijd op de vaste studio-plate, geschaald en
// op de grondlijn — of hij wordt niet gepubliceerd.

const W = 600, H = 400;

/** Kleine versie van de echte plate: de tests draaien op het echte decor. */
async function testPlate(naam: string): Promise<string> {
  mkdirSync("cache", { recursive: true });
  const p = path.join("cache", naam);
  await sharp(defaultConfig.SYNTH.backgroundPlatePath).resize(W, H, { fit: "fill" }).png().toFile(p);
  return p;
}

/** Kandidaat met een donkere "auto" op een eigen, egale modelachtergrond. */
async function kandidaat(bg: { r: number; g: number; b: number }, auto: { x: number; y: number; w: number; h: number }) {
  const img = await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
    .composite([{
      input: Buffer.from(`<svg width="${W}" height="${H}"><rect x="${auto.x}" y="${auto.y}" width="${auto.w}" height="${auto.h}" fill="rgb(40,40,45)"/></svg>`),
      left: 0, top: 0,
    }])
    .jpeg({ quality: 96 }).toBuffer();
  const cutout = await sharp(
    Buffer.from(`<svg width="${W}" height="${H}"><rect x="${auto.x}" y="${auto.y}" width="${auto.w}" height="${auto.h}" fill="black"/></svg>`),
  ).png().toBuffer();
  return { img, cutout };
}

describe("plate-pad", () => {
  it("is absoluut en wijst naar het asset, los van de cwd van het proces", () => {
    const p = defaultConfig.SYNTH.backgroundPlatePath;
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(path.join("assets", "studio-empty.jpg"))).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

describe("assertPlate", () => {
  it("aanvaardt de echte plate", async () => {
    await expect(assertPlate(defaultConfig.SYNTH.backgroundPlatePath)).resolves.toBeUndefined();
  });
  it("weigert een ontbrekende plate", async () => {
    await expect(assertPlate("/bestaat/niet/studio-empty.jpg")).rejects.toThrow(/plate/);
  });
  it("weigert een onleesbare plate", async () => {
    mkdirSync("cache", { recursive: true });
    const p = "cache/test-kapotte-plate.jpg";
    await writeFile(p, Buffer.from("geen jpeg"));
    await expect(assertPlate(p)).rejects.toThrow(/plate/);
    await rm(p, { force: true });
  });
});

describe("plateDeviation — laatste poort vóór publicatie", () => {
  it("laat een beeld door waarvan de achtergrond de plate is", async () => {
    const platePath = await testPlate("test-gate-plate-ok.png");
    const k = await kandidaat({ r: 150, g: 150, b: 150 }, { x: 150, y: 150, w: 300, h: 170 });
    const uit = await replaceBackground(k.img, k.cutout, platePath);
    expect(await plateDeviation(uit, platePath)).toBeNull();
    await rm(platePath, { force: true });
  });

  it("weigert de eigen achtergrond van het model, ook als die licht grijs is", async () => {
    const platePath = await testPlate("test-gate-plate-model.png");
    // neutraal lichtgrijs, dicht bij de plate — het soort decor dat het model tekent
    const k = await kandidaat({ r: 190, g: 190, b: 196 }, { x: 150, y: 150, w: 300, h: 170 });
    expect(await plateDeviation(k.img, platePath)).toMatch(/plate/);
    await rm(platePath, { force: true });
  });

  it("weigert een plate met een andere kleurzweem (blauw x0.945)", async () => {
    const platePath = await testPlate("test-gate-plate-zweem.png");
    const verschoven = await sharp(platePath).linear([1, 1, 0.945], [0, 0, 0]).jpeg({ quality: 96 }).toBuffer();
    expect(await plateDeviation(verschoven, platePath)).toMatch(/plate/);
    await rm(platePath, { force: true });
  });
});

describe("normaliseToPlate", () => {
  it("levert de auto gecentreerd op de plate, en dat beeld haalt de poort", async () => {
    const platePath = await testPlate("test-norm-plate.png");
    // te groot en uit het midden, zoals het model hem tekent
    const k = await kandidaat({ r: 150, g: 150, b: 150 }, { x: 10, y: 100, w: 540, h: 230 });
    const res = await normaliseToPlate(k.img, k.cutout, 0.8, 0.813, platePath);
    expect(await plateDeviation(res.img, platePath)).toBeNull();
    expect(res.measuredFill).toBeGreaterThan(0.85);
    await rm(platePath, { force: true });
  });

  it("gooit bij een leeg masker — geeft nooit de ongewijzigde kandidaat terug", async () => {
    const platePath = await testPlate("test-norm-leeg.png");
    const k = await kandidaat({ r: 150, g: 150, b: 150 }, { x: 150, y: 150, w: 300, h: 170 });
    const leeg = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer();
    await expect(normaliseToPlate(k.img, leeg, 0.8, 0.813, platePath)).rejects.toThrow(/leeg masker/);
    await rm(platePath, { force: true });
  });

  it("gooit als de plate ontbreekt", async () => {
    const k = await kandidaat({ r: 150, g: 150, b: 150 }, { x: 150, y: 150, w: 300, h: 170 });
    await expect(
      normaliseToPlate(k.img, k.cutout, 0.8, 0.813, "/bestaat/niet/studio-empty.jpg"),
    ).rejects.toThrow(/plate/);
  });
});
