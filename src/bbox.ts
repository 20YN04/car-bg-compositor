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
  groundTrim: number; // maskerrijen ónder de wiellijn (aangesmolten contactschaduw)
  contactClusters: ContactCluster[]; // wielcontact-plateaus, y = robuust contactniveau
  groundFallback: boolean; // true: geen wielplateau gevonden, percentiel-grondlijn gebruikt
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

export interface ContactCluster {
  x0: number; // eerste kolom (broncoördinaten)
  x1: number; // laatste kolom
  y: number; // laagste maskerpixel binnen de cluster
}

/**
 * Vindt de wielcontact-zones: aaneengesloten kolomgroepen waarvan de
 * onderkant (bijna) op de gecorrigeerde maskeronderkant ligt. Bij een
 * 3/4-view liggen nabije en verre wielen op verschillende beeldhoogtes;
 * elke cluster krijgt zijn eigen contactpunt zodat de schaduw per wiel
 * getekend kan worden in plaats van als één vaste ellips.
 */
export function computeContactClusters(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  adjustedBottom: number,
  threshold: number,
): ContactCluster[] {
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const bboxWidth = bbox.right - bbox.left + 1;
  const contactDepth = Math.max(4, Math.round(bboxHeight * 0.04));
  const contactMinY = adjustedBottom - contactDepth;
  const maxGap = Math.max(2, Math.round(bboxWidth * 0.02));
  const minClusterWidth = Math.max(3, Math.round(bboxWidth * 0.01));

  // onderste contour per kolom, begrensd tot de gecorrigeerde onderkant
  const bottoms: number[] = [];
  const scanBottom = Math.min(bbox.bottom, adjustedBottom);
  for (let x = bbox.left; x <= bbox.right; x++) {
    let bottomY = -1;
    for (let y = scanBottom; y >= bbox.top; y--) {
      if ((alpha[y * width + x] ?? 0) > threshold) {
        bottomY = y;
        break;
      }
    }
    bottoms.push(bottomY);
  }

  const clusters: ContactCluster[] = [];
  let start = -1;
  let gap = 0;
  let lowest = -1;
  const flush = (endIdx: number): void => {
    if (start < 0) return;
    const widthCols = endIdx - start + 1;
    if (widthCols >= minClusterWidth) {
      clusters.push({ x0: bbox.left + start, x1: bbox.left + endIdx, y: lowest });
    }
    start = -1;
    gap = 0;
    lowest = -1;
  };
  let lastContact = -1;
  for (let i = 0; i < bottoms.length; i++) {
    const isContact = bottoms[i]! >= contactMinY && bottoms[i]! >= 0;
    if (isContact) {
      if (start < 0) start = i;
      lastContact = i;
      gap = 0;
      if (bottoms[i]! > lowest) lowest = bottoms[i]!;
    } else if (start >= 0) {
      gap++;
      if (gap > maxGap) flush(lastContact);
    }
  }
  flush(lastContact);
  return clusters;
}

export interface WheelGroundResult {
  groundLine: number;
  clusters: ContactCluster[]; // kandidaat-wielclusters met y = mediaan-niveau
  fallback: boolean;
}

function percentileOf(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
}

/**
 * Grondlijn op het echte wielcontact. Wielen vormen brede, vlákke plateaus op
 * de onderste contour; een aangesmolten slagschaduw is een rónde bult. Per
 * cluster is het contactniveau daarom de mediaan van de kolom-onderkanten
 * (robuust tegen de bult), en alleen brede clusters met beperkte spreiding
 * tellen als wiel. De grondlijn is het diepste wielniveau; zonder plateau
 * valt de bepaling terug op de percentiel-grondlijn.
 */
