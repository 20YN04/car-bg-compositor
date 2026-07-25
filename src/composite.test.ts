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
  decideLevel,
  contactYForWheels,
  generateDefaultBackground,
  mapRectToCanvas,
  scaleFromWheel,
  sweepLuminance,
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

  it("spiegelt de ONDERKANT van de auto in de vloerreflectie, niet het dak", async () => {
    // auto met een ondubbelzinnig verschil tussen boven- en onderhelft:
    // dak puur blauw, onderkant puur rood. Onder de contactlijn hoort dus
    // rood te verschijnen. sharp voert extract vóór flip uit, dus een
    // flip().extract()-keten in één pipeline levert hier blauw op.
    const srcW = 400;
    const srcH = 200;
    const rgba = Buffer.alloc(srcW * srcH * 4);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const i = (y * srcW + x) * 4;
        if (y < srcH / 2) rgba[i + 2] = 255; // dak = blauw
        else rgba[i] = 255; // onderkant = rood
        rgba[i + 3] = 255;
      }
    }

    const bbox: BBox = { left: 0, top: 0, right: srcW - 1, bottom: srcH - 1 };
    const cfg: Config = structuredClone(defaultConfig);
    // reflectie sterk en hoog genoeg om ondubbelzinnig te meten
    cfg.DEFAULT_PROFILE = {
      ...cfg.DEFAULT_PROFILE,
      floorReflectivity: 1,
      reflectionHeightRatio: 0.3,
      glowStrength: 0,
      vignetteStrength: 0,
    };
    cfg.FINISH = { ...cfg.FINISH, enabled: false };
    const placement = computePlacement(
      bbox, srcH - 1, cfg.CANVAS, GROUND_Y, cfg.CAR_WIDTH_RATIO,
    );

    const dir = await mkdtemp(path.join(tmpdir(), "cbc-refl-"));
    const bgPath = path.join(dir, "bg.png");
    await generateDefaultBackground(bgPath, cfg.CANVAS);

    const { image } = await compositeImage(
      {
        rgba, width: srcW, height: srcH, bbox, placement, backgroundPath: bgPath,
        profile: cfg.DEFAULT_PROFILE, contactY: GROUND_Y,
      },
      cfg,
    );
    const { data, info } = await sharp(image).raw().toBuffer({ resolveWithObject: true });

    // net onder de contactlijn, in het midden van de auto
    const x = Math.round(placement.x + placement.width / 2);
    const y = GROUND_Y + 6;
    const i = (y * info.width + x) * info.channels;
    const r = data[i] ?? 0;
    const b = data[i + 2] ?? 0;
    expect(r).toBeGreaterThan(b);
  });

  it("respecteert een aangepaste CAR_WIDTH_RATIO", () => {
    const bbox: BBox = { left: 0, top: 0, right: 499, bottom: 249 };
    const p = computePlacement(bbox, 249, CANVAS, GROUND_Y, 0.5);
    expect(p.width).toBeCloseTo(960);
  });
});

describe("scaleFromWheel", () => {
  const NOMINAL = 0.7;
  const FLOOR = 314; // px per meter, showroom-plate

  it("schaalt zodat het wiel op zijn werkelijke maat uitkomt", () => {
    // wiel van 200px moet 0,7 m * 314 px/m = 220px worden
    const s = scaleFromWheel([{ x: 0, y: 0, w: 200, h: 200 }], NOMINAL, FLOOR);
    expect(s).toBeCloseTo(219.8 / 200, 3);
  });

  it("neemt het nabije (grootste) wiel, niet het verre", () => {
    // bij een 3/4-hoek is het verre wiel kleiner; dat als maatlat nemen zou
    // de auto te groot maken
    const s = scaleFromWheel(
      [{ x: 0, y: 0, w: 120, h: 120 }, { x: 0, y: 0, w: 200, h: 200 }],
      NOMINAL, FLOOR,
    );
    expect(s).toBeCloseTo(219.8 / 200, 3);
  });

  it("gebruikt de langste zijde: een schuin wiel is in de breedte samengedrukt", () => {
    const s = scaleFromWheel([{ x: 0, y: 0, w: 90, h: 200 }], NOMINAL, FLOOR);
    expect(s).toBeCloseTo(219.8 / 200, 3);
  });

  it("geeft null zonder bruikbare wielen — de aanroeper valt dan terug", () => {
    expect(scaleFromWheel([], NOMINAL, FLOOR)).toBeNull();
    expect(scaleFromWheel([{ x: 0, y: 0, w: 4, h: 4 }], NOMINAL, FLOOR)).toBeNull();
  });

  it("maakt twee hoeken van dezelfde auto even groot", () => {
    // zelfde auto, zijaanzicht (wiel 210px) en vooraanzicht (wiel 150px):
    // na schaling is het wiel in beide even groot, dus ook de auto
    const zij = scaleFromWheel([{ x: 0, y: 0, w: 210, h: 210 }], NOMINAL, FLOOR)!;
    const voor = scaleFromWheel([{ x: 0, y: 0, w: 150, h: 150 }], NOMINAL, FLOOR)!;
    expect(210 * zij).toBeCloseTo(150 * voor, 3);
  });
});

