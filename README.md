# car-bg-compositor

Genereert per auto exact één listing-thumbnail uit een map dealerfoto's:
de canonieke 3/4-vóór-rechts-hoek in een lichte studio (3:2), via
Gemini 3 Pro image (Nano Banana Pro) — bewaakt door een reeks poorten die
garanderen dat het exact dezelfde auto is.

De oude deterministische compositing-pipeline (matte + sharp op een vaste
studioplate) is op 2026-07-30 verwijderd; hij staat integraal onder de
git-tag `composiet-pipeline-v1`.

## Setup

```sh
pnpm install
```

`.env` op basis van `.env.example`:

- `GEMINI_NANO_BANANA_API_KEY` — verplicht (identificatie, synthese, inspecties)
- `FAL_KEY` — alleen voor de lakmeting via fal-rmbg (default); zonder key:
  `--matte rembg` (lokaal, gratis, `pip3 install rembg`)

## Gebruik

```sh
pnpm start --synth VanMossel        # dé thumbnail voor in/VanMossel/
pnpm start                          # toont de beschikbare auto-mappen
pnpm start --synth X --matte rembg  # lakmeting lokaal i.p.v. via fal
pnpm start --synth X --no-cache     # forceer nieuwe API-calls
```

Leg per auto één map met foto's (jpg/png) in `./in/`. Het resultaat is
altijd `out/<map>/thumbnail.jpg` — het enige bestand in die map.

## Hoe het werkt

1. **Identificatie** — Gemini benoemt het exacte model uit álle foto's
   (merk, generatie, uitvoering, lak, velgen, opties). Die spec gaat in elke
   volgende prompt mee.
2. **Synthese** — Gemini reconstrueert de canonieke hoek. Het vaste
   **compositie-anker** (`assets/thumbnail-composition-anchor.jpg`, de eerste
   goedgekeurde thumbnail) dicteert camera, positie, achtergrond en licht —
   nooit de karrosserie: de auto houdt zijn eigen proporties uit de bron.
3. **Poorten**, per poging (afwijkingen gaan als correctie-feedback de
   volgende poging in; max 3 pogingen, daarna wordt er níets geschreven):
   - *dimensie*: output moet op het vaste 3:2-raster liggen (2528×1696 bij
     2K, gemeten 2026-07-30)
   - *identiteit*: VLM-inspectie tegen de bronfoto's (model, velgen, badges,
     lichten, trim, …)
   - *lak*: deterministische meting — gemiddelde lak van de kandidaat (via
     de matte) tegen de mediaan van de bronfoto's, luminantieratio
     0.85–1.15 en tintdelta's ≤ 0.05. Wijkt alléén de meting af, dan wordt
     de lak per-kanaal exact naar de bron-mediaan gecorrigeerd en nagemeten
   - *proporties*: gerichte vraag op wielbasis/lengte/overhangen — een
     samengedrukte of uitgerekte koets wordt afgekeurd
4. **Publicatie** — het goedgekeurde beeld ís het eindresultaat; de lege
   plaathouder blijft zoals gegenereerd (geen leesbaar kenteken, per
   constructie GDPR-veilig).

## Bescherming van goedgekeurde beelden

Een bestaande `thumbnail.jpg` wordt **nooit** stil vervangen — hergenereren
is non-deterministisch en kan slechter uitvallen dan wat er staat. Bewust
opnieuw? Verwijder het bestand eerst. Elke geaccepteerde kandidaat staat
bovendien duurzaam in `cache/accepted-synth-<map>.jpg`.

## Kosten

Per auto grofweg $0.10–0.25: één identificatie, 1–3 generaties en per
poging twee inspecties, plus ~$0.002/foto voor de eenmalige lakmeting.
Alle calls zijn gecachet op content-hash in `./cache/` — herhaald draaien
is gratis.

## Tests

```sh
pnpm test        # poorten-logica: verdict-parsing, lakmeting, correctie
pnpm typecheck
```