export function computeWheelGroundLine(
  alpha: Uint8Array,
  width: number,
  height: number,
  bbox: BBox,
  threshold: number,
  percentileGroundLine: number,
  adjustedBottom: number,
): WheelGroundResult {
  const bboxHeight = bbox.bottom - bbox.top + 1;
  const bboxWidth = bbox.right - bbox.left + 1;
  const tolerance = Math.max(3, Math.round(bboxHeight * 0.01));
  const minPlateauWidth = Math.max(4, Math.round(bboxWidth * 0.04));

  const scanBottom = Math.min(bbox.bottom, adjustedBottom);
  const bottoms: number[] = [];
  for (let x = bbox.left; x <= bbox.right; x++) {
    let bottomY = -1;
    for (let y = scanBottom; y >= bbox.top; y--) {
      if ((alpha[y * width + x] ?? 0) > threshold) {
        bottomY = y;
        break;
      }
    }
    bottoms.push(bottomY);
  }

  // stap 1 — plateaus: maximale runs waarvan de onderkant vlak blijft
  // (±tolerance). Wielcontact is vlak en breed; een ronde schaduwblob haalt
  // de vereiste vlakke breedte niet — maar kan wél sub-plateaus vormen.
  const intervals: { i0: number; i1: number; median: number }[] = [];
  let i = 0;
  while (i < bottoms.length) {
    if (bottoms[i]! < 0) {
      i++;
      continue;
    }
    let runMin = bottoms[i]!;
    let runMax = bottoms[i]!;
    let j = i + 1;
    while (j < bottoms.length && bottoms[j]! >= 0) {
      const nextMin = Math.min(runMin, bottoms[j]!);
      const nextMax = Math.max(runMax, bottoms[j]!);
      if (nextMax - nextMin > 2 * tolerance) break;
      runMin = nextMin;
      runMax = nextMax;
      j++;
    }
    if (j - i >= minPlateauWidth) {
      const values = bottoms.slice(i, j).sort((a, b) => a - b);
      intervals.push({ i0: i, i1: j - 1, median: percentileOf(values, 0.5) });
    }
    i = Math.max(j, i + 1);
  }

  // stap 2 — aangrenzende plateaus op vergelijkbare diepte mergen (band +
  // schaduwkom horen bij hetzelfde wiel), zodat de kom niet als eigen
  // "contact" kan winnen. De dieptevoorwaarde voorkomt dat de onderbodem
  // (veel hoger) aan de wielen vastkettingt.
  const maxGap = Math.max(3, Math.round(bboxWidth * 0.02));
  const merged: { i0: number; i1: number; median: number }[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (
      last &&
      iv.i0 - last.i1 <= maxGap &&
      Math.abs(iv.median - last.median) <= 4 * tolerance
    ) {
      last.i1 = iv.i1;
      last.median = Math.max(last.median, iv.median);
    } else {
      merged.push({ ...iv });
    }
  }

  // stap 3 — contactlijn per cluster: de band vult boven de contactlijn
  // (bijna) de volle clusterbreedte, de schaduwkom eronder versmalt. Neem de
  // diepste rij die nog ≥80% van de clusterkolommen vult.
  const plateaus: ContactCluster[] = [];
  for (const { i0, i1 } of merged) {
    const cols = i1 - i0 + 1;
    let deepest = -1;
    for (let c = i0; c <= i1; c++) {
      if (bottoms[c]! > deepest) deepest = bottoms[c]!;
    }
    let contact = deepest;
    for (let y = deepest; y >= bbox.top; y--) {
      let filled = 0;
      const row = y * width;
      for (let c = i0; c <= i1; c++) {
        if ((alpha[row + bbox.left + c] ?? 0) > threshold) filled++;
      }
      if (filled >= 0.8 * cols) {
        contact = y;
        break;
      }
    }
    plateaus.push({ x0: bbox.left + i0, x1: bbox.left + i1, y: contact });
  }

  if (plateaus.length === 0) {
    return { groundLine: percentileGroundLine, clusters: [], fallback: true };
  }
  const groundLine = Math.max(...plateaus.map((c) => c.y));
  // alleen plateaus nabij grondniveau zijn wielcontact; de band is ruim
  // genoeg voor het verre wiel in een 3/4-view (dat hoger in beeld staat en
  // zijn contactschaduw op zijn eigen niveau krijgt), maar sluit
  // onderbodem/sideskirt-plateaus uit
  const groundBand = Math.max(6, Math.round(bboxHeight * 0.05));
  const clusters = plateaus.filter((c) => c.y >= groundLine - groundBand);
  return { groundLine, clusters, fallback: false };
}

