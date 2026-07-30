import { florenceBoxes } from "./plate.js";

/**
 * Wielbasis/wieldiameter-verhouding: de deterministische maat voor
 * koetsgeometrie. Op een zuiver zijaanzicht is dit de echte verhouding van
 * de auto (Taycan gemeten 4.03, EQE 4.33 — exact de fabriekscijfers); op de
 * canonieke 3/4-hoek van het anker projecteert hij naar ~0.60 van die
 * waarde (EQE én Taycan maten allebei 0.597–0.598). Een samengedrukte
 * koets zakt daar meetbaar onder, een uitgerekte stijgt erboven — geen
 * VLM-mening meer nodig.
 */
export async function wheelbaseRatio(
  imageBytes: Buffer,
  detectionModelId: string,
  cacheDir: string,
  useCache: boolean,
): Promise<number | null> {
  const boxes = await florenceBoxes(
    imageBytes, "wheel", "wheels2", detectionModelId, cacheDir, useCache,
  );
  const two = boxes.sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 2);
  if (two.length < 2) return null;
  const c = (b: (typeof two)[number]) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const d = Math.hypot(c(two[0]!).x - c(two[1]!).x, c(two[0]!).y - c(two[1]!).y);
  // hoogte = diameter: hoekongevoelig, breedte niet
  const meanDia = (two[0]!.h + two[1]!.h) / 2;
  if (meanDia <= 4 || d <= meanDia) return null; // detectie-onzin
  return d / meanDia;
}

export interface GeometryVerdict {
  ok: boolean;
  issue: string | null;
}

/**
 * Toetst de kandidaat-geometrie tegen het zijaanzicht uit de bronset.
 * `sideRatio` is de hoogste verhouding over de bronfoto's (≈ het echte
 * cijfer). De projectieband [0.50, 0.72] is geijkt op de anker-hoek (0.60)
 * met marge voor lichte hoekvariatie.
 */
export function checkGeometry(
  candidateRatio: number | null,
  sideRatio: number | null,
): GeometryVerdict {
  if (candidateRatio === null || sideRatio === null) return { ok: true, issue: null };
  const proj = candidateRatio / sideRatio;
  if (proj < 0.5) {
    return {
      ok: false,
      issue:
        `the body is measurably horizontally COMPRESSED: projected wheelbase ` +
        `factor ${proj.toFixed(2)} where 0.50–0.72 is expected at this camera ` +
        "angle — keep the real wheelbase and body length from the source photos",
    };
  }
  if (proj > 0.72) {
    return {
      ok: false,
      issue:
        `the body is measurably STRETCHED (or the angle is too side-on): ` +
        `projected wheelbase factor ${proj.toFixed(2)} where 0.50–0.72 is ` +
        "expected — keep the real proportions and the anchor's 3/4 angle",
    };
  }
  return { ok: true, issue: null };
}
