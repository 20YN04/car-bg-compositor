import { describe, expect, it } from "vitest";
import type { BBox } from "./bbox.js";
import { computePlacement } from "./composite.js";

const CANVAS = { width: 1920, height: 1440 };
const GROUND_Y = 1200;
const RATIO = 0.82;

describe("computePlacement", () => {
  it("schaalt de bbox-breedte naar de opgegeven fractie van het canvas", () => {
    const bbox: BBox = { left: 100, top: 200, right: 899, bottom: 599 };
    const p = computePlacement(bbox, 599, CANVAS, GROUND_Y, RATIO);
    expect(p.width).toBeCloseTo(1920 * 0.82);
    expect(p.scale).toBeCloseTo((1920 * 0.82) / 800);
  });

  it("centreert horizontaal", () => {
    const bbox: BBox = { left: 0, top: 0, right: 799, bottom: 399 };
    const p = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO);
    expect(p.x).toBeCloseTo((1920 - p.width) / 2);
    expect(p.x + p.width / 2).toBeCloseTo(1920 / 2);
  });

  it("laat de grondlijn exact op GROUND_Y landen", () => {
    const bbox: BBox = { left: 50, top: 100, right: 849, bottom: 519 };
    const groundLine = 500; // 20px boven bbox.bottom (uitschieter genegeerd)
    const p = computePlacement(bbox, groundLine, CANVAS, GROUND_Y, RATIO);
    expect(p.y + (groundLine - bbox.top + 1) * p.scale).toBeCloseTo(GROUND_Y);
    // de uitschieter onder de grondlijn steekt dus onder GROUND_Y uit
    expect(p.y + p.height).toBeGreaterThan(GROUND_Y);
  });

  it("lijnt een SUV en een sportwagen op dezelfde grondlijn uit", () => {
    // beide even breed, maar de SUV is veel hoger
    const suv: BBox = { left: 0, top: 0, right: 999, bottom: 599 };
    const sport: BBox = { left: 0, top: 0, right: 999, bottom: 349 };
    const pSuv = computePlacement(suv, 599, CANVAS, GROUND_Y, RATIO);
    const pSport = computePlacement(sport, 349, CANVAS, GROUND_Y, RATIO);
    // zelfde onderkant (grondlijn = bbox.bottom hier), verschillende bovenkant
    expect(pSuv.y + pSuv.height).toBeCloseTo(pSport.y + pSport.height);
    expect(pSuv.y).toBeLessThan(pSport.y);
    // en beide staan exact op GROUND_Y
    expect(pSuv.y + pSuv.height).toBeCloseTo(GROUND_Y);
  });

  it("markeert plaatsing buiten het canvas", () => {
    // extreem hoge bbox (aspect < 1): na schalen op breedte steekt hij boven
    // het canvas uit
    const tall: BBox = { left: 0, top: 0, right: 199, bottom: 999 };
    const p = computePlacement(tall, 999, CANVAS, GROUND_Y, RATIO);
    expect(p.outOfCanvas).toBe(true);

    const normal: BBox = { left: 0, top: 0, right: 999, bottom: 399 };
    const pNormal = computePlacement(normal, 399, CANVAS, GROUND_Y, RATIO);
    expect(pNormal.outOfCanvas).toBe(false);
  });

  it("respecteert een aangepaste CAR_WIDTH_RATIO", () => {
    const bbox: BBox = { left: 0, top: 0, right: 499, bottom: 249 };
    const p = computePlacement(bbox, 249, CANVAS, GROUND_Y, 0.5);
    expect(p.width).toBeCloseTo(960);
  });
});
