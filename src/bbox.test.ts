import { describe, expect, it } from "vitest";
import {
  analyzeAlpha,
  cleanAlpha,
  computeBBox,
  computeContactClusters,
  computeGroundLine,
  countBlobs,
  detectTopBump,
  erodeAlpha,
  rejectShadowBand,
  restrictAlphaToBox,
  trimAlphaBelow,
} from "./bbox.js";

const OPTS = { threshold: 10, groundPercentile: 0.95, minBlobArea: 0.005 };

function makeAlpha(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height);
}

function fillRect(
  alpha: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value = 255,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      alpha[y * width + x] = value;
    }
  }
}

describe("computeBBox", () => {
  it("vindt de exacte bbox van een rechthoek", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 20, 30, 40);
    const { bbox, area } = computeBBox(alpha, 100, 100, 10);
    expect(bbox).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
    expect(area).toBe(21 * 21);
  });

  it("negeert pixels op of onder de threshold", () => {
    const alpha = makeAlpha(50, 50);
    fillRect(alpha, 50, 5, 5, 10, 10, 10); // exact op threshold → telt niet
    fillRect(alpha, 50, 20, 20, 25, 25, 11);
    const { bbox } = computeBBox(alpha, 50, 50, 10);
    expect(bbox).toEqual({ left: 20, top: 20, right: 25, bottom: 25 });
  });

  it("geeft null bij een leeg masker", () => {
    const { bbox, area } = computeBBox(makeAlpha(50, 50), 50, 50, 10);
    expect(bbox).toBeNull();
    expect(area).toBe(0);
  });
});

describe("computeGroundLine", () => {
  it("is gelijk aan de onderkant bij een vlakke rechthoek", () => {
    const alpha = makeAlpha(200, 200);
    fillRect(alpha, 200, 20, 50, 179, 150);
    const { bbox } = computeBBox(alpha, 200, 200, 10);
    const ground = computeGroundLine(alpha, 200, 200, bbox!, 10, 0.95);
    expect(ground).toBe(150);
  });

  it("negeert een uitschieter onder de auto (percentiel-methode)", () => {
    const alpha = makeAlpha(200, 200);
    // "auto": brede rechthoek met onderkant op y=150
    fillRect(alpha, 200, 20, 50, 179, 150);
    // uitschieter: dunne sliert (3 kolommen) die 30px lager doorloopt,
    // zoals een meegemaskte slagschaduw of afhangend onderdeel
    fillRect(alpha, 200, 100, 150, 102, 180);
    const { bbox } = computeBBox(alpha, 200, 200, 10);
    expect(bbox!.bottom).toBe(180); // bbox ziet de uitschieter wél
    const ground = computeGroundLine(alpha, 200, 200, bbox!, 10, 0.95);
    expect(ground).toBe(150); // de grondlijn niet
  });

  it("volgt de bulk wanneer bijna alle kolommen lager doorlopen", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 89, 80); // 80 kolommen tot y=80
    const { bbox } = computeBBox(alpha, 100, 100, 10);
    const ground = computeGroundLine(alpha, 100, 100, bbox!, 10, 0.95);
    expect(ground).toBe(80);
  });
});

describe("countBlobs", () => {
  it("telt twee gescheiden vlakken als twee blobs", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 19, 19); // 100 px
    fillRect(alpha, 100, 60, 60, 69, 69); // 100 px
    expect(countBlobs(alpha, 100, 100, 10, 0.005)).toBe(2); // min = 50 px
  });

  it("negeert blobs onder het minimum-oppervlak", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 10, 10, 19, 19); // 100 px
    fillRect(alpha, 100, 60, 60, 61, 61); // 4 px speck
    expect(countBlobs(alpha, 100, 100, 10, 0.005)).toBe(1);
  });

  it("ziet een diagonaal gescheiden vorm als losse blobs (4-connectiviteit)", () => {
    const alpha = makeAlpha(10, 10);
    alpha[0] = 255; // (0,0)
    alpha[11] = 255; // (1,1) — alleen diagonaal verbonden
    expect(countBlobs(alpha, 10, 10, 10, 0)).toBe(2);
  });
});

