import "dotenv/config";
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
import { defaultConfig } from "./config.js";
import { mountPlate } from "./plate.js";
import { assertPlate, plateDeviation } from "./background.js";
import { geminiText } from "./gemini.js";

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

/**
 * Taken overleven een herstart. De takenlijst stond alleen in het geheugen:
 * stierf de container halverwege, dan was de taak weg en pollde de app een
 * task_id die niemand meer kende — terwijl de pipeline-cache het werk juist
 * bijna gratis kan afmaken (gemeten: een identieke herrun deed 0 calls en
 * 135 cache-hits). Elke taak staat daarom op schijf (zonder de zware
 * beeldbytes — die staan al in out/), en bij het opstarten wordt alles wat
 * open stond opnieuw in de wachtrij gezet (Yentl, 2026-08-05).
 */
const JOBS_DIR = process.env["JOBS_DIR"] ?? "./jobs";

interface JobRecord {
  taskId: string;
  carId: number;
  state: Job["state"];
  urls: string[];
  spec: string | null;
  error: string | null;
}

async function bewaarJob(rec: JobRecord): Promise<void> {
  try {
    await mkdir(JOBS_DIR, { recursive: true });
    await writeFile(path.join(JOBS_DIR, `${rec.taskId}.json`), JSON.stringify(rec));
  } catch {
    // persistentie mag een taak nooit breken
  }
}

const jobs = new Map<string, Job>();

/**
 * Plaatmontage als batchtaak: dezelfde deterministische Carredo-plaat als in
 * de AI-renders (Florence vindt de houder, SAM2 het vlak, de plaat-PNG wordt
 * gewarpt), maar dan over aangeleverde beelden — bedoeld voor de
 * spin360-frames, zodat de draaibare viewer exact dezelfde plaat toont als
 * thumbnail en rondgang (Yentl, 2026-08-05). Frames zonder detecteerbare
 * plaat (zuivere zijaanzichten) gaan onaangeroerd terug, met reden.
 * Bewust zonder crash-resume: een spin is in minuten opnieuw te posten
 * vanuit de framesmap; de zware taken hebben die zorg wél.
 */
interface PlaatBeeld {
  name: string;
  bytes_b64: string;
  mounted?: boolean;
  reason?: string;
}
interface PlaatJob {
  taskId: string;
  state: Job["state"];
  images: PlaatBeeld[] | null;
  error: string | null;
}
const plaatJobs = new Map<string, PlaatJob>();

