# Koppeling met de Carredo-app

Deze repo levert de gepoorte thumbnail (studiobeeld, 3:2, Carredo-plaat) als
HTTP-service in **exact het dialect dat de Carredo-app al spreekt** tegen de
Python-scraper. De overstap aan Carredo-kant is daardoor later één wijziging:
de thumbnail-enqueue op deze service richten in plaats van op de scraper.
Er is aan de Carredo-repo niets aangepast en deze service vereist dat ook niet
— hij is er klaar voor.

## Contract (identiek aan de scraper-route)

```
POST /images/thumbnail/enqueue
  { "car_id": 123, "mode": "image_to_image",
    "source_url": "https://…/foto1.webp",          ← bestaand veld werkt
    "source_urls": ["https://…/1.webp", "…"],       ← nieuw, méér foto's = strengere poorten
    "spec": "2023 Volkswagen ID.3 Pro wit hatchback" }
  → { "task_id": "<uuid>", "state": "PENDING" }

GET /images/thumbnail/{task_id}
  → { "task_id", "state": PENDING|STARTED|SUCCESS|FAILURE, "ready",
      "result": ThumbnailJobResult | null, "error" }

Webhook (indien WEBAPP_URL + INTERNAL_API_KEY gezet):
  POST {WEBAPP_URL}/api/internal/thumbnail-result/{car_id}
  header X-Internal-Key, body ThumbnailJobResult — het bestaande Carredo-
  endpoint slikt dit ongewijzigd; `persistThumbnailResult` schrijft R2 +
  Car.generatedThumbnailUrl zoals nu.
```

`ThumbnailJobResult` is hun bestaande vorm: `{ car_id, status: "ok"|"failed",
bytes_b64, content_type, attempts, error, source_mode }`.

## Bewuste afwijkingen van de scraper-route

- **`text_only` wordt geweigerd (400).** Onze waarde zit in de poorten:
  identiteit, lak, geometrie en scherpte worden gemeten tégen de bronfoto's.
  Zonder foto's valt er niets te verifiëren en is elk beeld per definitie een
  verzinsel. Auto's zonder foto's blijven op Carredo's bestaande route.
- **`source_urls` (meervoud) is de aanbevolen invoer.** De huidige app stuurt
  alleen `images[0]`; dat werkt, maar met álle exterieurfoto's hebben de
  identiteits- en geometriepoorten meer houvast. Dit is de enige wijziging aan
  Carredo-kant die de kwaliteit direct verhoogt.
- **`watermark` wordt genegeerd** — de uitvoer is een schone studiofoto met de
  Carredo-kentekenplaat, geen wordmark-overlay.
- **`spec` gaat als `vehicle.txt` de pipeline in.** Hun `buildCarSpec()`-vorm
  ("2021 BMW X3 white SUV (automatic, electric)") is bruikbaar; een rijkere
  beschrijving (uitvoering, velgen, dak) maakt de generatie beter. Optionele
  eerste regel `wielbasis: 4.11` activeert de geometriepoort ook zonder
  zijaanzicht.

## Draaien

```bash
npm run serve            # poort 8801
```

| env | betekenis |
| --- | --- |
| `PORT` | poort (standaard 8801) |
| `SERVICE_API_KEY` | indien gezet: verplichte `X-Internal-Key` op álle endpoints |
| `WEBAPP_URL` | Carredo-app-URL voor de webhook (zonder: alleen poll) |
| `INTERNAL_API_KEY` | dezelfde secret die de app al kent voor `/api/internal/*` |
| `GEMINI_API_KEY`, `FAL_KEY` | zoals voor de CLI |

Jobs draaien één tegelijk (zelfde keuze als hun Celery-worker met prefetch 1):
het Gemini-dagquotum is per model. Een run duurt 5–20 minuten; de webhook is
daarom de aangewezen route, de poll het vangnet — precies zoals hun huidige
opzet.

## Wat er aan Carredo-kant ooit moet gebeuren (niet nu, niets is aangepast)

1. Thumbnail-enqueue op deze service richten (env-var of aparte
   `THUMBNAIL_API_URL`).
2. Aanbevolen: `source_urls` met alle exterieurfoto's meesturen in plaats van
   alleen `images[0]`.
3. `text_only`-auto's op de bestaande scraper-route laten.

## Spec uit data (aanbevolen route)

Naast `spec` (vrije tekst) accepteert de enqueue een `vehicle`-object met
databasevelden (make/model/trim/year/body/colour/packages/wheels/badges/
wheelbaseM/lengthM/notes); een vaste template (`src/spec.ts`) vertaalt dat
server-side naar de spec. De template kan per constructie niets beweren
zonder data — de les van de handgeschreven specs. `badges` is het veld waar
menselijke bevestiging landt; de badge-census bewaakt die lijst limitatief.
Expliciete `spec` wint wanneer beide aanwezig zijn.