describe("analyzeAlpha", () => {
  it("combineert bbox, grondlijn, oppervlak en blob-telling", () => {
    const alpha = makeAlpha(200, 200);
    fillRect(alpha, 200, 20, 50, 179, 150);
    fillRect(alpha, 200, 100, 150, 102, 180); // uitschieter
    const result = analyzeAlpha(alpha, 200, 200, OPTS);
    expect(result.bbox).toEqual({ left: 20, top: 50, right: 179, bottom: 180 });
    expect(result.groundLine).toBe(150);
    expect(result.blobCount).toBe(1);
    expect(result.area).toBeGreaterThan(0);
  });

  it("geeft een lege analyse bij een leeg masker", () => {
    const result = analyzeAlpha(makeAlpha(50, 50), 50, 50, OPTS);
    expect(result.bbox).toBeNull();
    expect(result.groundLine).toBeNull();
    expect(result.blobCount).toBe(0);
  });
});

describe("cleanAlpha", () => {
  it("verwijdert een dunne structuur die aan het object vastzit (windmolen-case)", () => {
    const alpha = makeAlpha(300, 300);
    // "auto": groot vlak
    fillRect(alpha, 300, 50, 150, 249, 249);
    // "windmolenmast": 4px brede verticale sliert, vast aan de bovenkant
    fillRect(alpha, 300, 148, 20, 151, 150);
    const { alpha: cleaned, removedArea } = cleanAlpha(alpha, 300, 300, 10, 4);
    const { bbox } = computeBBox(cleaned, 300, 300, 10);
    // de 130px lange mast is weg; op het aanhechtingspunt blijft hooguit een
    // bumpje van enkele pixels staan (inherent aan morfologische opening)
    expect(bbox!.top).toBeGreaterThanOrEqual(150 - 4);
    expect(bbox!.left).toBe(50);
    expect(bbox!.right).toBe(249);
    expect(removedArea).toBeGreaterThan(4 * 100); // ~de volledige mast
  });

  it("verwijdert een losse blob ver van het hoofdobject", () => {
    const alpha = makeAlpha(300, 300);
    fillRect(alpha, 300, 50, 150, 249, 249);
    fillRect(alpha, 300, 10, 10, 25, 25); // losstaand blokje
    const { alpha: cleaned } = cleanAlpha(alpha, 300, 300, 10, 4);
    const { bbox } = computeBBox(cleaned, 300, 300, 10);
    expect(bbox).toEqual({ left: 50, top: 150, right: 249, bottom: 249 });
  });

  it("behoudt de originele (zachte) randwaarden van het hoofdobject", () => {
    const alpha = makeAlpha(300, 300);
    fillRect(alpha, 300, 50, 150, 249, 249);
    // zachte rand: halfdoorzichtige pixelrij direct boven het vlak
    fillRect(alpha, 300, 50, 149, 249, 149, 128);
    const { alpha: cleaned } = cleanAlpha(alpha, 300, 300, 10, 4);
    expect(cleaned[149 * 300 + 100]).toBe(128); // marge-dilatatie dekt de rand
    expect(cleaned[200 * 300 + 100]).toBe(255);
  });

  it("doet niets wanneer alles zou wegeroderen", () => {
    const alpha = makeAlpha(100, 100);
    fillRect(alpha, 100, 40, 40, 44, 44); // 5×5: kleiner dan 2×radius
    const { alpha: cleaned, removedArea } = cleanAlpha(alpha, 100, 100, 10, 4);
    expect(removedArea).toBe(0);
    expect(cleaned).toBe(alpha);
  });
});

