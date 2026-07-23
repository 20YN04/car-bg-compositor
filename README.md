# car-bg-compositor

Lokale test-tool voor achtergrondvervanging bij auto-foto's. Valideert of
automatische background removal (fal.ai BiRefNet) + puur mathematische
compositing (sharp) goed genoeg is voor verkoopfoto's, vóór er een
productie-pipeline omheen wordt gebouwd.

De kern: masking en compositing zijn strikt gescheiden. Het alfamasker raakt
de originele pixels niet aan en de compositing is puur mathematisch — velgen,
badges en koplampen kunnen dus per definitie niet vervormen, in tegenstelling
tot generatieve modellen die het beeld hertekenen.

## Setup

```sh
pnpm install
cp .env.example .env   # en vul FAL_KEY in (https://fal.ai/dashboard/keys)
```

Leg inputfoto's (jpg/png) in `./in/`. Bij de eerste run wordt automatisch een
neutrale gradient-achtergrond gegenereerd in `./backgrounds/default.png`;
eigen achtergronden kun je daarnaast in `./backgrounds/` leggen.

## Gebruik

```sh
pnpm start                          # alles in ./in/
pnpm start --file foo.jpg           # één beeld
pnpm start --bg studio-grey.jpg     # andere achtergrond (uit ./backgrounds/)
pnpm start --ground-y 1100          # config overriden zonder file-edit
pnpm start --car-width 0.75         # idem
pnpm start --no-cache               # forceer nieuwe API-call
pnpm start --no-debug               # sla debug-output over
```

Resultaten komen in `./out/` (JPEG). Per beeld verschijnt in `./debug/` het
ruwe masker, een overlay met de bbox (rood) en de berekende grondlijn (groen),
en een JSON-regel in `run.jsonl` met bbox, grondlijn, schaal, eindpositie en
QA-resultaat — zodat je kunt zien *waarom* een beeld verkeerd geplaatst is.

Maskers worden gecachet in `./cache/` op sha256 van de input-bytes: herhaald
draaien (bijv. tijdens het tunen van de compositing) kost geen API-credits.

## Config tunen (`src/config.ts`)

| Parameter | Wat je ermee aanpast |
| --- | --- |
| `CANVAS` | uitvoerformaat (default 1920×1440) |
| `GROUND_Y` | y-coördinaat waar de banden staan — hoger getal = auto lager in beeld |
| `CAR_WIDTH_RATIO` | hoe breed de auto in beeld staat (fractie canvasbreedte) |
| `ALPHA_THRESHOLD` | vanaf welke alfawaarde een pixel als "auto" telt |
| `GROUND_PERCENTILE` | robuustheid van de grondlijn; 0.95 negeert de laagste 5% kolommen (uitschieters zoals meegemaskte schaduw) |
| `ERODE_MASK` | 1px erosie van het masker tegen kleurhalo's van de originele achtergrond |
| `MASK_CLEAN` | opschoning via morfologische opening: dunne/losstaande mee-gemaskeerde structuren (windmolen, paal, lantaarn) verdwijnen, de autorand blijft onaangetast |
| `SHADOW` | contactschaduw: breedte t.o.v. auto, hoogte, blur, dekking, offset |
| `JPEG_QUALITY` | uitvoerkwaliteit |
| `QA` | drempels voor de kwaliteitswaarschuwingen |
| `FAL` | BiRefNet-variant en resolutie (default "General Use (Heavy)" @ 2048×2048) |
| `COST_PER_CALL_USD` | prijs per API-call voor de kostenschatting — ijken op het fal-dashboard |

## Kwaliteitscontrole

Niet-blokkerende waarschuwingen per beeld, gegroepeerd in de eindsamenvatting:
te klein/groot masker, auto afgesneden aan de onderrand (grondlijn
onbetrouwbaar), bbox raakt een beeldrand, aspect ratio die niet op een
volledige auto wijst (interieur/detailshot), meerdere losse blobs in het
masker, plaatsing buiten het canvas.

## Tests

```sh
pnpm test        # unit tests voor bbox/grondlijn en plaatsing (geen API-calls)
pnpm typecheck
```
