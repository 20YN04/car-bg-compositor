# car-bg-compositor

Lokale test-tool voor achtergrondvervanging bij auto-foto's. Valideert of
automatische background removal + puur mathematische compositing (sharp) goed
genoeg is voor verkoopfoto's, vóór er een productie-pipeline omheen wordt
gebouwd.

De kern: masking en compositing zijn strikt gescheiden. Het alfamasker raakt
de originele pixels niet aan en de compositing is puur mathematisch — velgen,
badges en koplampen kunnen dus per definitie niet vervormen, in tegenstelling
tot generatieve modellen die het beeld hertekenen.

De achtergrond is een vaste, gekalibreerde studioplate
(`backgrounds/showroom.jpg`) — geen generatieve stap. Dat maakt de uitvoer
reproduceerbaar en gratis per beeld, en sluit de hele hallucinatieklasse
(tweede auto, podium, verzonnen uitlaten, pseudo-tekst) uit.

## Setup

```sh
pnpm install
pip3 install rembg           # lokale matte, geen API-key nodig
```

De default-pipeline draait volledig lokaal. Alleen de optionele fal.ai-stappen
(auto-detectie, ruit-tint, plaat-anonimisatie, AI-kwaliteitscontrole) vragen
een `FAL_KEY` in `.env` — zonder key slaan die stappen zichzelf over met een
waarschuwing in plaats van het beeld te laten falen.

Leg inputfoto's (jpg/png) in `./in/`. Zonder `--bg` draait de pipeline op
`./backgrounds/showroom.jpg`; ontbreekt die plate, dan valt hij terug op een
automatisch gegenereerde neutrale gradient in `./backgrounds/default.png`.

> Een achtergrond zónder eigen entry in `BACKGROUND_PROFILES` valt terug op
> `DEFAULT_PROFILE` — andere contactdiepte, schaal en reflectie. De pipeline
> waarschuwt daarvoor; kalibreer een nieuwe plate in `src/config.ts`.

## Gebruik

```sh
pnpm start                          # alles in ./in/, op backgrounds/showroom.jpg
pnpm start --target white           # cutout op puur wit, 8:5 — de canonieke referentie
pnpm start --target studio          # geconstrueerde studio-sweep, 3:2 — zoals de live listings
pnpm start --file foo.jpg           # één beeld
pnpm start --bg studio-grey.jpg     # andere achtergrond (uit ./backgrounds/)
pnpm start --matte rembg            # lokale matte (gratis, geen FAL_KEY) — default
pnpm start --rembg-model isnet-general-use   # ander lokaal rembg-model
pnpm start --segment sam3           # SAM 3 i.p.v. Florence-2 + SAM 2 (nog ongeverifieerd)
pnpm start --genbg hero             # generatieve scène aanzetten (default: uit)
pnpm start --ground-y 1100          # config overriden zonder file-edit
pnpm start --car-width 0.75         # idem
pnpm start --no-cache               # forceer nieuwe API-calls
pnpm start --no-debug               # sla debug-output over
pnpm start --no-ai                  # sla plaat-anonimisatie + AI-checks over
pnpm start --no-qa                  # alleen de VLM-kwaliteitschecks uit (plaat blijft)
pnpm start --no-detect              # sla auto-detectie over (onbegrensd masker)
pnpm start --plate replace          # plaat vervangen i.p.v. blurren (of: off)
pnpm start --no-windows             # ruiten niet donker tinten
pnpm start --no-harmonize           # kleur/belichting niet matchen
pnpm start --preset side            # per-hoek kadrering (side/front34/rear34)
pnpm start --synth VanMossel --target white   # dé listing-thumbnail voor deze auto
pnpm start --check-details          # eindbeeld door Gemini langs de bron leggen
```

