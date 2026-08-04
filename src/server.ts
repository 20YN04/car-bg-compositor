/**
 * HTTP-koppelvlak voor Carredo, in het dialect dat hun Next-app al spreekt.
 *
 * De Carredo-app praat vandaag tegen de Python-scraper (Celery) via:
 *   POST /images/thumbnail/enqueue  { car_id, mode, source_url, spec, watermark }
 *   GET  /images/thumbnail/{task_id}
 *   → webhook POST {WEBAPP_URL}/api/internal/thumbnail-result/{car_id}
 *     met X-Internal-Key en ThumbnailJobResult
 *     { car_id, status, bytes_b64, content_type, attempts, error, source_mode }.
 *
 * Deze server spreekt exact datzelfde contract, zodat de overstap aan
 * Carredo-kant later één env-var is (SCRAPER_API_URL → deze service) in
 * plaats van nieuw loodgieterswerk. Bewuste afwijkingen:
 *
 * - `source_urls: string[]` wordt geaccepteerd naast hun enkele `source_url`.
 *   Onze poorten vergelijken de kandidaat met de bronfoto's; hoe meer foto's,
 *   hoe strenger de bewaking. Bij één foto draait alles gewoon, maar de
 *   identiteits- en geometriepoorten hebben dan minder houvast.
 * - `mode: "text_only"` wordt geweigerd (400). Zonder bronfoto's valt er
 *   niets te verifiëren en is elk resultaat per definitie een verzinsel —
 *   dat pad blijft bij Carredo's bestaande nano-banana-route.
 * - `watermark` wordt genegeerd: de uitvoer is een schone studiofoto met de
 *   Carredo-plaat, geen watermerk.
 *
 * Jobs draaien één tegelijk (zelfde keuze als hun Celery-worker met
 * prefetch 1): het Gemini-dagquotum is per model, en twee gelijktijdige
 * auto's verdubbelen alleen het risico dat beide halverwege stranden.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { bouwSpec, type VehicleData } from "./spec.js";

const PORT = Number(process.env["PORT"] ?? 8801);
/** Optionele gedeelde sleutel; staat hij in .env, dan is hij verplicht. */
const SERVICE_KEY = process.env["SERVICE_API_KEY"] ?? null;
/** Webhook terug naar de Carredo-app; zonder deze twee env-vars alleen poll. */
const WEBAPP_URL = process.env["WEBAPP_URL"] ?? null;
const INTERNAL_KEY = process.env["INTERNAL_API_KEY"] ?? null;

interface ThumbnailJobResult {
  car_id: number;
  status: "ok" | "failed";
  bytes_b64: string | null;
  content_type: string;
  attempts: number;
  error: string | null;
  source_mode: "image_to_image";
}

interface Job {
  taskId: string;
  carId: number;
  state: "PENDING" | "STARTED" | "SUCCESS" | "FAILURE";
  result: ThumbnailJobResult | null;
  error: string | null;
  log: string[];
}

const jobs = new Map<string, Job>();
const wachtrij: Array<() => Promise<void>> = [];
let bezig = false;

function volgende(): void {
  if (bezig) return;
  const taak = wachtrij.shift();
  if (!taak) return;
  bezig = true;
  void taak().finally(() => {
    bezig = false;
    volgende();
  });
}

async function downloadBronnen(dir: string, urls: string[]): Promise<number> {
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const url of urls) {
    const res = await fetch(url);
    if (!res.ok) continue;
    const bytes = Buffer.from(await res.arrayBuffer());
    // hash in de naam: dezelfde URL twee keer aanleveren maakt geen dubbels
    const naam = `bron-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.jpg`;
    await writeFile(path.join(dir, naam), bytes);
    n++;
  }
  return n;
}

/** Draait de bestaande CLI-pipeline als kindproces — de pipeline zelf weet
 * niets van HTTP en dat houden we zo; alle poorten blijven ongewijzigd. */
