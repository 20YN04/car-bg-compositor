import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { BBox } from "./bbox.js";
import { defaultConfig, type Config } from "./config.js";
import {
  buildContactShadows,
  compositeImage,
  computePlacement,
  computeReflectionRect,
  generateDefaultBackground,
  mapRectToCanvas,
} from "./composite.js";

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

  it("golden: wielcontact landt op GROUND_Y zonder zweefgap (echte compositing)", async () => {
    // synthetische rode "auto": romp + twee wielen met contact op y=239
    const srcW = 400;
    const srcH = 300;
    const rgba = Buffer.alloc(srcW * srcH * 4);
    const paint = (x0: number, y0: number, x1: number, y1: number): void => {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = (y * srcW + x) * 4;
          rgba[i] = 255; // puur rood, ondubbelzinnig t.o.v. achtergrond/schaduw
          rgba[i + 3] = 255;
        }
      }
    };
    paint(100, 50, 299, 200); // romp
    paint(130, 201, 170, 239); // wiel links
    paint(230, 201, 270, 239); // wiel rechts

    const bbox: BBox = { left: 100, top: 50, right: 299, bottom: 239 };
    const groundLine = 239;
    const cfg: Config = structuredClone(defaultConfig);
    const placement = computePlacement(
      bbox, groundLine, cfg.CANVAS, cfg.GROUND_Y, cfg.CAR_WIDTH_RATIO,
    );

    const dir = await mkdtemp(path.join(tmpdir(), "cbc-golden-"));
    const bgPath = path.join(dir, "bg.png");
    await generateDefaultBackground(bgPath, cfg.CANVAS);

    const { image: jpeg } = await compositeImage(
      {
        rgba, width: srcW, height: srcH, bbox, placement, backgroundPath: bgPath,
        profile: cfg.DEFAULT_PROFILE, contactY: cfg.GROUND_Y,
      },
      cfg,
    );
    const { data, info } = await sharp(jpeg)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const isRed = (x: number, y: number): boolean => {
      const i = (y * info.width + x) * info.channels;
      return (data[i] ?? 0) > 150 && (data[i + 1] ?? 0) < 120;
    };
    // kolom door het midden van het linkerwiel, in canvascoördinaten
    const wheelX = Math.round(placement.x + (150 - bbox.left) * placement.scale);
    let lowestRed = -1;
    for (let y = cfg.CANVAS.height - 1; y >= 0; y--) {
      if (isRed(wheelX, y)) {
        lowestRed = y;
        break;
      }
    }
    // de onderkant van het wiel (grondlijnrij) hoort op GROUND_Y-1 te liggen
    // (de onderrand van die pixelrij raakt GROUND_Y); ±2px voor resize-afronding
    expect(Math.abs(lowestRed - (cfg.GROUND_Y - 1))).toBeLessThanOrEqual(2);
    // geen zweefgap: vlak boven het contact is het wiel aaneengesloten rood
    expect(isRed(wheelX, lowestRed - 3)).toBe(true);
    expect(isRed(wheelX, lowestRed - 10)).toBe(true);
  });

  it("beeldt een bronrechthoek (nummerplaat) correct af op het canvas", () => {
    const bbox: BBox = { left: 100, top: 200, right: 899, bottom: 599 };
    const p = computePlacement(bbox, 599, CANVAS, GROUND_Y, RATIO);
    // plaat van 100×20 die precies op de linkerbovenhoek van de bbox begint
    const rect = mapRectToCanvas({ x: 100, y: 200, w: 100, h: 20 }, bbox, p);
    expect(rect.x).toBeCloseTo(p.x);
    expect(rect.y).toBeCloseTo(p.y);
    expect(rect.width).toBeCloseTo(100 * p.scale);
    expect(rect.height).toBeCloseTo(20 * p.scale);
    // en het bbox-midden komt uit op het canvasmidden (horizontaal gecentreerd)
    const mid = mapRectToCanvas({ x: 500, y: 400, w: 0, h: 0 }, bbox, p);
    expect(mid.x).toBeCloseTo(1920 / 2);
  });

  it("zet een contactschaduw-cluster op de eigen geschaalde contacthoogte", () => {
    const bbox: BBox = { left: 100, top: 50, right: 299, bottom: 240 };
    const groundLine = 240;
    const p = computePlacement(bbox, groundLine, CANVAS, GROUND_Y, RATIO);
    const shadows = buildContactShadows(
      [
        { x0: 130, x1: 170, y: 240 }, // nabij wiel op de grondlijn
        { x0: 230, x1: 270, y: 234 }, // ver wiel iets hoger
      ],
      bbox,
      p,
      defaultConfig,
    );
    // het nabije wiel (y = grondlijn) landt op GROUND_Y + de poel-offset
    const poolOffset = defaultConfig.SHADOW.height * 0.3 * 0.4;
    expect(shadows[0]!.cy).toBeCloseTo(
      GROUND_Y + defaultConfig.SHADOW.offsetY + poolOffset,
    );
    // het verre wiel krijgt zijn schaduw hoger, met precies de geschaalde afstand
    expect(shadows[0]!.cy - shadows[1]!.cy).toBeCloseTo(6 * p.scale);
  });

  it("berekent de vloerreflectie-geometrie vanaf de contactlijn", () => {
    const bbox: BBox = { left: 0, top: 0, right: 999, bottom: 499 };
    const p = computePlacement(bbox, 499, CANVAS, GROUND_Y, RATIO);
    const rect = computeReflectionRect(p, GROUND_Y, CANVAS, 0.35);
    expect(rect).not.toBeNull();
    expect(rect!.top).toBe(GROUND_Y);
    // geklemd op de canvasonderrand
    expect(rect!.height).toBe(Math.min(Math.round(p.height * 0.35), 1440 - GROUND_Y));
    expect(rect!.left).toBe(Math.max(0, Math.round(p.x)));
  });

  it("geeft null wanneer er geen zichtbare reflectieruimte is", () => {
    const bbox: BBox = { left: 0, top: 0, right: 999, bottom: 499 };
    const p = computePlacement(bbox, 499, CANVAS, 1439, RATIO);
    expect(computeReflectionRect(p, 1439, CANVAS, 0.35)).toBeNull();
  });

  it("respecteert een aangepaste CAR_WIDTH_RATIO", () => {
    const bbox: BBox = { left: 0, top: 0, right: 499, bottom: 249 };
    const p = computePlacement(bbox, 249, CANVAS, GROUND_Y, 0.5);
    expect(p.width).toBeCloseTo(960);
  });
});
