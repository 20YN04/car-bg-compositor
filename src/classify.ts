import { geminiText, type ImagePart } from "./gemini.js";
import type { GeminiConfig } from "./config.js";

export type PhotoKind = "interior" | "exterior" | "other";

export interface Classification {
  kind: PhotoKind;
  /** Detailopname: het onderwerp vult het kader, de auto is niet als geheel te zien. */
  closeUp: boolean;
  /** Korte omschrijving van wat er te zien is, voor het runverslag. */
  subject: string;
  /**
   * Met de hand weggelakte vlakken: zwarte balken of krassen over een
   * kenteken, een adres in de navigatie of een telefoonnummer. Zulke foto's
   * horen niet in een listing, en wegwerken zou betekenen dat we verzinnen
   * wat eronder zat — bij een scherm is dat een uitrustingsclaim.
   *
   * Bewust in deze call meegenomen: een deterministische detector kwam er
   * niet doorheen (gemeten 2026-08-01) omdat een donker UI-vlak op een
   * verlicht scherm hetzelfde profiel heeft als een zwarte balk. Het model
   * ziet het verschil meteen, en het kost geen extra aanroep.
   */
  redacted: boolean;
  redactedWhere: string;
}

/**
 * Sorteert een dealerfoto in interieur, exterieur of overig.
 *
 * Een dealermap bevat door elkaar: buitenkant, cabine, detailopnames van
 * velgen en stiksel, en geregeld ook schermafbeeldingen van het
 * onderhoudsboekje. Deze repo mag alleen de interieurfoto's aanraken; de
 * buitenkant hoort in car-multiview en de rest nergens.
 *
 * Bewust een modelcall en geen heuristiek: de deterministische signalen die
 * voor de hand liggen (lucht bovenin, een auto-vormige uitsnede) vergen óf
 * een matte — die hier per definitie niet werkt op een cabine — óf
 * kleurstatistiek die op een donkere garagefoto meteen omvalt. Eén call per
 * foto is goedkoop en wordt gecachet op de beeld-hash, dus een herhaalde run
 * kost niets.
 */
export async function classifyPhoto(
  photo: ImagePart,
  cfg: GeminiConfig,
  cacheDir: string,
  useCache: boolean,
): Promise<Classification> {
  const prompt =
    "Classify this photo from a car dealer's listing.\n" +
    "kind:\n" +
    '  "interior" — the camera is INSIDE the cabin: dashboard, steering ' +
    "wheel, seats, doorcards, boot space seen from inside, or a close-up of " +
    "upholstery, stitching, a screen or a control. A view through the " +
    "windscreen from the driver's seat is still interior.\n" +
    '  "exterior" — the camera is OUTSIDE the car: the whole car or a part ' +
    "of its outside, including close-ups of a wheel, headlight, badge, " +
    "grille or paint.\n" +
    '  "other" — anything that is not a photo of this car: documents, ' +
    "screenshots, papers, price boards, a different vehicle only, people, " +
    "empty rooms.\n" +
    "closeUp: true when the subject fills the frame and the car cannot be " +
    "seen as a whole.\n" +
    "subject: three to six words naming what is shown, in English.\n" +
    "redacted: true when someone has manually blacked something out — a " +
    "solid black bar, scribble or smear drawn over a licence plate, an " +
    "address on the navigation screen, a phone number or a document. This " +
    "is about hand-drawn censorship, NOT about dark parts of the car, dark " +
    "screens, shadows or tinted glass.\n" +
    "redactedWhere: three to six words naming what was blacked out, empty " +
    "when redacted is false.\n" +
    'Answer with STRICT JSON only, no code fences: {"kind": string, ' +
    '"closeUp": boolean, "subject": string, "redacted": boolean, ' +
    '"redactedWhere": string}';
  const raw = await geminiText([photo], prompt, cfg, cacheDir, useCache);
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as {
        kind?: unknown; closeUp?: unknown; subject?: unknown;
        redacted?: unknown; redactedWhere?: unknown;
      };
      const kind = obj.kind === "interior" || obj.kind === "exterior" ? obj.kind : "other";
      return {
        kind,
        closeUp: obj.closeUp === true,
        subject: typeof obj.subject === "string" ? obj.subject : "",
        redacted: obj.redacted === true,
        redactedWhere: typeof obj.redactedWhere === "string" ? obj.redactedWhere : "",
      };
    } catch {
      // valt door naar de veilige uitkomst
    }
  }
  // onleesbaar antwoord telt als "overig": liever een foto overslaan dan een
  // exterieurbeeld door de interieurcorrectie halen
  return {
    kind: "other", closeUp: false, subject: "onleesbaar antwoord",
    redacted: false, redactedWhere: "",
  };
}
