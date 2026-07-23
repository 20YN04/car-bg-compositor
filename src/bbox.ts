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

export interface CleanResult {
  alpha: Uint8Array;
  removedArea: number; // pixels boven de threshold die zijn weggehaald
}

function erodeBinary(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      if (src[i] && src[i - 1] && src[i + 1] && src[i - width] && src[i + width]) {
        out[i] = 1;
      }
    }
  }
  return out;
}

function dilateBinary(src: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (
        src[i] ||
        (x > 0 && src[i - 1]) ||
        (x < width - 1 && src[i + 1]) ||
        (y > 0 && src[i - width]) ||
        (y < height - 1 && src[i + width])
      ) {
        out[i] = 1;
      }
    }
  }
  return out;
}

/**
 * Maskeropschoning tegen mee-gemaskeerde vreemde objecten (windmolen, paal,
 * lantaarn): morfologische opening. Dunne structuren (dunner dan ~2×radius)
 * worden weggeërodeerd, de grootste overgebleven component wordt behouden en
 * met een marge teruggedilateerd. Binnen die regio blijft het ORIGINELE
 * alfakanaal staan — zachte randen van de auto blijven dus onaangetast.
 */
export function cleanAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  radius: number,
): CleanResult {
  let binary = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    if ((alpha[i] ?? 0) > threshold) binary[i] = 1;
  }

  let eroded: Uint8Array = binary;
  for (let r = 0; r < radius; r++) eroded = erodeBinary(eroded, width, height);

  // grootste component in het geërodeerde masker zoeken
  const visited = new Uint8Array(eroded.length);
  const stack: number[] = [];
  let bestSeed = -1;
  let bestSize = 0;
  for (let i = 0; i < eroded.length; i++) {
    if (visited[i] || !eroded[i]) continue;
    let size = 0;
    const seed = i;
    stack.push(i);
    visited[i] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      size++;
      const x = idx % width;
      const y = (idx - x) / width;
      for (const n of [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ]) {
        if (n >= 0 && !visited[n] && eroded[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestSeed = seed;
    }
  }
  // volledig weggeërodeerd (extreem kleine auto): niets opschonen
  if (bestSeed < 0) return { alpha, removedArea: 0 };

  // regio = alleen de grootste component, met marge terug uitvergroot
  let region: Uint8Array = new Uint8Array(eroded.length);
  stack.push(bestSeed);
  region[bestSeed] = 1;
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const x = idx % width;
    const y = (idx - x) / width;
    for (const n of [
      x > 0 ? idx - 1 : -1,
      x < width - 1 ? idx + 1 : -1,
      y > 0 ? idx - width : -1,
      y < height - 1 ? idx + width : -1,
    ]) {
      if (n >= 0 && !region[n] && eroded[n]) {
        region[n] = 1;
        stack.push(n);
      }
    }
  }
  for (let r = 0; r < radius + 2; r++) region = dilateBinary(region, width, height);

  const out = new Uint8Array(alpha.length);
  let removedArea = 0;
  for (let i = 0; i < alpha.length; i++) {
    if (region[i]) {
      out[i] = alpha[i] ?? 0;
    } else if ((alpha[i] ?? 0) > threshold) {
      removedArea++;
    }
  }
  return { alpha: out, removedArea };
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
