import { describe, expect, it } from "vitest";
import { paintCorrectionGains, paintDeviation, parseVerdict } from "./identify.js";

describe("parseVerdict", () => {
  it("leest strikte JSON", () => {
    const v = parseVerdict('{"same_vehicle": true, "paint_match": true, "issues": []}');
    expect(v).toEqual({ sameVehicle: true, paintMatch: true, issues: [] });
  });

  it("een expliciete lak-afkeuring komt door", () => {
    const v = parseVerdict('{"same_vehicle": true, "paint_match": false, "issues": ["paint too light"]}');
    expect(v.sameVehicle).toBe(true);
    expect(v.paintMatch).toBe(false);
  });

  it("zonder paint_match-veld beslist de meting, niet de parser", () => {
    const v = parseVerdict('{"same_vehicle": true, "issues": []}');
    expect(v.paintMatch).toBe(true);
  });

  it("overleeft code fences en proza eromheen", () => {
    const v = parseVerdict(
      'Sure! ```json\n{"same_vehicle": false, "issues": ["andere velgen", "badge weg"]}\n```',
    );
    expect(v.sameVehicle).toBe(false);
    expect(v.issues).toEqual(["andere velgen", "badge weg"]);
  });

  it("negeert niet-string issues in plaats van te crashen", () => {
    const v = parseVerdict('{"same_vehicle": true, "issues": ["ok", 3, null]}');
    expect(v.issues).toEqual(["ok"]);
  });

  it("valt zonder JSON alleen op een expliciete ja terug", () => {
    expect(parseVerdict("YES — same car.").sameVehicle).toBe(true);
    const nee = parseVerdict("This appears to be a different vehicle.");
    expect(nee.sameVehicle).toBe(false);
    // de ruwe tekst blijft als issue bewaard zodat de afkeuring uitlegbaar is
    expect(nee.issues.length).toBe(1);
  });

  it("kapotte JSON valt terug op de tekstheuristiek", () => {
    const v = parseVerdict('{"same_vehicle": true, "issues": [broken');
    expect(v.sameVehicle).toBe(true);
  });
});

describe("paintCorrectionGains", () => {
  it("legt de gemeten witte synthese exact op de bron-mediaan", () => {
    const g = paintCorrectionGains({ r: 142, g: 144, b: 149 }, { r: 117, g: 120, b: 132 });
    expect(g[0]).toBeCloseTo(117 / 142, 3);
    expect(g[1]).toBeCloseTo(120 / 144, 3);
    expect(g[2]).toBeCloseTo(132 / 149, 3);
  });

  it("de cap blokkeert een fundamenteel verkeerde kleur", () => {
    const g = paintCorrectionGains({ r: 200, g: 60, b: 60 }, { r: 117, g: 120, b: 132 });
    expect(g[0]).toBeCloseTo(1 / 1.3, 5);
    expect(g[1]).toBeCloseTo(1.3, 5);
  });
});

describe("paintDeviation", () => {
  const cfg = { minLumaRatio: 0.85, maxLumaRatio: 1.15, maxTintDelta: 0.05 };
  // ijkpunten gemeten op de EQE-set, 2026-07-30
  const bronMediaan = { r: 117, g: 120, b: 132 };

  it("de echte foto van de doelhoek passeert (ratio 1.007)", () => {
    expect(paintDeviation({ r: 114, g: 121, b: 135 }, bronMediaan, cfg)).toBeNull();
  });

  it("de te witte synthese faalt op luminantie én tint", () => {
    const issue = paintDeviation({ r: 142, g: 144, b: 149 }, bronMediaan, cfg);
    expect(issue).toMatch(/luminance/);
    expect(issue).toMatch(/tint/);
  });

  it("een te donkere kandidaat faalt op de ondergrens", () => {
    const issue = paintDeviation({ r: 90, g: 92, b: 101 }, bronMediaan, cfg);
    expect(issue).toMatch(/darker/);
  });

  it("identieke lak is per definitie schoon", () => {
    expect(paintDeviation(bronMediaan, bronMediaan, cfg)).toBeNull();
  });
});