describe("restrictAlphaToBox", () => {
  const box = { left: 50, top: 100, right: 249, bottom: 249 };

  it("verwijdert maskerpixels buiten de auto-box (slagschaduw onder de box)", () => {
    const alpha = makeAlpha(300, 300);
    fillRect(alpha, 300, 50, 100, 249, 249); // auto binnen box
    fillRect(alpha, 300, 30, 250, 280, 280); // brede schaduw onder de box, vast aan de auto
    const { alpha: out, removedArea } = restrictAlphaToBox(alpha, 300, 300, box, 0.02, 10);
    const { bbox } = computeBBox(out, 300, 300, 10);
    expect(bbox!.bottom).toBeLessThanOrEqual(252); // 249 + 2% marge
    expect(removedArea).toBeGreaterThan(0);
  });

  it("verwerpt componenten met zwaartepunt buiten de box, ook binnen de marge", () => {
    const alpha = makeAlpha(300, 300);
    fillRect(alpha, 300, 50, 100, 249, 249); // auto
    // losstaand object dat nét binnen de marge begint maar er grotendeels buiten ligt
    fillRect(alpha, 300, 251, 100, 254, 140);
    const { alpha: out } = restrictAlphaToBox(alpha, 300, 300, box, 0.02, 10);
    const { bbox } = computeBBox(out, 300, 300, 10);
    expect(bbox!.right).toBe(249);
  });

  it("laat een masker dat volledig in de box ligt ongemoeid", () => {
    const alpha = makeAlpha(300, 300);
    fillRect(alpha, 300, 60, 110, 240, 240);
    const { alpha: out, removedArea } = restrictAlphaToBox(alpha, 300, 300, box, 0.02, 10);
    expect(removedArea).toBe(0);
    expect(computeBBox(out, 300, 300, 10).bbox).toEqual({
      left: 60, top: 110, right: 240, bottom: 240,
    });
  });
});

describe("rejectShadowBand", () => {
  it("negeert onderste rijen die breder zijn dan de romp (uitwaaierende schaduw)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200); // romp: 200 breed
    fillRect(alpha, 400, 40, 201, 359, 230); // schaduw: 320 breed, onderaan
    const { bbox } = computeBBox(alpha, 400, 300, 10);
    const result = rejectShadowBand(alpha, 400, 300, bbox!, 10);
    expect(result.bandHeight).toBe(30);
    expect(result.adjustedBottom).toBe(200);
    // en de grondlijn gebruikt de gecorrigeerde onderkant
    const ground = computeGroundLine(alpha, 400, 300, bbox!, 10, 0.95, result.adjustedBottom);
    expect(ground).toBe(200);
  });

  it("doet niets bij een normaal masker (banden smaller dan de romp)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200); // romp
    fillRect(alpha, 400, 130, 201, 170, 240); // wiel links
    fillRect(alpha, 400, 230, 201, 270, 240); // wiel rechts
    const { bbox } = computeBBox(alpha, 400, 300, 10);
    const result = rejectShadowBand(alpha, 400, 300, bbox!, 10);
    expect(result.bandHeight).toBe(0);
    expect(result.adjustedBottom).toBe(bbox!.bottom);
  });

  it("verwijdert nooit meer dan 25% van de bbox-hoogte", () => {
    const alpha = makeAlpha(400, 400);
    fillRect(alpha, 400, 150, 50, 249, 150); // smalle romp
    fillRect(alpha, 400, 20, 151, 379, 350); // extreem hoge brede blob eronder
    const { bbox } = computeBBox(alpha, 400, 400, 10);
    const result = rejectShadowBand(alpha, 400, 400, bbox!, 10);
    const bboxHeight = bbox!.bottom - bbox!.top + 1;
    expect(result.bandHeight).toBeLessThanOrEqual(Math.floor(bboxHeight * 0.25));
  });
});

describe("detectTopBump", () => {
  it("detecteert een smalle bult boven de daklijn (busje-dak-case)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 50, 100, 349, 250); // auto met vlakke daklijn op y=100
    fillRect(alpha, 400, 120, 60, 160, 100); // bult: 41 kolommen, 40px hoger
    const bump = detectTopBump(alpha, 400, 300, computeBBox(alpha, 400, 300, 10).bbox!, 10);
    expect(bump).not.toBeNull();
    expect(bump!.height).toBeGreaterThanOrEqual(30);
    expect(bump!.width).toBeLessThanOrEqual(60);
  });

  it("negeert een gladde daklijn zonder bult", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 50, 100, 349, 250);
    const bump = detectTopBump(alpha, 400, 300, computeBBox(alpha, 400, 300, 10).bbox!, 10);
    expect(bump).toBeNull();
  });

  it("negeert een brede geleidelijke verhoging (cabine van de auto zelf)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 50, 150, 349, 250); // motorkap/romp
    fillRect(alpha, 400, 120, 80, 300, 150); // cabine: 45% van de breedte hoger
    const bump = detectTopBump(alpha, 400, 300, computeBBox(alpha, 400, 300, 10).bbox!, 10);
    expect(bump).toBeNull(); // breder dan 30% van de bbox → geen "bult"
  });
});