describe("contactYForWheels", () => {
  const bbox: BBox = { left: 0, top: 0, right: 999, bottom: 499 };
  const HORIZON = 879;
  const CONTACT = 1195;

  it("laat een zijaanzicht ongemoeid: beide wielen staan al onder de horizon", () => {
    // twee contacten op vrijwel dezelfde hoogte, ruim onder de horizon
    const clusters = [
      { x0: 100, x1: 200, y: 495 },
      { x0: 700, x1: 800, y: 497 },
    ];
    const y = contactYForWheels(clusters, bbox, CONTACT, 1, 700, HORIZON, 20);
    expect(y).toBe(CONTACT);
  });

  it("verdiept de contactlijn wanneer het verre wiel boven de horizon zou landen", () => {
    // verre wiel 300px hoger: precies het geval dat de config handmatig
    // wegwerkte met een vaste diepere contactlijn
    const clusters = [
      { x0: 100, x1: 200, y: 495 },
      { x0: 700, x1: 800, y: 195 },
    ];
    const y = contactYForWheels(clusters, bbox, CONTACT, 1, 700, HORIZON, 20);
    expect(y).toBeGreaterThan(CONTACT);
    // het verre wiel landt daarna exact op de marge onder de horizon
    expect(700 + (195 - 0 + 1) * 1 + (y - CONTACT)).toBeCloseTo(HORIZON + 20, 5);
  });

  it("doet niets zonder horizon of zonder wielcontacten", () => {
    const clusters = [{ x0: 100, x1: 200, y: 195 }];
    expect(contactYForWheels(clusters, bbox, CONTACT, 1, 700, null, 20)).toBe(CONTACT);
    expect(contactYForWheels([], bbox, CONTACT, 1, 700, HORIZON, 20)).toBe(CONTACT);
  });
});

describe("horizontalBias", () => {
  const bbox: BBox = { left: 0, top: 0, right: 999, bottom: 399 };

  it("centreert bij 0,5 — het oude gedrag blijft de default", () => {
    const zonder = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO);
    const met = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO, 0.5);
    expect(met.x).toBeCloseTo(zonder.x);
    expect(met.x + met.width / 2).toBeCloseTo(CANVAS.width / 2);
  });

  it("zet het middelpunt op de opgegeven fractie", () => {
    // de cutout-referenties zetten het middelpunt op ~45%, links van het
    // midden, met ruimte rechts voor plaat en badge
    const p = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO, 0.45);
    expect(p.x + p.width / 2).toBeCloseTo(CANVAS.width * 0.45);
    expect(p.x).toBeLessThan(computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO).x);
  });

  it("laat de schaal ongemoeid: alleen de positie verschuift", () => {
    const a = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO, 0.5);
    const b = computePlacement(bbox, 399, CANVAS, GROUND_Y, RATIO, 0.35);
    expect(b.scale).toBeCloseTo(a.scale);
    expect(b.width).toBeCloseTo(a.width);
    expect(b.y).toBeCloseTo(a.y);
  });
});

/**
 * De studio-sweep is gekalibreerd op de live Carredo-listings (Taycan,
 * 1248x832, alle zes de studiobeelden). Deze test legt die kalibratie vast:
 * gaat er iemand aan een parameter draaien, dan laat dit zien wat er stukgaat
 * en niet alleen dát er iets stukging.
 *
 * Alleen punten op de kále achtergrond. Meetpunten binnen de spiegelzone van
 * hun auto (rond y=620 in het middenveld) staan er bewust NIET in: die zijn
 * door de auto verdonkerd en zeggen niets over de achtergrond.
 */
describe("sweepLuminance tegen de gemeten referentie", () => {
  const CANVAS = { width: 1248, height: 832 };
  const P = defaultConfig.SWEEP;
  const REF: [string, number, number, number][] = [
    ["wand midden boven", 624, 20, 145],
    ["wand midden", 624, 100, 189],
    ["wand midden laag", 624, 220, 226],
    ["wand rand boven", 40, 20, 97],
    ["wand rand", 40, 100, 109],
    ["wand rand laag", 40, 220, 149],
    ["wand rand horizon", 40, 300, 158],
    ["vloer links", 30, 620, 128],
    ["vloer links lager", 30, 740, 107],
    ["vloer onderhoek", 30, 820, 93],
    ["vloer rechts", 1215, 680, 119],
    ["lichtpoel onder de auto", 624, 790, 203],
    ["vouwlijn op de naad", 40, 458, 114],
  ];

  for (const [naam, x, y, want] of REF) {
    it(`${naam} (${x},${y}) ligt op ${want}`, () => {
      expect(sweepLuminance(x, y, CANVAS, P)).toBeCloseTo(want, -1.1);
    });
  }

  it("heeft geen stap op de naad aan de zijkanten", () => {
    // Alleen aan de zijkanten, want alleen daar is de naad in hun beelden
    // onbedekt en dus meetbaar: 148 boven de naad tegen 141 eronder.
    //
    // In het midden staat er bij hen wél een stap (wand ~228 tegen vloer
    // ~165), maar die zit in elk van hun zes beelden achter de auto. Hier een
    // aansluiting eisen zou een eis zijn die de referentie zelf niet haalt.
    //
    // De zijkanten waren precies waar het zichtbare defect zat: de radiale
    // vloergradient maakte de vloer daar 82 onder een wand van 163.
    for (const x of [40, 1210]) {
      const boven = sweepLuminance(x, 440, CANVAS, P);
      const onder = sweepLuminance(x, 480, CANVAS, P);
      expect(Math.abs(boven - onder)).toBeLessThan(20);
    }
  });
});

