import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { analyzePaint, dampEnvironmentReflections, hueDistance } from "./paint.js";

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

function damp(
  r: number,
  g: number,
  b: number,
  stats = { dominantHue: 0, medianSat: 0.02, achromatic: true },
): [number, number, number] {
  const { rgba, alpha } = pixel(r, g, b);
  dampEnvironmentReflections(rgba, alpha, 1, 1, stats, CFG);
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
