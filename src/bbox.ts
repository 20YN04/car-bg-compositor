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
  shadowBandHeight: number; // onderste rijen genegeerd als uitwaaierende slagschaduw
  topBump: { width: number; height: number } | null; // lokale bult boven de daklijn
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
  maxY: number = Number.MAX_SAFE_INTEGER,
): number {
  const bottoms: number[] = [];
  const scanBottom = Math.min(bbox.bottom, maxY);
  for (let x = bbox.left; x <= bbox.right; x++) {
    for (let y = scanBottom; y >= bbox.top; y--) {
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

export interface RestrictResult {
  alpha: Uint8Array;
  removedArea: number; // pixels boven de threshold buiten de auto-box
}

/**
 * Begrenst het alfamasker tot de gedetecteerde auto-box (implementatie B van
 * instance-aware masking): alles buiten de box + marge gaat naar 0, en elke
 * maskercomponent waarvan het zwaartepunt buiten de (ongemargede) box valt
 * wordt volledig verworpen — ook het deel dat binnen de marge ligt.
 */
export function restrictAlphaToBox(
  alpha: Uint8Array,
  width: number,
  height: number,
  box: BBox,
  marginFraction: number,
  threshold: number,
): RestrictResult {
  const mx = Math.round((box.right - box.left + 1) * marginFraction);
  const my = Math.round((box.bottom - box.top + 1) * marginFraction);
  const left = Math.max(0, box.left - mx);
  const right = Math.min(width - 1, box.right + mx);
  const top = Math.max(0, box.top - my);
  const bottom = Math.min(height - 1, box.bottom + my);

  const out = new Uint8Array(alpha.length);
  let removedArea = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const inside = y >= top && y <= bottom;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (inside && x >= left && x <= right) {
        out[i] = alpha[i] ?? 0;
      } else if ((alpha[i] ?? 0) > threshold) {
        removedArea++;
      }
    }
  }

  // componenten met zwaartepunt buiten de eigenlijke box verwerpen
  const visited = new Uint8Array(out.length);
  const stack: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (visited[i] || (out[i] ?? 0) <= threshold) continue;
    const component: number[] = [];
    let sumX = 0;
    let sumY = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      component.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      sumX += x;
      sumY += y;
      for (const n of [
        x > 0 ? idx - 1 : -1,
        x < width - 1 ? idx + 1 : -1,
        y > 0 ? idx - width : -1,
        y < height - 1 ? idx + width : -1,
      ]) {
        if (n >= 0 && !visited[n] && (out[n] ?? 0) > threshold) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    const cx = sumX / component.length;
    const cy = sumY / component.length;
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) {
      for (const idx of component) out[idx] = 0;
      removedArea += component.length;
    }
  }
  return { alpha: out, removedArea };
}

export interface ShadowBandResult {
  adjustedBottom: number;
  bandHeight: number;
}

/**
 * Vangnet tegen mee-gemaskeerde slagschaduw: wanneer de onderste maskerrijen
 * abrupt breder zijn dan de mediane rompbreedte (uitwaaierende schaduw),
 * worden die rijen genegeerd bij de grondlijnbepaling.
 */
export function rejectShadowBand(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  threshold: number,
): ShadowBandResult {
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const spans: number[] = [];
  for (let y = bbox.top; y <= bbox.bottom; y++) {
    let first = -1;
    let last = -1;
    const row = y * width;
    for (let x = bbox.left; x <= bbox.right; x++) {
      if ((alpha[row + x] ?? 0) > threshold) {
        if (first < 0) first = x;
        last = x;
      }
    }
    spans.push(first < 0 ? 0 : last - first + 1);
  }

  const midStart = Math.floor(bboxHeight * 0.25);
  const midEnd = Math.floor(bboxHeight * 0.75);
  const bodySpans = spans.slice(midStart, midEnd + 1).sort((a, b) => a - b);
  const bodyMedian = bodySpans[Math.floor(bodySpans.length / 2)] ?? 0;
  if (bodyMedian === 0) return { adjustedBottom: bbox.bottom, bandHeight: 0 };

  const maxBand = Math.floor(bboxHeight * 0.25); // veiligheidsgrens
  let band = 0;
  while (
    band < maxBand &&
    (spans[bboxHeight - 1 - band] ?? 0) > bodyMedian * 1.06
  ) {
    band++;
  }
  const minBand = Math.max(3, Math.round(bboxHeight * 0.015));
  if (band < minBand) return { adjustedBottom: bbox.bottom, bandHeight: 0 };
  return { adjustedBottom: bbox.bottom - band, bandHeight: band };
}

/**
 * Detecteert een lokale bult in de bovencontour (bv. een aangeplakt wit
 * busje-dak): een smalle groep kolommen waarvan de top significant boven de
 * omliggende, gladde daklijn uitsteekt.
 */
export function detectTopBump(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  threshold: number,
): { width: number; height: number } | null {
  const bboxWidth = bbox.right - bbox.left + 1;
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const tops: number[] = [];
  for (let x = bbox.left; x <= bbox.right; x++) {
    let topY = bbox.bottom + 1;
    for (let y = bbox.top; y <= bbox.bottom; y++) {
      if ((alpha[y * width + x] ?? 0) > threshold) {
        topY = y;
        break;
      }
    }
    tops.push(topY);
  }

  // referentie: de globale mediaan-daklijn. Een "bult" is een smalle groep
  // kolommen die daar significant bovenuit steekt; de cabine van de auto
  // zelf is breed en valt daardoor buiten de breedtelimiet.
  const sorted = [...tops].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? bbox.top;
  const minDeviation = Math.max(6, bboxHeight * 0.05);
  const maxBumpWidth = Math.floor(bboxWidth * 0.3);

  let bestBump: { width: number; height: number } | null = null;
  let runStart = -1;
  let runMaxDev = 0;
  const flush = (end: number): void => {
    if (runStart < 0) return;
    const runWidth = end - runStart;
    if (runWidth <= maxBumpWidth && (!bestBump || runMaxDev > bestBump.height)) {
      bestBump = { width: runWidth, height: Math.round(runMaxDev) };
    }
    runStart = -1;
    runMaxDev = 0;
  };
  for (let i = 0; i < tops.length; i++) {
    const deviation = median - tops[i]!; // >0: kolom steekt boven de daklijn uit
    if (deviation > minDeviation) {
      if (runStart < 0) runStart = i;
      if (deviation > runMaxDev) runMaxDev = deviation;
    } else {
      flush(i);
    }
  }
  flush(tops.length);
  return bestBump;
}

export function analyzeAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  opts: AnalyzeOptions,
): AlphaAnalysis {
  const { bbox, area } = computeBBox(alpha, width, height, opts.threshold);
  if (!bbox) {
    return {
      bbox: null,
      groundLine: null,
      area: 0,
      blobCount: 0,
      shadowBandHeight: 0,
      topBump: null,
    };
  }

  const shadowBand = rejectShadowBand(alpha, width, height, bbox, opts.threshold);
  const groundLine = computeGroundLine(
    alpha,
    width,
    height,
    bbox,
    opts.threshold,
    opts.groundPercentile,
    shadowBand.adjustedBottom,
  );
  const blobCount = countBlobs(
    alpha,
    width,
    height,
    opts.threshold,
    opts.minBlobArea,
  );
  const topBump = detectTopBump(alpha, width, height, bbox, opts.threshold);
  return {
    bbox,
    groundLine,
    area,
    blobCount,
    shadowBandHeight: shadowBand.bandHeight,
    topBump,
  };
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
