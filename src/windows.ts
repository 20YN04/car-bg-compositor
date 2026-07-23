import type { BBox } from "./bbox.js";
import type { WindowsConfig } from "./config.js";

export interface SourceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Verwerpt detecties die onmogelijk één raam kunnen zijn: Florence geeft bij
 * "car window" naast de echte ramen vaak ook één box rond de hele auto terug,
 * en die zou SAM2 de complete auto laten segmenteren (= hele auto getint).
 */
export function filterPlausibleWindowBoxes(
  boxes: SourceBox[],
  carBBox: BBox,
): SourceBox[] {
  const carArea =
    (carBBox.right - carBBox.left + 1) * (carBBox.bottom - carBBox.top + 1);
  const carHeight = carBBox.bottom - carBBox.top + 1;
  return boxes.filter(
    (b) => b.w * b.h <= 0.3 * carArea && b.h <= 0.5 * carHeight,
  );
}

/** Houdt alleen boxes over waarvan het middelpunt op de gemaskeerde auto ligt. */
export function filterBoxesOnCar(
  boxes: SourceBox[],
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): SourceBox[] {
  return boxes.filter((b) => {
    const cx = Math.round(b.x + b.w / 2);
    const cy = Math.round(b.y + b.h / 2);
    return (
      cx >= 0 && cx < width && cy >= 0 && cy < height &&
      (alpha[cy * width + cx] ?? 0) > threshold
    );
  });
}

/**
 * Verdonkert de raamzones in de cutout richting tintColor, gewogen met het
 * (gefeatherde) segmentmasker en beperkt tot pixels op de auto. Puur
 * mathematische pixeloperatie: reflecties blijven proportioneel zichtbaar,
 * er wordt niets hertekend. Retourneert het aantal getinte pixels.
 */
export function applyWindowTint(
  rgba: Buffer,
  alpha: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  cfg: Pick<WindowsConfig, "tintOpacity" | "tintColor">,
): number {
  let tinted = 0;
  const { r: tr, g: tg, b: tb } = cfg.tintColor;
  for (let i = 0; i < width * height; i++) {
    if ((alpha[i] ?? 0) === 0) continue;
    const m = (mask[i] ?? 0) / 255;
    if (m <= 0.02) continue;
    const t = m * cfg.tintOpacity;
    const p = i * 4;
    rgba[p] = Math.round((rgba[p] ?? 0) * (1 - t) + tr * t);
    rgba[p + 1] = Math.round((rgba[p + 1] ?? 0) * (1 - t) + tg * t);
    rgba[p + 2] = Math.round((rgba[p + 2] ?? 0) * (1 - t) + tb * t);
    if (t > 0.05) tinted++;
  }
  return tinted;
}
