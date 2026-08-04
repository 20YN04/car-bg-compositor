/**
 * Spec-template: van databasevelden naar de voertuigbeschrijving die de
 * pipeline voedt (vehicle.txt).
 *
 * Waarom dit bestaat. Handgeschreven specs waren de duurste foutenbron van
 * de hele pipeline: een verzonnen 4MATIC-badge en een chromen raamlijst in
 * mijn eigen proza kostten drie volledige hergeneratierondes, omdat de
 * generator de spec gehoorzaamt terwijl de poorten de foto's toetsen — één
 * regel die de foto's tegenspreekt zet die twee in een oorlog die nooit
 * convergeert (2026-08-04). Een template kan alleen beweren wat er als data
 * in gaat, en verzint per constructie niets.
 *
 * De hiërarchie van Yentl: aanwezigheid komt uit de foto's, tekst uit
 * fabriekskennis of menselijke bevestiging. Daarom is `badges` een expliciet
 * veld: wat de dealer of admin bevestigt komt limitatief in de spec, en de
 * badge-census bewaakt die lijst. Geen data = geen claim; de bronfoto's als
 * referentiebeelden sturen dan het beeld.
 */

export interface VehicleData {
  make?: string;
  model?: string;
  /** Uitvoering/trim zoals de fabriek hem noemt ("AMG 43 4MATIC", "GT Line"). */
  trim?: string;
  year?: number;
  body?: string;
  /** Lakkleur, liefst de fabrieksnaam ("obsidian black metallic"). */
  colour?: string;
  /** Metallic/parelmoer/mat — alleen als bekend. */
  paintFinish?: string;
  /** Visuele pakketten ("Night package: gloss black window surrounds, mirrors"). */
  packages?: string[];
  /** Velgenbeschrijving ("AMG five-twin-spoke, dark grey, machined edges"). */
  wheels?: string;
  /**
   * Limitatieve badge-lijst, door een mens bevestigd: tekst + paneel.
   * Dit is het veld dat de 4MATIC-vraag beslist die geen enkele poort uit
   * onleesbare foto's kon halen.
   */
  badges?: { text: string; where: string }[];
  /** Wielbasis in meters — activeert de geometriepoort zonder zijaanzicht. */
  wheelbaseM?: number;
  /** Lengte in meters — stuurt de kadervulling. */
  lengthM?: number;
  /** Vrije, door een mens geschreven aanvulling (bv. dakkleur, folie). */
  notes?: string;
}

/** Bouwt de vehicle.txt-inhoud. Alleen aangeleverde velden worden beweerd. */
export function bouwSpec(v: VehicleData): string {
  const regels: string[] = [];
  if (typeof v.wheelbaseM === "number" && Number.isFinite(v.wheelbaseM)) {
    regels.push(`wielbasis: ${v.wheelbaseM.toFixed(2)}`);
  }
  const kop = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  const lijf: string[] = [];
  if (kop) {
    lijf.push(
      kop +
        (v.body ? ` — a ${v.body}` : "") +
        (typeof v.lengthM === "number" ? `, about ${v.lengthM.toFixed(2)} m long` : "") +
        ".",
    );
  }
  if (v.colour) {
    lijf.push(
      `PAINT: ${v.colour}${v.paintFinish ? `, ${v.paintFinish}` : ""} — ` +
        "render the exact paint tone of the source photos, never lighter, " +
        "darker or shifted in hue.",
    );
  }
  for (const p of v.packages ?? []) lijf.push(`PACKAGE: ${p}.`);
  if (v.wheels) lijf.push(`WHEELS: ${v.wheels}.`);
  if (v.badges && v.badges.length > 0) {
    lijf.push(
      "BADGES, exactly these and nothing more: " +
        v.badges.map((b) => `'${b.text}' (${b.where})`).join("; ") +
        ". Never add lettering the list does not mention, and never repeat " +
        "a badge on additional panels.",
    );
  }
  if (v.notes) lijf.push(v.notes.trim());
  return [...regels, lijf.join("\n")].join("\n").trim() + "\n";
}
