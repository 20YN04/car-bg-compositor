/** Gemiddelde kanaalwaarden — de meeteenheid van de lakpoort. */
export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

/** Alfagewogen gemiddelde kanaalwaarden van een cutout (RGBA-raw). */
export function cutoutMeans(
  rgba: Buffer,
  alpha: Uint8Array,
  width: number,
  height: number,
): ChannelMeans {
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < width * height; i++) {
    const a = (alpha[i] ?? 0) / 255;
    if (a <= 0.04) continue;
    const p = i * 4;
    r += (rgba[p] ?? 0) * a;
    g += (rgba[p + 1] ?? 0) * a;
    b += (rgba[p + 2] ?? 0) * a;
    w += a;
  }
  if (w === 0) return { r: 128, g: 128, b: 128 };
  return { r: r / w, g: g / w, b: b / w };
}

/**
 * Mediaan per kanaal over een set metingen — robuust tegen één afwijkende
 * opname (tegenlicht, onderbelichte garagefoto) in de bronset.
 */
export function medianMeans(list: ChannelMeans[]): ChannelMeans {
  if (list.length === 0) return { r: 128, g: 128, b: 128 };
  const mid = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const i = Math.floor(s.length / 2);
    return s.length % 2 ? (s[i] ?? 0) : ((s[i - 1] ?? 0) + (s[i] ?? 0)) / 2;
  };
  return {
    r: mid(list.map((m) => m.r)),
    g: mid(list.map((m) => m.g)),
    b: mid(list.map((m) => m.b)),
  };
}
