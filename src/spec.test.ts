import { describe, expect, it } from "vitest";
import { bouwSpec } from "./spec.js";

describe("bouwSpec", () => {
  it("beweert alleen wat er als data in gaat", () => {
    const spec = bouwSpec({ make: "Volkswagen", model: "ID.3", year: 2023 });
    expect(spec).toContain("2023 Volkswagen ID.3");
    // geen data over lak, velgen of badges → geen claims
    expect(spec).not.toMatch(/PAINT|WHEELS|BADGES/);
  });

  it("zet de bevestigde badge-lijst limitatief in de spec", () => {
    const spec = bouwSpec({
      make: "Mercedes-AMG", model: "EQE", trim: "43 4MATIC",
      badges: [
        { text: "EQE", where: "sail panel beside each mirror" },
        { text: "4MATIC", where: "front door behind the wheel arch" },
      ],
      wheelbaseM: 3.12,
    });
    expect(spec.startsWith("wielbasis: 3.12")).toBe(true);
    expect(spec).toContain("exactly these and nothing more");
    expect(spec).toContain("'4MATIC' (front door behind the wheel arch)");
  });
});
