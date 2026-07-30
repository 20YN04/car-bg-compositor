import { describe, expect, it } from "vitest";
import { parseVerdict } from "./identify.js";

describe("parseVerdict", () => {
  it("leest strikte JSON", () => {
    const v = parseVerdict('{"same_vehicle": true, "issues": []}');
    expect(v).toEqual({ sameVehicle: true, issues: [] });
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
