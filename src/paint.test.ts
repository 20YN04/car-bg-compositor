import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import {
  analyzePaint,
  dampEnvironmentReflections,
  hueDistance,
  localContrastMap,
} from "./paint.js";

const CFG = defaultConfig.PAINT;

/** Eén pixel als 1×1-beeld, zodat de kleurmath los te controleren is. */
function pixel(r: number, g: number, b: number) {
  const rgba = Buffer.alloc(4);
  rgba[0] = r;
  rgba[1] = g;
  rgba[2] = b;
  rgba[3] = 255;
  return { rgba, alpha: new Uint8Array([255]) };
}

// Deze helper toetst de KLEURlogica (tint, verzadiging, bescherming) op één
// pixel. De structuurweging staat daarbij uit: een enkele pixel heeft per
// definitie geen lokaal contrast, dus selectief dempen zou hier altijd nul
// opleveren en niets zeggen over de kleurmath. De selectieve weging heeft
// eigen tests hieronder.
function damp(
  r: number,
  g: number,
  b: number,
  stats = { dominantHue: 0, medianSat: 0.02, achromatic: true },
): [number, number, number] {
  const { rgba, alpha } = pixel(r, g, b);
  dampEnvironmentReflections(rgba, alpha, 1, 1, stats, { ...CFG, selective: false });
  return [rgba[0]!, rgba[1]!, rgba[2]!];
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe("hueDistance", () => {
  it("rekent over de kleurencirkel heen", () => {
    expect(hueDistance(10, 350)).toBe(20);
    expect(hueDistance(0, 180)).toBe(180);
    expect(hueDistance(90, 90)).toBe(0);
  });
});

describe("analyzePaint", () => {
  it("herkent een zwarte auto als achromatisch", () => {
    const n = 100;
    const rgba = Buffer.alloc(n * 4);
    const alpha = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = 40;
      rgba[i * 4 + 1] = 41;
      rgba[i * 4 + 2] = 42;
    }
    expect(analyzePaint(rgba, alpha, 10, 10, CFG).achromatic).toBe(true);
  });

  it("vindt de dominante tint van een gekleurde auto ondanks een fel accent", () => {
    // 96 blauwe lakpixels + 4 felrode achterlichtpixels: de mediaan mag niet
    // naar rood schuiven
    const n = 100;
    const rgba = Buffer.alloc(n * 4);
    const alpha = new Uint8Array(n).fill(255);
    for (let i = 0; i < n; i++) {
      const red = i < 4;
      rgba[i * 4] = red ? 200 : 40;
      rgba[i * 4 + 1] = red ? 20 : 70;
      rgba[i * 4 + 2] = red ? 25 : 160;
    }
    const stats = analyzePaint(rgba, alpha, 10, 10, CFG);
    expect(stats.achromatic).toBe(false);
    // blauw ligt rond 220 graden
    expect(hueDistance(stats.dominantHue, 220)).toBeLessThan(25);
  });
});

describe("dampEnvironmentReflections", () => {
  it("dempt een groene boomreflectie op zwarte lak", () => {
    const before: [number, number, number] = [30, 55, 25];
    const after = damp(...before);
    const satOf = (c: number[]) => {
      const max = Math.max(...c);
      return max === 0 ? 0 : (max - Math.min(...c)) / max;
    };
    expect(satOf(after)).toBeLessThan(satOf(before) * 0.5);
  });

  it("behoudt de helderheid: alleen de kleur verdwijnt", () => {
    // naar het maximumkanaal trekken zou de pixel oplichten; naar de
    // luminantie houdt de lichtverdeling — en dus de vorm — intact
    const before: [number, number, number] = [30, 55, 25];
    const after = damp(...before);
    expect(lum(...after)).toBeCloseTo(lum(...before), 0);
  });

  it("laat een achterlichtrood ongemoeid", () => {
    const before: [number, number, number] = [190, 25, 30];
    expect(damp(...before)).toEqual(before);
  });

  it("laat neutrale zwarte lak ongemoeid", () => {
    const before: [number, number, number] = [38, 39, 40];
    expect(damp(...before)).toEqual(before);
  });

  it("laat bijna-zwarte pixels ongemoeid — daar is de tint ruis", () => {
    const before: [number, number, number] = [4, 12, 6];
    expect(damp(...before)).toEqual(before);
  });

  it("spaart de eigen lakkleur van een gekleurde auto", () => {
    // blauwe auto: blauwe lak blijft, groene boomreflectie wordt gedempt
    const blauw = { dominantHue: 220, medianSat: 0.75, achromatic: false };
    const lak: [number, number, number] = [40, 70, 160];
    expect(damp(...lak, blauw)).toEqual(lak);

    const groen: [number, number, number] = [40, 90, 35];
    const na = damp(...groen, blauw);
    expect(na).not.toEqual(groen);
  });

  it("doet niets wanneer uitgeschakeld", () => {
    const { rgba, alpha } = pixel(30, 55, 25);
    const n = dampEnvironmentReflections(
      rgba,
      alpha,
      1,
      1,
      { dominantHue: 0, medianSat: 0.02, achromatic: true },
      { ...CFG, enabled: false },
    );
    expect(n).toBe(0);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([30, 55, 25]);
  });
});

