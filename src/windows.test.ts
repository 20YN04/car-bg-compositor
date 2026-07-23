import { describe, expect, it } from "vitest";
import {
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
