import { describe, expect, it } from "vitest";
import { selectBestBox } from "./mask.js";

// alleen de pure selectielogica; de fal-calls zelf worden niet getest

describe("selectBestBox", () => {
  it("kiest de grote centrale auto boven een kleine auto aan de rand", () => {
    const main = { x: 400, y: 500, w: 1200, h: 600 };
    const background = { x: 0, y: 600, w: 200, h: 100 };
    const best = selectBestBox([background, main], 2048, 1536, 0.05);
    expect(best).not.toBeNull();
    expect(best!.box.left).toBe(400);
    expect(best!.box.right).toBe(1599); // inclusieve coördinaat
    expect(best!.box.bottom).toBe(1099);
  });

  it("geeft null wanneer geen box de minimumscore haalt", () => {
    const tiny = { x: 10, y: 10, w: 50, h: 30 };
    expect(selectBestBox([tiny], 2048, 1536, 0.05)).toBeNull();
  });

  it("geeft null bij een lege detectielijst", () => {
    expect(selectBestBox([], 2048, 1536, 0.05)).toBeNull();
  });

  it("negeert boxes met ongeldige afmetingen", () => {
    expect(selectBestBox([{ x: 0, y: 0, w: 0, h: 100 }], 2048, 1536, 0)).toBeNull();
  });
});