async function verwerkPlaat(job: PlaatJob, beelden: PlaatBeeld[]): Promise<void> {
  job.state = "STARTED";
  try {
    const uit: PlaatBeeld[] = [];
    for (const b of beelden) {
      try {
        const res = await mountPlate(
          Buffer.from(b.bytes_b64, "base64"), defaultConfig.PLATE, "./cache", true,
        );
        uit.push(res.mounted
          ? { name: b.name, bytes_b64: res.image.toString("base64"), mounted: true }
          : { name: b.name, bytes_b64: b.bytes_b64, mounted: false, reason: res.reason });
      } catch (err) {
        uit.push({
          name: b.name, bytes_b64: b.bytes_b64, mounted: false,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    job.images = uit;
    job.state = "SUCCESS";
  } catch (err) {
    job.error = err instanceof Error ? err.message : String(err);
    job.state = "FAILURE";
  }
}
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
  await bewaarJob({
    taskId: job.taskId, carId: job.carId, state: job.state, urls, spec, error: null,
  });
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
    // dezelfde plate-poort als in de pipeline, op de bytes die de deur
    // uitgaan: ook een thumbnail die al in out/ stond (de pipeline laat die
    // ongemoeid) wordt nooit verstuurd met een andere achtergrond
    const afwijking = await plateDeviation(bytes, defaultConfig.SYNTH.backgroundPlatePath);
    if (afwijking) throw new Error(`${afwijking} — niet verstuurd`);
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
  await bewaarJob({
    taskId: job.taskId, carId: job.carId, state: job.state, urls, spec,
    error: job.error,
  });
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
    // De Carredo-app stuurt X-API-Key (SCRAPER_API_KEY); eigen aanroepen
    // gebruiken X-Internal-Key. Beide gelden — zelfde sleutel, andere naam.
    const sleutel = req.headers["x-internal-key"] ?? req.headers["x-api-key"];
    if (SERVICE_KEY && sleutel !== SERVICE_KEY) {
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
      void bewaarJob({
        taskId: job.taskId, carId: job.carId, state: job.state,
        urls: [...new Set(urls)], spec, error: null,
      });
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

    // Spec-dubbelcheck voor de acquisitie-stap: één tekstoordeel dat de
    // ingevoerde voertuigdata naast de foto's legt en concrete mismatches
    // teruggeeft ("listing zegt grijs, foto's tonen blauw"). Synchronoon —
    // één Gemini-call plus wat downloads, bedoeld voor een knop in de modal.
    // Vangt scraperfouten vóór ze een auto in gaan: een spec die de foto's
    // tegenspreekt is de duurste faalwijze van de hele pipeline.
    if (req.method === "POST" && url.pathname === "/images/spec-check") {
      const body = (await leesBody(req)) as { source_urls?: unknown; vehicle?: unknown };
      const urls = (Array.isArray(body.source_urls) ? body.source_urls : [])
        .filter((u): u is string => typeof u === "string" && u.length > 0)
        .slice(0, 6);
      if (urls.length === 0 || !body.vehicle || typeof body.vehicle !== "object") {
        return json(res, 400, { error: "source_urls en vehicle zijn verplicht" });
      }
      const fotos: { data: Buffer }[] = [];
      for (const u of urls) {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(15_000) });
          if (r.ok) fotos.push({ data: Buffer.from(await r.arrayBuffer()) });
        } catch { /* onbereikbare foto telt niet mee */ }
      }
      if (fotos.length === 0) return json(res, 400, { error: "geen van de foto's was downloadbaar" });
      try {
        const prompt =
          "These photos show one car offered for sale. The listing data " +
          `claims:\n${JSON.stringify(body.vehicle, null, 2)}\n` +
          "List every CONCRETE mismatch between that data and what the " +
          "photos actually show — colour, body type, apparent model or " +
          "generation, door count, obvious trim details. Judge only what " +
          "the photos can prove; lighting shifts and unreadable details " +
          "are not mismatches. Answer with STRICT JSON only, no code " +
          'fences: {"warnings": string[]} — empty when data and photos agree.';
        const raw = await geminiText(fotos, prompt, defaultConfig.GEMINI, "./cache", true);
        const m = raw.match(/\{[\s\S]*\}/);
        const obj = m ? (JSON.parse(m[0]) as { warnings?: unknown }) : {};
        return json(res, 200, {
          warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : [],
          photos_checked: fotos.length,
        });
      } catch (err) {
        return json(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (req.method === "POST" && url.pathname === "/images/plate/enqueue") {
      const body = (await leesBody(req)) as { images?: unknown };
      const beelden = (Array.isArray(body.images) ? body.images : [])
        .filter((b): b is { name?: unknown; bytes_b64?: unknown } => typeof b === "object" && b !== null)
        .map((b) => ({ name: String(b.name ?? "frame"), bytes_b64: String(b.bytes_b64 ?? "") }))
        .filter((b) => b.bytes_b64.length > 0);
      if (beelden.length === 0) return json(res, 400, { error: "images ontbreken" });
      if (beelden.length > 80) return json(res, 400, { error: "max 80 beelden per taak" });
      const job: PlaatJob = { taskId: randomUUID(), state: "PENDING", images: null, error: null };
      plaatJobs.set(job.taskId, job);
      wachtrij.push(() => verwerkPlaat(job, beelden));
      volgende();
      return json(res, 200, { task_id: job.taskId, state: job.state });
    }

    const plaatPoll = url.pathname.match(/^\/images\/plate\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && plaatPoll) {
      const job = plaatJobs.get(plaatPoll[1]!);
      if (!job) return json(res, 404, { error: "onbekende taak" });
      return json(res, 200, {
        task_id: job.taskId,
        state: job.state,
        ready: job.state === "SUCCESS" || job.state === "FAILURE",
        result: job.state === "SUCCESS" ? { images: job.images } : null,
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

async function hervatOpenTaken(): Promise<void> {
  if (!existsSync(JOBS_DIR)) return;
  let hervat = 0;
  for (const f of (await readdir(JOBS_DIR)).filter((x) => x.endsWith(".json"))) {
    try {
      const rec = JSON.parse(await readFile(path.join(JOBS_DIR, f), "utf8")) as JobRecord;
      if (rec.state === "SUCCESS" || rec.state === "FAILURE") continue;
      const job: Job = {
        taskId: rec.taskId, carId: rec.carId, state: "PENDING",
        result: null, error: null, log: [],
      };
      jobs.set(job.taskId, job);
      wachtrij.push(() => verwerk(job, rec.urls, rec.spec));
      hervat++;
    } catch {
      // een kapot record slaan we over; de app kan opnieuw enqueuen
    }
  }
  if (hervat > 0) {
    console.log(`${hervat} open ta(a)k(en) hervat na herstart — de pipeline-cache maakt dit goedkoop`);
    volgende();
  }
}

// Zonder leesbare studio-plate kan geen enkele taak slagen: niet opstarten,
// in plaats van taken te aanvaarden die pas na minuten generatie falen.
try {
  await assertPlate(defaultConfig.SYNTH.backgroundPlatePath);
} catch (err) {
  console.error(`thumbnail-service start niet: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

void hervatOpenTaken();

server.listen(PORT, () => {
  console.log(
    `thumbnail-service op :${PORT} — enqueue: POST /images/thumbnail/enqueue · ` +
      `webhook: ${WEBAPP_URL && INTERNAL_KEY ? "aan" : "uit (alleen poll)"}`,
  );
});
