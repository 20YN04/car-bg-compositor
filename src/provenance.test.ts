import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config.js";
import { activeOperations, buildProvenance, provenanceXmp } from "./provenance.js";

describe("buildProvenance", () => {
  it("claimt pixelbehoud alleen zonder generatieve stap", () => {
    const zonder = buildProvenance(
      { generative: false, models: [], operations: [] },
      defaultConfig,
    );
    expect(zonder["carbg:vehiclePixelsPreserved"]).toBe("true");
    expect(zonder["carbg:generative"]).toBe("false");

    const met = buildProvenance(
      { generative: true, models: ["fal-ai/flux-pro/v1/fill"], operations: [] },
      defaultConfig,
    );
    // met een generatieve scene is de garantie niet meer waar; hem dan tóch
    // claimen zou de registratie waardeloos maken
    expect(met["carbg:vehiclePixelsPreserved"]).toBe("false");
    expect(met["carbg:claim"]).toContain("AI gegenereerde");
  });
});

describe("activeOperations", () => {
  it("noemt alleen stappen die daadwerkelijk liepen", () => {
    const cfg = structuredClone(defaultConfig);
    cfg.BRANDING.enabled = false;
    const ops = activeOperations(cfg, {
      windowsTinted: false,
      plateAnonymised: false,
      paintDamped: true,
      composited: true,
    });
    expect(ops).toContain("reflectiedemping in de lak");
    expect(ops).not.toContain("ruit-tint");
    expect(ops).not.toContain("nummerplaat-anonimisatie");
    expect(ops).not.toContain("branding");
  });
});

describe("provenanceXmp", () => {
  it("ontsnapt tekens die de XML zouden breken", () => {
    const xmp = provenanceXmp({ "carbg:claim": 'a & b <tag> "q"' });
    expect(xmp).toContain("a &amp; b &lt;tag&gt; &quot;q&quot;");
    expect(xmp).not.toContain("<tag>");
  });

  it("levert een pakket met de eigen namespace en beide markers", () => {
    const xmp = provenanceXmp({ "carbg:generative": "false" });
    expect(xmp).toContain("<?xpacket begin=");
    expect(xmp).toContain("<?xpacket end=");
    expect(xmp).toContain("xmlns:carbg=");
    expect(xmp).toContain("<carbg:generative>false</carbg:generative>");
  });
});