describe("selectieve demping", () => {
  /** n×n vlak met optioneel een gestreept patroon erin. */
  function field(n: number, base: [number, number, number], striped: boolean) {
    const rgba = Buffer.alloc(n * n * 4);
    const alpha = new Uint8Array(n * n).fill(255);
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      // strepen van 4px: structuur op dezelfde schaal als bladerdek
      const lift = striped && Math.floor(x / 4) % 2 === 0 ? 26 : 0;
      rgba[i * 4] = Math.min(255, base[0] + lift);
      rgba[i * 4 + 1] = Math.min(255, base[1] + lift);
      rgba[i * 4 + 2] = Math.min(255, base[2] + lift);
      rgba[i * 4 + 3] = 255;
    }
    return { rgba, alpha };
  }

  const STATS = { dominantHue: 0, medianSat: 0.02, achromatic: true };

  it("meet vlak als laag contrast en patroon als hoog", () => {
    const n = 48;
    const flat = field(n, [40, 70, 35], false);
    const pat = field(n, [40, 70, 35], true);
    const mean = (m: Float32Array) => m.reduce((s, v) => s + v, 0) / m.length;
    const cFlat = mean(localContrastMap(flat.rgba, flat.alpha, n, n, 6));
    const cPat = mean(localContrastMap(pat.rgba, pat.alpha, n, n, 6));
    expect(cPat).toBeGreaterThan(cFlat * 4);
  });

  it("dempt een gestructureerde reflectie sterker dan een egale zweem", () => {
    const n = 48;
    const flat = field(n, [40, 70, 35], false);
    const pat = field(n, [40, 70, 35], true);
    const satOf = (o: { rgba: Buffer }, i: number) => {
      const p = i * 4;
      const c = [o.rgba[p]!, o.rgba[p + 1]!, o.rgba[p + 2]!];
      const mx = Math.max(...c);
      return mx === 0 ? 0 : (mx - Math.min(...c)) / mx;
    };
    const centre = (n / 2) * n + n / 2;
    const satFlatBefore = satOf(flat, centre);
    const satPatBefore = satOf(pat, centre);

    dampEnvironmentReflections(flat.rgba, flat.alpha, n, n, STATS, CFG);
    dampEnvironmentReflections(pat.rgba, pat.alpha, n, n, STATS, CFG);

    const droppedFlat = satFlatBefore - satOf(flat, centre);
    const droppedPat = satPatBefore - satOf(pat, centre);
    expect(droppedPat).toBeGreaterThan(droppedFlat);
  });

  it("uniform dempen blijft beschikbaar via selective: false", () => {
    const n = 48;
    const a = field(n, [40, 70, 35], false);
    const b = field(n, [40, 70, 35], false);
    const nSel = dampEnvironmentReflections(a.rgba, a.alpha, n, n, STATS, CFG);
    const nUni = dampEnvironmentReflections(b.rgba, b.alpha, n, n, STATS, {
      ...CFG,
      selective: false,
    });
    // uniform raakt minstens zoveel pixels als selectief
    expect(nUni).toBeGreaterThanOrEqual(nSel);
  });
});