describe("computeReflectionRect met een gebroken contactlijn", () => {
  const CANVAS = { width: 1248, height: 832 };
  const PLACEMENT = { x: 100.4, y: 200.2, width: 900.7, height: 500.3, scale: 1.4, outOfCanvas: false };

  it("levert gehele getallen, ook als de reflectie de onderrand raakt", () => {
    // contactY komt uit de wielmeting en is zelden rond. Zolang de reflectie
    // ruim boven de onderrand eindigt valt dat niet op, want dan wint de
    // afgeronde hoogte de Math.min. Zodra hij de rand raakt wint de clamp en
    // gaat er een gebroken hoogte naar sharp — die weigert dat.
    const r = computeReflectionRect(PLACEMENT, 649.68, CANVAS, 0.5);
    expect(r).not.toBeNull();
    for (const [k, v] of Object.entries(r!)) {
      expect(Number.isInteger(v), `${k} is ${v}`).toBe(true);
    }
  });

  it("blijft binnen het canvas", () => {
    const r = computeReflectionRect(PLACEMENT, 649.68, CANVAS, 0.5)!;
    expect(r.top + r.height).toBeLessThanOrEqual(CANVAS.height);
    expect(r.left + r.width).toBeLessThanOrEqual(CANVAS.width);
  });
});

/**
 * Gemeten op de dertien Taycan-bronfoto's. De poort moet scheefstand van
 * perspectief scheiden, en dat is het hele punt: bij een 3/4-aanzicht hóórt
 * het verre wiel hoger in beeld te staan.
 */
describe("decideLevel", () => {
  const CFG = defaultConfig.LEVEL;
  const bbox = (w: number, h: number): BBox => ({
    left: 0, top: 0, right: w - 1, bottom: h - 1,
  });
  // wielbasis van 827 px, zoals gemeten op beeld (8)
  const wielen = (dy: number) => [
    { x0: 337, x1: 585, y: 853 },
    { x0: 1194, x1: 1382, y: 853 + dy },
  ];

  it("zet een scheve profielopname recht", () => {
    // beeld (8): achterwiel 51 px hoger, bbox-aspect 2,96
    const d = decideLevel(wielen(-51), bbox(1420, 480), CFG);
    expect(d.applied).toBe(true);
    // wiellijn loopt omhoog naar rechts, dus tegen de klok in gemeten hoek;
    // de correctie draait met de klok mee
    expect(d.rotate).toBeCloseTo(3.53, 1);
  });

  it("laat een 3/4-aanzicht met stok en al staan", () => {
    // beeld (5): 24,3 graden, bbox-aspect 2,04 — beide poorten dicht
    const d = decideLevel(wielen(373), bbox(980, 480), CFG);
    expect(d.applied).toBe(false);
    expect(d.reason).toContain("aspect");
  });

  it("weigert ook een profielopname met een onmogelijke hoek", () => {
    // aspect in orde, maar 20 graden is geen scheve opname meer
    const d = decideLevel(wielen(301), bbox(1420, 480), CFG);
    expect(d.applied).toBe(false);
    expect(d.reason).toContain("maximum");
  });

  it("doet niets bij één wielcontact", () => {
    const d = decideLevel([{ x0: 337, x1: 585, y: 853 }], bbox(1420, 480), CFG);
    expect(d.applied).toBe(false);
  });

  it("meet over de buitenste twee contacten, niet over de eerste twee", () => {
    // drie clusters, waarvan de eerste twee dicht bij elkaar: over die korte
    // basis is dezelfde pixelmeetfout een veel grotere hoek
    const drie = [
      { x0: 337, x1: 585, y: 853 },
      { x0: 600, x1: 700, y: 851 },
      { x0: 1194, x1: 1382, y: 802 },
    ];
    const d = decideLevel(drie, bbox(1420, 480), CFG);
    expect(d.rotate).toBeCloseTo(3.53, 1);
  });
});
