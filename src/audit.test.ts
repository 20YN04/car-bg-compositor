import { describe, expect, it } from "vitest";
import { auditWarnings, type CompositeAudit } from "./audit.js";

const base: CompositeAudit = {
  grainCar: 3.9,
  grainFloor: 3.7,
  grainWall: 2.1,
  grainRatio: 1.05,
  crushed: 0.26,
};

describe("auditWarnings", () => {
  it("zwijgt bij een composiet dat in de pas loopt", () => {
    expect(auditWarnings(base)).toEqual([]);
  });

  it("meldt een auto die veel korreliger is dan de scène", () => {
    // de stand vóór de sharpen-fix: 5,75 tegen 1,2
    const w = auditWarnings({ ...base, grainCar: 5.75, grainFloor: 1.2, grainRatio: 4.79 });
    expect(w.join(" ")).toContain("korrelverschil");
  });

  it("meldt ook het omgekeerde: een scène die korreliger is dan de auto", () => {
    // deze stand had ik zelf geproduceerd toen de korrelmaskering nog fout was
    const w = auditWarnings({ ...base, grainCar: 1.77, grainFloor: 3.63, grainRatio: 0.49 });
    expect(w.join(" ")).toContain("korrelverschil");
  });

  it("meldt dichtgeslagen zwart", () => {
    const w = auditWarnings({ ...base, crushed: 0.53 });
    expect(w.join(" ")).toContain("dichtgeslagen");
  });

  it("meldt niets bij een vloer zonder meting", () => {
    // grainRatio 0 betekent "niet te meten", geen defect
    expect(auditWarnings({ ...base, grainFloor: 0, grainRatio: 0 })).toEqual([]);
  });
});