/**
 * Zet alle maskerpixels onder de wiellijn (+ kleine marge) op 0, zodat een
 * aangesmolten slagschaduw niet als grijze appendage onder de auto in het
 * eindbeeld belandt. Retourneert het aantal verwijderde pixels.
 */
export function trimAlphaBelow(
  alpha: Uint8Array,
  width: number,
  height: number,
  cutY: number,
): number {
  let removed = 0;
  for (let y = Math.max(0, cutY + 1); y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if ((alpha[row + x] ?? 0) > 0) {
        alpha[row + x] = 0;
        removed++;
      }
    }
  }
  return removed;
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
      groundTrim: 0,
      contactClusters: [],
      groundFallback: false,
      topBump: null,
    };
  }

  const shadowBand = rejectShadowBand(alpha, width, height, bbox, opts.threshold);
  const percentileGL = computeGroundLine(
    alpha,
    width,
    height,
    bbox,
    opts.threshold,
    opts.groundPercentile,
    shadowBand.adjustedBottom,
  );
  const wheel = computeWheelGroundLine(
    alpha,
    width,
    height,
    bbox,
    opts.threshold,
    percentileGL,
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
    groundLine: wheel.groundLine,
    area,
    blobCount,
    shadowBandHeight: shadowBand.bandHeight,
    groundTrim: Math.max(0, shadowBand.adjustedBottom - wheel.groundLine),
    contactClusters: wheel.clusters,
    groundFallback: wheel.fallback,
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

/**
 * Instance-matte: begrens het BiRefNet-alfa met een (gedilateerd en
 * gefeatherd) SAM2-instancemasker via per-pixel minimum. BiRefNet levert de
 * zachte matting-randen, SAM2 bepaalt wat "auto" is — de aangesmolten
 * grondschaduw ligt buiten het instancemasker en verdwijnt zo bij de bron.
 * De dilatatie beschermt dunne delen (spiegels, antennes) tegen SAM2's
 * grovere rand. Retourneert ook het aantal weggenomen pixels.
 */
export function applyInstanceMatte(
  alpha: Uint8Array,
  instanceMask: Uint8Array, // 0..255, zelfde afmetingen (al gefeatherd)
  width: number,
  height: number,
  threshold: number,
): { alpha: Uint8Array; removedArea: number } {
  const out = new Uint8Array(alpha.length);
  let removedArea = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] ?? 0;
    const m = instanceMask[i] ?? 0;
    out[i] = Math.min(a, m);
    if (a > threshold && out[i]! <= threshold) removedArea++;
  }
  return { alpha: out, removedArea };
}

/**
 * Binaire dilatatie met straal r. Groeit omhoog en zijwaarts (bescherming
 * van dunne delen zoals spiegels en antennes tegen SAM2's grovere rand),
 * maar bewust níet omlaag: de onderrand — het wielcontact — moet de strakke
 * SAM2-rand houden, anders komt de aangesmolten contactschaduw terug.
 */
export function dilateMask(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  let bin: Uint8Array = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) bin[i] = (mask[i] ?? 0) > 127 ? 1 : 0;
  for (let r = 0; r < radius; r++) {
    const next = new Uint8Array(bin.length);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        if (
          bin[i] ||
          (x > 0 && bin[i - 1]) ||
          (x < width - 1 && bin[i + 1]) ||
          (y < height - 1 && bin[i + width]) // van onder → groeit omhoog
        ) {
          next[i] = 1;
        }
      }
    }
    bin = next;
  }
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = bin[i] ? 255 : 0;
  return out;
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
