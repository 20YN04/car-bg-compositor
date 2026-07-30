import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { writeFile, rm } from "node:fs/promises";
import { replaceBackground } from "./background.js";

describe("replaceBackground", () => {
  it("plate exact buiten de zone, auto behouden, schaduw gemultipliceerd", async () => {
    const W = 200, H = 150;
    // kandidaat: bg 150, auto-vlak 50, schaduwband 80 onder de auto
    const cand = Buffer.alloc(W * H * 3, 150);
    const set = (x: number, y: number, v: number) => {
      const p = (y * W + x) * 3;
      cand[p] = cand[p + 1] = cand[p + 2] = v;
    };
    for (let y = 50; y < 120; y++) for (let x = 60; x < 140; x++) set(x, y, 50);
    for (let y = 120; y < 135; y++) for (let x = 60; x < 140; x++) set(x, y, 80);
    const candJpg = await sharp(cand, { raw: { width: W, height: H, channels: 3 } })
      .png().toBuffer();

    // cutout: alfa dekkend op het auto-vlak
    const cutout = await sharp(
      Buffer.from(
        `<svg width="${W}" height="${H}"><rect x="60" y="50" width="80" height="70" fill="black"/></svg>`,
      ),
    ).png().toBuffer();

    // plate: uniform 200
    const platePath = "cache/test-plate.png";
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 200, g: 200, b: 200 } } })
      .png().toFile(platePath);

    const out = await replaceBackground(candJpg, cutout, platePath);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * W + x) * 3]!;

    // hoek: exact de plate (kandidaat-bg 150 mag NIET doordrukken)
    expect(px(5, 5)).toBeGreaterThan(195);
    // autopixel: uit de kandidaat
    expect(px(100, 80)).toBeLessThan(60);
    // schaduwband: plate × (80/200) ≈ 80 — verdonkering blijft
    expect(px(100, 127)).toBeLessThan(110);
    expect(px(100, 127)).toBeGreaterThan(60);

    await rm(platePath, { force: true });
  });
});
