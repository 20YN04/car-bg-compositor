import sharp from "sharp";
import { grainLevel } from "./harmonize.js";
import type { CanvasSize } from "./config.js";
import type { Placement } from "./composite.js";

export interface CompositeAudit {
  /** Hoogfrequente energie op de auto en op de scène. */
  grainCar: number;
  grainFloor: number;
  grainWall: number;
  /** grainCar / grainFloor. Ver van 1 = de lagen komen zichtbaar uit twee opnames. */
  grainRatio: number;
  /** Fractie van de auto onder waarde 12: hoge waarde = dichtgeslagen zwart. */
  crushed: number;
}

/**
 * Objectieve maten op het eindbeeld, zodat "ziet er uitgeknipt uit" een getal
 * wordt in plaats van een mening.
 *
 * Deze twee metingen vonden binnen tien minuten twee bugs die sessies lang
 * onopgemerkt bleven: een onvoorwaardelijke sharpen die de korrel van 1,5 naar
 * 5,75 tilde tegen een achtergrond van 0,3, en een finishing grade die 53% van
 * de auto op zwart knipte terwijl de bron op 17% zat.
 *
 * Kost geen API-calls: puur pixels tellen op een beeld dat we al hebben.
 */
export async function auditComposite(
  jpeg: Buffer,
  placement: Placement,
  canvas: CanvasSize,
): Promise<CompositeAudit | null> {
  const { data, info } = await sharp(jpeg)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;

  const carX = Math.round(placement.x);
  const carY = Math.round(placement.y);
  const carW = Math.round(placement.width);
  const carH = Math.round(placement.height);

  // meetvenster ruim binnen de auto, weg van de randen waar de matte-overgang
  // de meting zou vervuilen
  const cx = Math.round(carX + carW * 0.35);
  const cy = Math.round(carY + carH * 0.45);
  const cw = Math.max(16, Math.round(carW * 0.2));
  const ch = Math.max(16, Math.round(carH * 0.2));
  if (cx + cw >= W - 1 || cy + ch >= H - 1 || cx < 1 || cy < 1) return null;

  // vloer: onder de auto maar buiten zijn bbox, links van de auto
  const floorY = Math.min(H - 130, Math.round(canvas.height * 0.88));
  const floorW = Math.max(16, Math.min(200, carX - 24));
  // wand: linksboven, ruim boven de horizon
  const wallH = Math.max(16, Math.min(160, Math.round(canvas.height * 0.15)));

  const grainCar = grainLevel(data, W, cx, cy, cw, ch);
  const grainFloor = floorW >= 16 ? grainLevel(data, W, 12, floorY, floorW, 120) : 0;
  const grainWall = grainLevel(data, W, 12, 40, 200, wallH);

  let dark = 0;
  let total = 0;
  for (let y = cy; y < cy + ch; y++) {
    for (let x = cx; x < cx + cw; x++) {
      total++;
      if ((data[y * W + x] ?? 0) < 12) dark++;
    }
  }

  return {
    grainCar: round2(grainCar),
    grainFloor: round2(grainFloor),
    grainWall: round2(grainWall),
    grainRatio: grainFloor > 0.01 ? round2(grainCar / grainFloor) : 0,
    crushed: total > 0 ? round2(dark / total) : 0,
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * Verdachte meetwaarden. De drempels komen uit de Taycan-set: vóór de fixes
 * stond de verhouding op 3,37 en de crush op 0,53, erna op 1,08 en 0,26.
 */
export function auditWarnings(a: CompositeAudit): string[] {
  const out: string[] = [];
  if (a.grainRatio > 2 || (a.grainRatio > 0 && a.grainRatio < 0.5)) {
    out.push(
      `korrelverschil auto/vloer ${a.grainRatio}× — lagen lezen als twee opnames`,
    );
  }
  if (a.crushed > 0.4) {
    out.push(`${Math.round(a.crushed * 100)}% van de auto dichtgeslagen op zwart`);
  }
  return out;
}