describe("wielcontact-grondlijn (regressie: slagschaduw onder wiel)", () => {
  it("legt de grondlijn op de wiellijn, niet op een brede schaduwblob onder één wiel", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200); // romp
    fillRect(alpha, 400, 130, 201, 170, 240); // wiel links, contact op 240
    fillRect(alpha, 400, 230, 201, 270, 240); // wiel rechts
    // brede, rónde schaduwblob onder het linkerwiel tot 28px lager: breed
    // genoeg (>5% van de kolommen) om de percentielmethode te misleiden
    for (let i = 0; i < 24; i++) {
      const x = 133 + i;
      const depth = Math.max(1, Math.round(28 * Math.sin((Math.PI * (i + 1)) / 26)));
      fillRect(alpha, 400, x, 241, x, 240 + depth);
    }
    const result = analyzeAlpha(alpha, 400, 300, OPTS);
    // de percentiel-grondlijn zou in de schaduwblob (~250-268) uitkomen
    expect(result.groundLine).toBe(240);
    expect(result.groundTrim).toBeGreaterThan(20);
    expect(result.groundFallback).toBe(false);
    expect(result.contactClusters.length).toBeGreaterThanOrEqual(1);
    // en trimmen onder de wiellijn verwijdert precies de schaduwblob
    const removed = trimAlphaBelow(alpha, 400, 300, result.groundLine! + 2);
    expect(removed).toBeGreaterThan(100);
    expect(computeBBox(alpha, 400, 300, 10).bbox!.bottom).toBeLessThanOrEqual(242);
  });

  it("een vlak wielcontact zonder schaduw blijft ongewijzigd", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200);
    fillRect(alpha, 400, 130, 201, 170, 240);
    fillRect(alpha, 400, 230, 201, 270, 240);
    const result = analyzeAlpha(alpha, 400, 300, OPTS);
    expect(result.groundLine).toBe(240);
    expect(result.groundTrim).toBe(0);
    expect(result.contactClusters).toHaveLength(2);
  });
});

describe("computeContactClusters", () => {
  it("vindt twee wielcontact-clusters bij een zijaanzicht", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200); // romp
    fillRect(alpha, 400, 130, 201, 170, 240); // wiel links
    fillRect(alpha, 400, 230, 201, 270, 240); // wiel rechts
    const { bbox } = computeBBox(alpha, 400, 300, 10);
    const clusters = computeContactClusters(alpha, 400, 300, bbox!, bbox!.bottom, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toEqual({ x0: 130, x1: 170, y: 240 });
    expect(clusters[1]).toEqual({ x0: 230, x1: 270, y: 240 });
  });

  it("geeft per cluster het eigen contactniveau (3/4-view: verre wiel hoger)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200);
    fillRect(alpha, 400, 130, 201, 170, 240); // nabij wiel: y=240
    fillRect(alpha, 400, 230, 201, 270, 234); // ver wiel: y=234 (binnen contactdiepte)
    const { bbox } = computeBBox(alpha, 400, 300, 10);
    const clusters = computeContactClusters(alpha, 400, 300, bbox!, bbox!.bottom, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.y).toBe(240);
    expect(clusters[1]!.y).toBe(234);
  });

  it("negeert rijen onder de gecorrigeerde onderkant (schaduwband)", () => {
    const alpha = makeAlpha(400, 300);
    fillRect(alpha, 400, 100, 50, 299, 200);
    fillRect(alpha, 400, 130, 201, 170, 240); // wielen
    fillRect(alpha, 400, 230, 201, 270, 240);
    fillRect(alpha, 400, 60, 241, 339, 270); // schaduwband eronder
    const { bbox } = computeBBox(alpha, 400, 300, 10);
    const clusters = computeContactClusters(alpha, 400, 300, bbox!, 240, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.y).toBe(240);
  });
});

describe("erodeAlpha", () => {
  it("krimpt een vlak met 1px aan alle kanten", () => {
    const alpha = makeAlpha(20, 20);
    fillRect(alpha, 20, 5, 5, 14, 14);
    const eroded = erodeAlpha(alpha, 20, 20);
    const { bbox } = computeBBox(eroded, 20, 20, 10);
    expect(bbox).toEqual({ left: 6, top: 6, right: 13, bottom: 13 });
  });
});
