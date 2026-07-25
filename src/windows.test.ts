import { describe, expect, it } from "vitest";
import {
  applyGreenhouse,
  applyWindowTint,
  filterBoxesOnCar,
  filterPlausibleWindowBoxes,
} from "./windows.js";

describe("filterPlausibleWindowBoxes", () => {
  const carBBox = { left: 100, top: 100, right: 1299, bottom: 799 }; // 1200×700

  it("verwerpt de hele-auto-box die Florence vaak meegeeft", () => {
    const kept = filterPlausibleWindowBoxes(
      [
        { x: 100, y: 100, w: 1200, h: 690 }, // ≈ de hele auto
        { x: 300, y: 200, w: 350, h: 160 }, // echt raam
        { x: 700, y: 210, w: 280, h: 150 }, // echt raam
      ],
      carBBox,
    );
    expect(kept).toHaveLength(2);
    expect(kept[0]!.w).toBe(350);
  });

  it("verwerpt boxes die hoger zijn dan een half autoprofiel", () => {
    const kept = filterPlausibleWindowBoxes(
      [{ x: 300, y: 150, w: 300, h: 400 }], // 57% van de bbox-hoogte
      carBBox,
    );
    expect(kept).toHaveLength(0);
  });
});

describe("filterBoxesOnCar", () => {
  it("houdt boxes op de auto en verwerpt boxes ernaast", () => {
    const alpha = new Uint8Array(100 * 100);
    for (let y = 20; y < 80; y++) {
      for (let x = 20; x < 80; x++) alpha[y * 100 + x] = 255;
    }
    const kept = filterBoxesOnCar(
      [
        { x: 30, y: 30, w: 20, h: 10 }, // midden op de auto
        { x: 0, y: 0, w: 10, h: 10 }, // buiten het masker
      ],
      alpha, 100, 100, 10,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]!.x).toBe(30);
  });
});

describe("applyWindowTint", () => {
  function setup(): { rgba: Buffer; alpha: Uint8Array; mask: Uint8Array } {
    const rgba = Buffer.alloc(4 * 4 * 4, 200); // 4×4 beeld, alles lichtgrijs
    const alpha = new Uint8Array(16).fill(255);
    const mask = new Uint8Array(16);
    return { rgba, alpha, mask };
  }
  const cfg = { tintOpacity: 0.8, tintColor: { r: 20, g: 24, b: 28 } };

  it("verdonkert alleen pixels binnen het masker, richting de tintkleur", () => {
    const { rgba, alpha, mask } = setup();
    mask[5] = 255; // één raampixel
    const tinted = applyWindowTint(rgba, alpha, mask, 4, 4, cfg);
    expect(tinted).toBe(1);
    // pixel 5: 200*(0.2) + 20*0.8 = 56
    expect(rgba[5 * 4]).toBe(56);
    expect(rgba[5 * 4 + 1]).toBeCloseTo(200 * 0.2 + 24 * 0.8, 0);
    // buurman onaangetast
    expect(rgba[4 * 4]).toBe(200);
  });

  it("weegt met de maskersterkte (zachte randen)", () => {
    const { rgba, alpha, mask } = setup();
    mask[5] = 128; // halve sterkte
    applyWindowTint(rgba, alpha, mask, 4, 4, cfg);
    const t = (128 / 255) * 0.8;
    expect(rgba[5 * 4]).toBe(Math.round(200 * (1 - t) + 20 * t));
  });

  it("raakt pixels buiten het auto-alfamasker niet aan", () => {
    const { rgba, alpha, mask } = setup();
    alpha[5] = 0;
    mask[5] = 255;
    const tinted = applyWindowTint(rgba, alpha, mask, 4, 4, cfg);
    expect(tinted).toBe(0);
    expect(rgba[5 * 4]).toBe(200);
  });
});

