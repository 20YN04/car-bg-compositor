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
node scripts/make-studio-bg.mjs     # genereer de carredo-achtige studioplate (eenmalig)
pnpm start --bg studio.png          # composite op die studioplate
pnpm start --file foo.jpg           # één beeld
pnpm start --bg studio-grey.jpg     # andere achtergrond (uit ./backgrounds/)
pnpm start --ground-y 1100          # config overriden zonder file-edit
pnpm start --car-width 0.75         # idem
pnpm start --no-cache               # forceer nieuwe API-calls
pnpm start --no-debug               # sla debug-output over
pnpm start --no-ai                  # sla plaat-anonimisatie + AI-checks over
pnpm start --no-detect              # sla auto-detectie over (onbegrensd masker)
pnpm start --plate replace          # plaat vervangen i.p.v. blurren (of: off)
pnpm start --no-windows             # ruiten niet donker tinten
pnpm start --no-harmonize           # kleur/belichting niet matchen
pnpm start --preset side            # per-hoek kadrering (side/front34/rear34)
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
| `DETECT` | instance-aware masking: Florence-2 detecteert de auto en het masker wordt tot die box begrensd (weert slagschaduw op de grond en aangeplakte achtergrondobjecten). `minConfidence` werkt op een heuristische score (oppervlak × centraliteit) — Florence geeft zelf geen confidence |
| `PLATE` | nummerplaat-anonimisatie: `blur` (default, GDPR), `replace` (plaat met `AI.plateText` of `overlayPath`), `off`; `style` gaussian of mosaic |
| `AI` | plaatdetectie (Florence-2) en AI-kwaliteitscontroles via een vision-model (masker compleet? auto op de grond?) |
| `WINDOWS` | ruiten donker tinten (Florence-2-detectie + SAM2-masker + wiskundige verdonkering) zodat de oorspronkelijke omgeving niet door het glas zichtbaar blijft; `tintOpacity`/`tintColor`/`featherSigma` bepalen de look |
| `MATTE` | instance-matte: BiRefNet-alfa begrensd met een SAM2-instancemasker (auto-box als prompt) — scherpe wielranden, geen aangesmolten grondschaduw |
| `BACKGROUND_PROFILES` | kalibratie per achtergrond-plate: `contactTargetY` (vloerlijn), `floorScaleRef` (px/m), lichtrichting/zachtheid, vloerreflectiviteit. **Belangrijk:** de camerahoogte/-hoek van de plate moet bij de auto-shots passen; willekeurige plates werken niet — een mismatch is een plate-keuzeprobleem, geen codebug |
| `HARMONIZE` | kleur/belichting van de auto subtiel richting de achtergrondtoon (per-kanaal gains met cap) — puur curves, geen generatieve stap |
| `HIGHLIGHTS` | specular-compressie: dempt felle reflecties van de oorspronkelijke omgeving (tl-balken, spots) in de lak via een soft-knee curve; de knee schuift adaptief mee met de autohelderheid zodat een witte auto niet afvlakt |
| `PRESETS` | per-hoek kadrering (side/front34/rear34): eigen spanwijdte en optioneel contactlijn |
| `MONTHLY_VOLUME` | beeldvolume voor de kostenextrapolatie (default 75.000) |
| `COST_PER_CALL_USD` | prijs per API-call voor de kostenschatting — ijken op het fal-dashboard |

## Kwaliteitscontrole

Niet-blokkerende waarschuwingen per beeld, gegroepeerd in de eindsamenvatting:

- `EMPTY_MASK`, `MASK_TOO_SMALL`, `MASK_TOO_LARGE` — masker leeg of buiten de oppervlaktegrenzen
- `CUT_OFF_BOTTOM` — auto afgesneden aan de onderrand, grondlijn onbetrouwbaar
- `TOUCHES_EDGE` — bbox raakt een andere beeldrand
- `BAD_ASPECT` — aspect ratio wijst niet op een volledige auto (interieur/detailshot)
- `MULTIPLE_BLOBS` — meerdere losse blobs in het masker
- `SHADOW_IN_MASK` — onderste rijen genegeerd bij de grondlijn (uitwaaierende slagschaduw)
- `BACKGROUND_MERGE_SUSPECT` — masker stak buiten de auto-box of heeft een bult boven de daklijn
- `NO_CAR_DETECTED` — detector vond geen auto; masker onbegrensd (oude gedrag)
- `STRAY_MASK_REMOVED` — dun/losstaand materiaal opgeschoond (windmolen, paal)
- `OUT_OF_CANVAS` — plaatsing valt (deels) buiten het canvas
- `PLATE_NOT_FOUND` — geen plaat gedetecteerd, dus niet geanonimiseerd
- `AI_MASK_SUSPECT`, `AI_NOT_GROUNDED` — het vision-model twijfelt aan masker of aarding

## Nummerplaat en AI-controles

Per beeld wordt de nummerplaat gedetecteerd (`fal-ai/florence-2-large/
caption-to-phrase-grounding`) en geanonimiseerd volgens `PLATE.mode`:
geblurd (default — GDPR, EU/België), vervangen door een getekende plaat met
`AI.plateText` (of een eigen `overlayPath`-afbeelding), of onaangeraakt
(`off`). Alles puur mathematisch — geen generatieve bewerking.
Daarnaast beoordeelt een klein vision-model (`fal-ai/moondream2/visual-query`)
per beeld of het masker compleet oogt en of de auto in het eindbeeld op de
grond staat; een afwijzing verschijnt als `AI_MASK_SUSPECT` / `AI_NOT_GROUNDED`
in de samenvatting. Alle AI-resultaten worden gecachet op content-hash.

Bekende beperking: de plaatoverlay volgt de detectie-bbox (axis-aligned), niet
het perspectief van de plaat. Bij schuine hoeken kan de plaat er daardoor wat
recht/vierkant uitzien. Perspectiefcorrecte vervanging vergt hoekpuntdetectie
en hoort bij de productie-pipeline, niet bij deze testtool.

## Tests

```sh
pnpm test        # unit tests voor bbox/grondlijn en plaatsing (geen API-calls)
pnpm typecheck
```
