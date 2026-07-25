import type { Config } from "./config.js";

export interface ProvenanceInput {
  /** Is er een generatieve stap toegepast op dit beeld? */
  generative: boolean;
  /** Modelnamen die het beeld daadwerkelijk hebben geraakt. */
  models: string[];
  /** Bewerkingen die zijn uitgevoerd, in volgorde. */
  operations: string[];
}

/**
 * Herkomstregistratie per beeld.
 *
 * EU AI Act artikel 50 lid 2 verplicht aanbieders van AI-systemen die
 * synthetische content maken om de output machineleesbaar te markeren als
 * kunstmatig gegenereerd of gemanipuleerd. Van kracht vanaf 2 augustus 2026.
 *
 * De uitzondering in datzelfde lid is waar deze pipeline op mikt: systemen die
 * "an assistive function for standard editing" uitvoeren of die "do not
 * substantially alter the input data ... or the semantics thereof". De
 * garantie-architectuur — originele autopixels, niets hertekend — is het
 * sterkste beroep daarop dat er is. Of dat beroep slaagt bij een
 * achtergrondvervanging is een juridische vraag, geen technische; dit is geen
 * juridisch advies.
 *
 * Wat we hier doen is de feiten vastleggen zodat die vraag te beantwoorden is:
 * welke modellen raakten dit beeld, welke bewerkingen liepen, en is er
 * uberhaupt iets gegenereerd. Zonder dat is er achteraf niets aan te tonen.
 *
 * LET OP: dit is nog GEEN C2PA. Een geldige C2PA-manifest vereist een
 * cryptografische handtekening met een certificaat, en dat hebben we niet. Dit
 * is de onderliggende registratie; de ondertekening is een aparte stap zodra er
 * een certificaat is.
 */
export function buildProvenance(input: ProvenanceInput, cfg: Config): Record<string, string> {
  const claim = input.generative
    ? "Bevat door AI gegenereerde beeldinhoud (achtergrondscene)."
    : "Achtergrond vervangen door een vaste fotografische plate. De pixels " +
      "van het voertuig zijn onbewerkt overgenomen uit de bronopname; " +
      "kleur, belichting en kadrering zijn aangepast.";

  return {
    "carbg:generative": input.generative ? "true" : "false",
    "carbg:claim": claim,
    "carbg:models": input.models.join(", ") || "geen",
    "carbg:operations": input.operations.join(", "),
    "carbg:background": cfg.CANVAS.width + "x" + cfg.CANVAS.height,
    // pixelgarantie: geldt alleen zonder generatieve stap
    "carbg:vehiclePixelsPreserved": input.generative ? "false" : "true",
  };
}

/**
 * Welke bewerkingen zijn er op dit beeld gedraaid? Alleen wat werkelijk aan
 * stond — een lijst die stappen noemt die niet liepen is erger dan geen lijst.
 */
export function activeOperations(cfg: Config, opts: {
  windowsTinted: boolean;
  plateAnonymised: boolean;
  paintDamped: boolean;
  composited: boolean;
}): string[] {
  const ops: string[] = [];
  if (opts.composited) ops.push("achtergrondvervanging");
  if (cfg.HARMONIZE.enabled) ops.push("kleur- en belichtingscorrectie");
  if (opts.paintDamped) ops.push("reflectiedemping in de lak");
  if (opts.windowsTinted) ops.push("ruit-tint");
  if (opts.plateAnonymised) ops.push("nummerplaat-anonimisatie");
  if (cfg.GRAIN.enabled) ops.push("korrel gelijkgetrokken");
  if (cfg.LIGHTWRAP.enabled) ops.push("light wrap");
  if (cfg.FINISH.enabled) ops.push("finishing grade");
  if (cfg.BRANDING.enabled) ops.push("branding");
  return ops;
}

/**
 * XMP-pakket met de herkomstregistratie.
 *
 * Niet EXIF: libvips schrijft alleen erkende EXIF-tags weg en liet een
 * zelfbedachte sleutel stil vallen. XMP is een vrij XML-formaat waarin een
 * eigen namespace wél overleeft, en het is de container waar
 * herkomstgereedschap sowieso in kijkt.
 */
export function provenanceXmp(record: Record<string, string>): string {
  const esc = (v: string): string =>
    v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fields = Object.entries(record)
    .map(([k, v]) => `      <carbg:${k.replace("carbg:", "")}>${esc(v)}</carbg:${k.replace("carbg:", "")}>`)
    .join("\n");
  return (
    `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/">\n` +
    ` <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `  <rdf:Description rdf:about="" xmlns:carbg="https://carredo.be/ns/car-bg-compositor/1.0/">\n` +
    `${fields}\n` +
    `  </rdf:Description>\n` +
    ` </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`
  );
}