describe("applyGreenhouse", () => {
  const CFG = { tintOpacity: 0.68, tintColor: { r: 35, g: 40, b: 48 } };
  const PLATE = { r: 210, g: 208, b: 205 };

  /** n px glas: groene boomreflectie met een lichte streep als "wisser". */
  function glass(n: number) {
    const rgba = Buffer.alloc(n * 4);
    const alpha = new Uint8Array(n).fill(255);
    const mask = new Uint8Array(n).fill(255);
    const lowFreq = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const wiper = i === Math.floor(n / 2);
      const [r, g, b] = wiper ? [150, 150, 150] : [40, 78, 34];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
      // lage frequentie: de brede groene toon, zonder de wisser
      lowFreq[i] = Math.round(0.2126 * 40 + 0.7152 * 78 + 0.0722 * 34);
    }
    return { rgba, alpha, mask, lowFreq };
  }

  it("haalt de groene omgevingsreflectie uit het glas", () => {
    const n = 21;
    const g = glass(n);
    applyGreenhouse(g.rgba, g.alpha, g.mask, g.lowFreq, n, 1, PLATE, CFG, 1);
    // een pixel buiten de wisser: geen groenoverschot meer
    const p = 2 * 4;
    const [r, gg, b] = [g.rgba[p]!, g.rgba[p + 1]!, g.rgba[p + 2]!];
    expect(gg - Math.max(r, b)).toBeLessThan(6);
  });

  it("behoudt de glasstructuur: de wisser blijft lichter dan zijn omgeving", () => {
    const n = 21;
    const g = glass(n);
    applyGreenhouse(g.rgba, g.alpha, g.mask, g.lowFreq, n, 1, PLATE, CFG, 1);
    const mid = Math.floor(n / 2);
    const lum = (i: number) =>
      0.2126 * g.rgba[i * 4]! + 0.7152 * g.rgba[i * 4 + 1]! + 0.0722 * g.rgba[i * 4 + 2]!;
    expect(lum(mid)).toBeGreaterThan(lum(mid - 3) + 20);
  });

  it("laat glas donker: het wordt geen lichte vlek", () => {
    const n = 21;
    const g = glass(n);
    applyGreenhouse(g.rgba, g.alpha, g.mask, g.lowFreq, n, 1, PLATE, CFG, 1);
    const p = 2 * 4;
    // plate is 210 licht, maar met tintOpacity 0,68 hoort het glas donker te
    // blijven — anders leest de ruit als een gat in de auto
    expect(g.rgba[p]!).toBeLessThan(130);
  });

  /**
   * Glas met twee structuurschalen naast elkaar, zoals een echte ruit ze
   * draagt: een 1px wisserrand en een golvende modulatie over ~16px die staat
   * voor gespiegeld bladerdek. De band-pass hoort de eerste te sparen en de
   * tweede weg te halen; met één blurniveau kun je die twee niet scheiden.
   */
  function twoScaleGlass(n: number) {
    const g = glass(n);
    const fine = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const mottle = 26 * Math.sin((i / 16) * 2 * Math.PI);
      const wiper = i === Math.floor(n / 2);
      const lum = 60 + mottle + (wiper ? 90 : 0);
      const v = Math.max(0, Math.min(255, Math.round(lum)));
      g.rgba[i * 4] = v;
      g.rgba[i * 4 + 1] = v;
      g.rgba[i * 4 + 2] = v;
      g.lowFreq[i] = 60; // grove blur: middelt de golf én de wisser weg
      fine[i] = Math.max(0, Math.min(255, Math.round(60 + mottle))); // fijne blur: houdt de golf, mist de wisser
    }
    return { ...g, fine };
  }

  it("dempt de gespiegelde omgeving in het glas maar spaart de autoranden", () => {
    const n = 64;
    const g = twoScaleGlass(n);
    const lum = (b: Buffer, i: number) =>
      0.2126 * b[i * 4]! + 0.7152 * b[i * 4 + 1]! + 0.0722 * b[i * 4 + 2]!;
    const mid = Math.floor(n / 2);
    applyGreenhouse(
      g.rgba, g.alpha, g.mask, g.lowFreq, n, 1, PLATE, CFG, 1, g.fine, 0.25,
    );

    // de golf: pieken en dalen liggen op 1/4 en 3/4 van elke periode van 16px
    const swing = Math.abs(lum(g.rgba, 4) - lum(g.rgba, 12));
    expect(swing).toBeLessThan(0.4 * 52); // 52 = volle amplitude van de golf

    // de wisser steekt nog steeds ver boven zijn directe buren uit
    expect(lum(g.rgba, mid)).toBeGreaterThan(lum(g.rgba, mid - 2) + 60);
  });

  it("zonder fijne band gedraagt greenhouse zich exact als voorheen", () => {
    const n = 64;
    const a = twoScaleGlass(n);
    const b = twoScaleGlass(n);
    applyGreenhouse(a.rgba, a.alpha, a.mask, a.lowFreq, n, 1, PLATE, CFG, 1);
    applyGreenhouse(
      b.rgba, b.alpha, b.mask, b.lowFreq, n, 1, PLATE, CFG, 1, b.fine, 1,
    );
    expect(a.rgba.equals(b.rgba)).toBe(true);
  });

  it("raakt niets buiten het raammasker", () => {
    const n = 21;
    const g = glass(n);
    g.mask.fill(0);
    const before = Buffer.from(g.rgba);
    const changed = applyGreenhouse(g.rgba, g.alpha, g.mask, g.lowFreq, n, 1, PLATE, CFG, 1);
    expect(changed).toBe(0);
    expect(g.rgba.equals(before)).toBe(true);
  });
});
