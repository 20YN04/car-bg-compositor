import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

const CACHE_DIR = "./cache";

export interface LocalMaskStats {
  calls: number;
  cacheHits: number;
}

export const localMaskStats: LocalMaskStats = {
  calls: 0,
  cacheHits: 0,
};

/**
 * Verwijdert de achtergrond via Python rembg (lokaal, gratis).
 * Eerste aanroep per model downloadt de gewichten naar ~/.u2net/.
 *
 * Het model zit in de bestandsnaam-suffix, niet in de hash: dat scheidt de
 * modellen net zo goed, maar houdt de sleutel van het default-model (u2net)
 * gelijk aan die van vóór deze parameter — bestaande maskers blijven geldig.
 *
 * @returns PNG buffer met transparante achtergrond (RGBA)
 */
export async function removeBackgroundLocal(
  inputPath: string,
  useCache = true,
  model = "u2net",
): Promise<Buffer> {
  const inputBytes = await readFile(inputPath);
  const hash = createHash("sha256").update(inputBytes).digest("hex");
  const suffix = model === "u2net" ? "rembg" : `rembg-${model}`;
  const cachePath = path.join(CACHE_DIR, `${hash}.${suffix}.png`);

  if (useCache && existsSync(cachePath)) {
    localMaskStats.cacheHits++;
    return readFile(cachePath);
  }

  await mkdir(CACHE_DIR, { recursive: true });

  // Python rembg: u2net model, output naar stdout als PNG
  const script = `
import sys
from rembg import remove, new_session
from PIL import Image

session = new_session(sys.argv[3])
img = Image.open(sys.argv[1])
output = remove(img, session=session)
output.save(sys.argv[2], 'PNG')
`;

  const tmpScript = path.join(CACHE_DIR, `_rembg_${hash}.py`);
  const tmpOut = path.join(CACHE_DIR, `_rembg_${hash}_out.png`);

  await writeFile(tmpScript, script);

  localMaskStats.calls++;
  await execFileAsync("python3", [tmpScript, inputPath, tmpOut, model], {
    // birefnet/bria draaien zwaarder dan u2net en downloaden bij de eerste
    // aanroep hun gewichten
    timeout: 600_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const result = await readFile(tmpOut);

  // Cleanup temp files
  try { await (await import("node:fs/promises")).unlink(tmpScript); } catch {}
  try { await (await import("node:fs/promises")).unlink(tmpOut); } catch {}

  await writeFile(cachePath, result);
  return result;
}