function draaiPipeline(mapNaam: string, job: Job): Promise<number> {
  return new Promise((resolve) => {
    const kind = spawn("npx", ["tsx", "src/index.ts", "--synth", mapNaam], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lees = (buf: Buffer): void => {
      for (const r of buf.toString().split("\n")) {
        const t = r.trim();
        if (t.length > 0) job.log.push(t.slice(0, 200));
      }
      if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
    };
    kind.stdout.on("data", lees);
    kind.stderr.on("data", lees);
    kind.on("close", (code) => resolve(code ?? 1));
  });
}

async function stuurWebhook(result: ThumbnailJobResult): Promise<void> {
  if (!WEBAPP_URL || !INTERNAL_KEY) return;
  const url = `${WEBAPP_URL.replace(/\/$/, "")}/api/internal/thumbnail-result/${result.car_id}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "X-Internal-Key": INTERNAL_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) console.warn(`webhook ${res.status} voor auto ${result.car_id}`);
  } catch (err) {
    // fire-and-forget, net als hun Celery-taak: de poll blijft als vangnet
    console.warn(`webhook mislukt voor auto ${result.car_id}: ${err instanceof Error ? err.message : err}`);
  }
}

async function verwerk(job: Job, urls: string[], spec: string | null): Promise<void> {
  job.state = "STARTED";
  const mapNaam = `car-${job.carId}`;
  const inDir = path.resolve(import.meta.dirname, "..", "in", mapNaam);
  const outFile = path.resolve(import.meta.dirname, "..", "out", mapNaam, "thumbnail.jpg");
  try {
    const n = await downloadBronnen(inDir, urls);
    if (n === 0) throw new Error("geen van de bronfoto's was downloadbaar");
    if (spec && spec.trim().length > 0) {
      await writeFile(path.join(inDir, "vehicle.txt"), spec.trim() + "\n");
    }
    const code = await draaiPipeline(mapNaam, job);
    if (!existsSync(outFile)) {
      const staart = job.log.slice(-5).join(" · ");
      throw new Error(`pipeline eindigde met code ${code} zonder thumbnail — ${staart}`);
    }
    const bytes = await readFile(outFile);
    job.result = {
      car_id: job.carId,
      status: "ok",
      bytes_b64: bytes.toString("base64"),
      content_type: "image/jpeg",
      attempts: 1,
      error: null,
      source_mode: "image_to_image",
    };
    job.state = "SUCCESS";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    job.error = msg;
    job.result = {
      car_id: job.carId, status: "failed", bytes_b64: null,
      content_type: "image/jpeg", attempts: 1, error: msg,
      source_mode: "image_to_image",
    };
    job.state = "FAILURE";
  }
  await stuurWebhook(job.result);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
}

async function leesBody(req: http.IncomingMessage): Promise<unknown> {
  const delen: Buffer[] = [];
  for await (const chunk of req) delen.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(delen).toString() || "{}");
}

const server = http.createServer((req, res) => {
  void (async () => {
    if (SERVICE_KEY && req.headers["x-internal-key"] !== SERVICE_KEY) {
      return json(res, 403, { error: "forbidden" });
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    // De Carredo-app prefixt scraper-paden met /api/v1 — beide vormen
    // accepteren houdt de wissel aan hun kant op één env-var.
    url.pathname = url.pathname.replace(/^\/api\/v1(?=\/)/, "");

    if (req.method === "POST" && url.pathname === "/images/thumbnail/enqueue") {
      const body = (await leesBody(req)) as {
        car_id?: unknown; mode?: unknown; source_url?: unknown;
        source_urls?: unknown; spec?: unknown; vehicle?: unknown;
      };
      const carId = Number(body.car_id);
      if (!Number.isFinite(carId)) return json(res, 400, { error: "car_id ontbreekt" });
      if (body.mode === "text_only") {
        return json(res, 400, {
          error: "text_only wordt hier bewust niet ondersteund: zonder bronfoto's " +
            "valt er niets te verifiëren. Gebruik de bestaande route voor auto's zonder foto's.",
        });
      }
      const urls = [
        ...(Array.isArray(body.source_urls) ? body.source_urls : []),
        ...(typeof body.source_url === "string" ? [body.source_url] : []),
      ].filter((u): u is string => typeof u === "string" && u.length > 0);
      if (urls.length === 0) return json(res, 400, { error: "source_url(s) ontbreken" });

      const job: Job = {
        taskId: randomUUID(), carId, state: "PENDING",
        result: null, error: null, log: [],
      };
      jobs.set(job.taskId, job);
      // spec-prioriteit: expliciete tekst wint; anders bouwt de template hem
      // uit de databasevelden — Carredo hoeft geen prompt-taal te kennen
      const spec = typeof body.spec === "string" && body.spec.trim().length > 0
        ? body.spec
        : body.vehicle && typeof body.vehicle === "object"
          ? bouwSpec(body.vehicle as VehicleData)
          : null;
      wachtrij.push(() => verwerk(job, [...new Set(urls)], spec));
      volgende();
      return json(res, 200, { task_id: job.taskId, state: job.state });
    }

    const poll = url.pathname.match(/^\/images\/thumbnail\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && poll) {
      const job = jobs.get(poll[1]!);
      if (!job) return json(res, 404, { error: "onbekende taak" });
      return json(res, 200, {
        task_id: job.taskId,
        state: job.state,
        ready: job.state === "SUCCESS" || job.state === "FAILURE",
        result: job.state === "SUCCESS" ? job.result : null,
        error: job.state === "FAILURE" ? job.error : null,
      });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, wachtrij: wachtrij.length, bezig });
    }
    return json(res, 404, { error: "onbekend pad" });
  })().catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(PORT, () => {
  console.log(
    `thumbnail-service op :${PORT} — enqueue: POST /images/thumbnail/enqueue · ` +
      `webhook: ${WEBAPP_URL && INTERNAL_KEY ? "aan" : "uit (alleen poll)"}`,
  );
});