`--synth <map>` levert per auto exact één thumbnail in de Lizy-stijl: Gemini
identificeert het exacte model uit alle foto's in de map, reconstrueert de
canonieke 3/4-vóór-rechts-hoek (identiteits- én lakpoort, met deterministische
lakcorrectie), en het resultaat gaat door de gewone witte pipeline voor
kadrering, CARREDO-plaat en schaduw. Na afloop bevat `out/<map>/` alléén
`thumbnail.jpg`; een mislukte synthese laat `out/` onaangeroerd.

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
| `MATTE` | instance-matte: het alfa wordt begrensd met een SAM2-instancemasker (auto-box als prompt) — scherpe wielranden, geen aangesmolten grondschaduw. `provider` kiest het matte-model: `rembg` (default, lokaal en gratis; `rembgModel` selecteert `bria-rmbg`/`birefnet-general`/`u2net`) of `fal-rmbg`/`fal-birefnet` via de API |
| `BACKGROUND_PROFILES` | kalibratie per achtergrond-plate: `contactTargetY` (vloerlijn), `floorScaleRef` (px/m), lichtrichting/zachtheid, vloerreflectiviteit. **Belangrijk:** de camerahoogte/-hoek van de plate moet bij de auto-shots passen; willekeurige plates werken niet — een mismatch is een plate-keuzeprobleem, geen codebug |
| `HARMONIZE` | kleur/belichting van de auto subtiel richting de achtergrondtoon (per-kanaal gains met cap) — puur curves, geen generatieve stap |
| `HIGHLIGHTS` | specular-compressie: dempt felle reflecties van de oorspronkelijke omgeving (tl-balken, spots) in de lak via een soft-knee curve; de knee schuift adaptief mee met de autohelderheid zodat een witte auto niet afvlakt |
| `GENBG` | **default uit** sinds de gekalibreerde studioplate er is. Hybride scène-stap (FLUX Fill of Gemini): herschildert achtergrond + contactschaduw + vloerreflectie rond de auto; de originele autopixels gaan er daarna ALTIJD pixel-exact terug overheen. Elke poging passeert een hallucinatie-poort (Florence-telling vreemde auto's via IoU met de eigen positie + VLM-checks op podium/vloermarkering en verzonnen uitlaten, differentieel t.o.v. de cutout); afgekeurd → nieuwe seed, na `maxAttempts` → mathematisch composiet + `GENBG_REJECTED`. Aanzetten met `--genbg hero` (eerste bruikbare foto per batch) of `--genbg all` |
| `GEMINI` | Gemini Nano Banana als GENBG-provider. `aspectRatio` moet de `CANVAS`-verhouding volgen — zonder die instelling levert het model 3:2 terwijl het canvas 4:3 is, en schuift de cover-crop de gegenereerde vloerlijn weg onder de teruggeplakte auto. De seed gaat mee in `generation_config`, niet alleen in de cachesleutel |
| `PRESETS` | per-hoek kadrering (side/front34/rear34): eigen spanwijdte en optioneel contactlijn |
| `MONTHLY_VOLUME` | beeldvolume voor de kostenextrapolatie (default 75.000) |
| `COST_PER_CALL_USD` | prijs per API-call voor de kostenschatting — ijken op het fal-dashboard |

## Set-consistentie

Alle foto's van één auto (= één submap in `./in/`) worden eerst naar een
gedeeld witpunt getrokken — de per-kanaal mediaan over de set — en pas daarna
verschuift de set als geheel naar de plate-toon. Zonder die stap krijgt elke
foto zijn eigen `harmonizeGains` en leest een set die deels in de ochtend en
deels in de namiddag geschoten is als twee verschillende auto's. De mediaan
maakt het robuust tegen één afwijkende opname.

Kost geen extra API-calls: de voorpas leest dezelfde cutout die `processImage`
daarna uit de cache haalt. Uit te zetten met `HARMONIZE.setConsistent: false`.

Dit is de stap die de commerciële pipelines onderscheidt van een
per-foto-script — zie [Spyne over batch-uitvoering per
voertuig](https://www.spyne.ai/blogs/car-photo-editing-for-dealerships-manual-vs-ai).

## Segmentatie: SAM 3 als eenstapsroute

De pipeline lost "vind object X en geef me zijn masker" nu in twee calls op:
Florence-2 maakt boxes uit een tekstprompt, SAM 2 maakt daar maskers van. Dat
is twee modellen en twee foutkansen voor één antwoord — inclusief de bekende
faalmodus dat Florence een lange prompt op "the car" ground en een full-frame
box teruggeeft (vandaar de korte prompts in `WINDOWS.detectPrompts`).

[SAM 3](https://fal.ai/models/fal-ai/sam-3/image/api) (`fal-ai/sam-3/image`,
$0.005/call) doet detectie én segmentatie in één call uit dezelfde tekstprompt,
met per-masker confidence-scores om op te filteren.

**Status: gebouwd maar niet geverifieerd.** `--segment sam3` schakelt de
ruit- en wielstappen om; de plaat- en matte-stappen blijven bewust op het
beproefde pad. Controleer één beeld voordat je een batch draait — let vooral op
de box-conventie: de docs zeggen genormaliseerd `[cx, cy, w, h]`, `toAbsoluteBox`
heeft daar een guard voor maar dat is nog niet tegen een echte respons getest.

## Twee uitvoerdoelen — en waarom dat de moeilijkheid bepaalt

`--target showroom` (default) zet de auto op een fotografische studioplate.
`--target white` levert een cutout op puur wit in 8:5, zoals de referenties in
`carredo-imaging-refs/`.

Dat is geen cosmetische keuze. Op wit bestaan de meeste problemen hieronder
niet: er is geen vloerperspectief om te matchen, geen horizon, geen korrel, en
geen omgeving waarmee de reflecties in de lak kunnen botsen. Het conflict
tussen "wat de lak spiegelt" en "waar de auto staat" verdwijnt omdat er geen
tweede verhaal is. `GRAIN` en `LIGHTWRAP` staan op wit daarom uit — allebei
bestaan ze om tegen een fotografische plate te matchen.

De schaalmodus verschilt ook. In een scene wil je fysieke consistentie
(wielmaat), want daar staat de auto ergens. In een cutout-catalogus wil je
consistente kadervulling ongeacht de hoek. Gemeten op de referenties: 73% en
78% breed, onderkant op 76%, horizontaal gecentreerd.

| | breedte | onderkant | midden-x |
| --- | --- | --- | --- |
| referentie (Kia) | 73% | 76% | 50% |
| lizy_1 (Tesla) | 78% | 76% | 50% |
| onze white-target | 76% | 75–76% | 50% |

Let op: `carredo-imaging-refs/PROMPT.md` schrijft een middelpunt op 45% voor,
maar de referentiebeelden zelf meten allebei 50%. De beelden zijn de
benchmark, niet het document.

## Waarom een composiet "uitgeknipt" leest

Drie meetbare oorzaken, alle drie mathematisch op te lossen — geen generatieve
stap, geen API-call.

| Signaal | Wat het is | Config |
| --- | --- | --- |
| Korrelverschil | de auto draagt cameraruis, de plate is glad. Gemeten 3,4× vóór de fix | `GRAIN` |
| Dichtgeslagen zwart | een contrastcurve rond het middenpunt knipt de onderkant weg; een zwarte auto wordt een silhouet | `FINISH.toeKnee` |
| Omgeving in de lak | glanzende lak spiegelt de plek waar de foto genomen is — bomen op de motorkap | `PAINT` |

De eerste twee waren zelf veroorzaakt: een onvoorwaardelijke sharpen en een
niet-verankerde grade. Beide gefixt.

Het derde is fundamenteler. We verwijderen die reflecties niet — we trekken de
verzadiging naar neutraal zodat groen bladerdek als kleurloze modulatie leest.
De vórm blijft; dat is de bovengrens zonder de lak te hertekenen. De
commerciële pipelines doen hetzelfde: Spyne noemt de stap "shadow and
reflection reduction", niet replacement.

Achterlichten, badges en remklauwen zijn beschermd via `PAINT.satProtect` —
die zitten ruim boven de verzadiging die een reflectie in donkere lak haalt.

`run.jsonl` bevat per beeld een `audit`-blok met de gemeten korrel op auto,
vloer en wand plus de crush-fractie, zodat kwaliteit een getal is en geen
mening. Bij een korrelverhouding boven 2× of onder 0,5×, of meer dan 40%
dichtgeslagen, volgt een `COMPOSITE_AUDIT`-waarschuwing.

## Matte-model kiezen

| Provider | Kwaliteit | Kosten | Draait |
| --- | --- | --- | --- |
| `fal-rmbg` (RMBG 2.0) | beste — strakke daklijn, ronde bandonderkanten, scherpe spaken | API-call | vereist geldige `FAL_KEY` |
| `fal-birefnet` | vergelijkbaar; platte de band bij één testbeeld licht af (A/B 2026-07-23) | API-call | vereist geldige `FAL_KEY` |
| `rembg` + `isnet-general-use` | scherpe rand (~1px overgang) — lokale default | gratis | lokaal, ~6 s |
| `rembg` + `u2net` | brede wazige overgangsband: zichtbaar geknaagde daklijn | gratis | lokaal, ~6 s |
| `rembg` + `bria-rmbg` / `birefnet-general` | zelfde families als fal | gratis | **niet praktisch zonder GPU** |

Gemeten 2026-07-25 op één beeld (1600×1066, CPU zonder GPU-provider). De zware
varianten zijn ~1 GB ONNX en kwamen na 28 minuten niet door één beeld; het
systeem swapte. De lichte twee draaien allebei in ~6 s, en `isnet-general-use`
geeft daarbij een merkbaar strakkere alfarand dan `u2net` — gratis winst.

De kwaliteitsroute blijft `fal-rmbg`. Wil je lokaal nóg beter, dan is
GPU-acceleratie voor onnxruntime de voorwaarde, niet een andere modelkeuze.

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
- `GENBG_REJECTED` — alle generatieve scène-pogingen door de hallucinatie-poort afgekeurd; mathematisch composiet gebruikt

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
