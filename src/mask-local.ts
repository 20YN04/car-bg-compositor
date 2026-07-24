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
 * Eerste aanroep downloadt het u2net-model (~176 MB) naar ~/.u2net/.
 *
 * @returns PNG buffer met transparante achtergrond (RGBA)
 */
export async function removeBackgroundLocal(
  inputPath: string,
  useCache = true,
): Promise<Buffer> {
  const inputBytes = await readFile(inputPath);
  const hash = createHash("sha256").update(inputBytes).digest("hex");
  const cachePath = path.join(CACHE_DIR, `${hash}.rembg.png`);

  if (useCache && existsSync(cachePath)) {
    localMaskStats.cacheHits++;
    return readFile(cachePath);
  }

  await mkdir(CACHE_DIR, { recursive: true });

  // Python rembg: u2net model, output naar stdout als PNG
  const script = `
import sys, base64
from rembg import remove, new_session
from PIL import Image

session = new_session('u2net')
img = Image.open(sys.argv[1])
output = remove(img, session=session)
output.save(sys.argv[2], 'PNG')
`;

  const tmpScript = path.join(CACHE_DIR, `_rembg_${hash}.py`);
  const tmpOut = path.join(CACHE_DIR, `_rembg_${hash}_out.png`);

  await writeFile(tmpScript, script);

  localMaskStats.calls++;
  await execFileAsync("python3", [tmpScript, inputPath, tmpOut], {
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const result = await readFile(tmpOut);

  // Cleanup temp files
  try { await (await import("node:fs/promises")).unlink(tmpScript); } catch {}
  try { await (await import("node:fs/promises")).unlink(tmpOut); } catch {}

  await writeFile(cachePath, result);
  return result;
}
