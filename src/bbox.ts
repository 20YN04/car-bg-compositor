export interface BBox {
  left: number;
  top: number;
  right: number; // inclusief
  bottom: number; // inclusief
}

export interface AlphaAnalysis {
  bbox: BBox | null; // null bij leeg masker
  groundLine: number | null; // y-coördinaat waarop de banden geacht worden te staan
  area: number; // aantal pixels boven de threshold
  blobCount: number; // losse componenten boven minBlobArea
}

export interface AnalyzeOptions {
  threshold: number;
  groundPercentile: number; // bv. 0.95
  minBlobArea: number; // fractie van het beeldoppervlak
}

export function computeBBox(
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
): { bbox: BBox | null; area: number } {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  let area = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if ((alpha[row + x] ?? 0) > threshold) {
        area++;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (right < 0) return { bbox: null, area: 0 };
  return { bbox: { left, top, right, bottom }, area };
}

/**
 * Robuuste grondlijn: per kolom binnen de bbox het laagste pixel boven de
 * threshold, daarvan het opgegeven percentiel. Een uitschieter (meegemaskte
 * slagschaduw, afstekend onderdeel) trekt de uitlijning zo niet scheef.
 */
export function computeGroundLine(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  threshold: number,
  percentile: number,
): number {
  const bottoms: number[] = [];
  for (let x = bbox.left; x <= bbox.right; x++) {
    for (let y = bbox.bottom; y >= bbox.top; y--) {
      if ((alpha[y * width + x] ?? 0) > threshold) {
        bottoms.push(y);
        break;
      }
    }
  }
  bottoms.sort((a, b) => a - b);
  const idx = Math.min(
    bottoms.length - 1,
    Math.floor(percentile * (bottoms.length - 1)),
  );
  return bottoms[idx] ?? bbox.bottom;
}

/**
 * Telt losse blobs (4-connectiviteit) met een oppervlak boven minBlobArea.
 * Iteratieve flood fill met expliciete stack — geen recursie.
 */
export function countBlobs(
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  minBlobArea: number,
): number {
  const minPixels = minBlobArea * width * height;
  const visited = new Uint8Array(width * height);
  let count = 0;
  const stack: number[] = [];

  for (let i = 0; i < alpha.length; i++) {
    if (visited[i] || (alpha[i] ?? 0) <= threshold) continue;
    let size = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      size++;
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0) tryPush(idx - 1);
      if (x < width - 1) tryPush(idx + 1);
      if (y > 0) tryPush(idx - width);
      if (y < height - 1) tryPush(idx + width);
    }
    if (size >= minPixels) count++;
  }
  return count;

  function tryPush(idx: number): void {
    if (!visited[idx] && (alpha[idx] ?? 0) > threshold) {
      visited[idx] = 1;
      stack.push(idx);
    }
  }
}

export function analyzeAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  opts: AnalyzeOptions,
): AlphaAnalysis {
  const { bbox, area } = computeBBox(alpha, width, height, opts.threshold);
  if (!bbox) return { bbox: null, groundLine: null, area: 0, blobCount: 0 };

  const groundLine = computeGroundLine(
    alpha,
    width,
    height,
    bbox,
    opts.threshold,
    opts.groundPercentile,
  );
  const blobCount = countBlobs(
    alpha,
    width,
    height,
    opts.threshold,
    opts.minBlobArea,
  );
  return { bbox, groundLine, area, blobCount };
}

/** 1px erosie (3×3 min-filter) van het alfakanaal, tegen kleurhalo's. */
export function erodeAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let min = 255;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          min = 0;
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            min = 0;
            continue;
          }
          const v = alpha[ny * width + nx] ?? 0;
          if (v < min) min = v;
        }
      }
      out[y * width + x] = min;
    }
  }
  return out;
}
