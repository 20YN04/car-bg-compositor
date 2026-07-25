export interface CanvasSize {
  width: number;
  height: number;
}

export interface ShadowConfig {
  widthRatio: number; // breedte van de schaduw t.o.v. de autobreedte
  height: number; // totale hoogte van de ellips in px
  blur: number; // gaussian blur sigma
  opacity: number;
  offsetX: number; // verschuiving t.o.v. bbox-midden ("iets naar achteren")
  offsetY: number; // verschuiving t.o.v. GROUND_Y
}

export interface MaskCleanConfig {
  enabled: boolean;
  openRadiusRatio: number; // erosieradius als fractie van de beeldbreedte
  minRadius: number;
  maxRadius: number;
}

export interface QAConfig {
  minMaskArea: number; // fractie van het beeldoppervlak
  maxMaskArea: number;
  minAspect: number;
  maxAspect: number;
  edgeMargin: number; // px afstand tot beeldrand waarbij "raakt rand" geldt
  minBlobArea: number; // fractie van het beeldoppervlak waaronder een blob genegeerd wordt
}

export interface FalConfig {
  modelId: string;
  model: string;
  operatingResolution: string;
  outputFormat: string;
  refineForeground: boolean;
}

export interface DetectConfig {
  enabled: boolean;
  modelId: string;
  prompt: string;
  /**
   * Drempel voor de heuristische detectiescore (oppervlak × centraliteit,
   * 0–1). Florence-2 geeft geen modelconfidence terug; deze score is onze
   * eigen maat voor "dit is dé auto van deze listing-foto".
   */
  minConfidence: number;
  boxMargin: number; // marge rond de auto-box als fractie van de boxmaat
}

export type SegmentProvider = "florence-sam2" | "sam3";

export interface SegmentConfig {
  /**
   * Hoe "vind object X en geef me zijn masker" wordt opgelost.
   *
   * florence-sam2 (default): Florence-2 zet een tekstprompt om in boxes, SAM 2
   * maakt daar maskers van. Twee calls, twee modellen, twee foutkansen — en de
   * bekende faalmodus dat Florence een lange prompt op "the car" ground en een
   * full-frame box teruggeeft.
   *
   * sam3: SAM 3 doet detectie én segmentatie in één call uit dezelfde
   * tekstprompt (open-vocabulary concept segmentation, ICLR 2026). Eén call,
   * één model, plus per-masker scores waarop gefilterd kan worden.
   *
   * Per taak instelbaar, want de afweging verschilt per taak. Gemeten tarieven:
   *
   *   ruiten  florence-sam2 kost 2 detects + 1 segment = $0,004; SAM 3 $0,005.
   *           Voor $0,001 extra. En het is geen luxe: Florence geeft op elke
   *           raamprompt de héle auto terug, waarna SAM 2 binnen die ene box
   *           één raam segmenteert. De achterste zijruit bleef zo vol bomen
   *           staan (26.085 px glas tegen 68.210 met SAM 3).
   *
   *   wielen  florence-sam2 kost 1 detect = $0,001; SAM 3 $0,005. Vier keer
   *           zo duur, en de contactplaatsing is op de Florence-route
   *           gekalibreerd. Geen aangetoonde winst, dus niet omzetten.
   *
   * --segment zet beide om, voor het vergelijken van de twee routes.
   */
  providers: { windows: SegmentProvider; wheels: SegmentProvider };
  modelId: string; // fal-ai/sam-3/image
  costPerCall: number; // $0.005, gepubliceerd tarief (niet geschat)
  maxMasks: number;
  minScore: number; // per-masker confidence-drempel
  prompts: {
    car: string;
    windows: string;
    plate: string;
    wheels: string;
  };
}

export type MatteProvider = "fal-birefnet" | "fal-rmbg" | "rembg" | "api4ai";

export interface MatteConfig {
  /**
   * Instance-matte (fase 0): SAM2 met de auto-box als prompt levert een
   * instancemasker dat per definitie geen grondschaduw bevat; het BiRefNet-
   * alfa wordt ermee begrensd (per-pixel min). BiRefNet houdt de zachte
   * randen, SAM2 maakt de wielranden scherp.
   */
  enabled: boolean;
  dilateRadius: number; // bescherming van dunne delen tegen SAM2's grovere rand
  featherSigma: number;
  /** Basis-matte-model; de SAM2-combine en box-begrenzing blijven gelijk. */
  provider: MatteProvider;
  rmbgModelId: string; // fal-ai/bria/background/remove (RMBG 2.0)
  /**
   * Model voor provider 'rembg' (lokaal). Gemeten 2026-07-25 op één beeld
   * (1600×1066, CPU, geen GPU-provider):
   *   isnet-general-use  ~6 s, scherpe daklijn (~1px overgang)   ← default
   *   u2net              ~6 s, brede wazige overgangsband
   *   bria-rmbg (1,0 GB) >28 min, kwam niet door één beeld
   *   birefnet-general (972 MB) idem
   * De zware varianten zijn dus geen optie zonder GPU; tussen de lichte twee
   * is isnet gratis winst bij gelijke snelheid.
   */
  rembgModel: string;
  /** Alfa-randen aanscherpen: overgangsband samenknijpen tot ~1px AA. */
  edgeSharpen: boolean;
  edgeLow: number; // alfa ≤ low → transparant
  edgeHigh: number; // alfa ≥ high → dekkend
}

export interface WindowsConfig {
  /**
   * Ruiten donker tinten: door de ramen blijft anders de oorspronkelijke
   * omgeving zichtbaar (bomen, hek), wat vloekt met de nieuwe achtergrond.
   * Detectie (Florence-2) + segmentatie (SAM2 met box-prompts) leveren een
   * raammasker; die pixels worden wiskundig richting tintColor verdonkerd —
   * reflecties blijven subtiel zichtbaar, geen generatieve bewerking.
   */
  enabled: boolean;
  /** Aparte korte prompts werken beter dan één lange caption: Florence
   * ground-t een lange zin ook op "the car" en geeft dan full-frame boxes. */
  detectPrompts: string[];
  segmentModelId: string;
  tintOpacity: number; // 0..1: hoe sterk richting tintColor
  tintColor: { r: number; g: number; b: number };
  featherSigma: number; // blur op de maskrand voor een zachte overgang
  /**
   * Greenhouse-vervanging i.p.v. alleen tinten: de lage frequentie van het
   * glas (de gespiegelde omgeving) wordt vervangen door wat de studioplate
   * daar zou spiegelen; de hoge frequentie (wisser, stijlen, interieur-
   * contouren) blijft staan. Zonder dit blijven bomen door de voorruit
   * schemeren, alleen donkerder.
   */
  greenhouse: boolean;
  /** Hoeveel van de originele glasstructuur behouden blijft (0..1). */
  greenhouseDetail: number;
  /** Blurstraal voor de laagfrequentie-scheiding, in px. */
  greenhouseLowFreqRadius: number;
  /**
   * Blurstraal die "rand van de auto" van "gespiegelde omgeving" scheidt.
   * Alles fijner dan deze straal blijft onaangeroerd staan.
   */
  greenhouseFineRadius: number;
  /**
   * Hoeveel van de middenband (fijn..laag) blijft staan. Dat is de schaal
   * waarop gespiegeld bladerdek zit; op 1 gedraagt de stap zich als voorheen.
   */
  greenhouseMidKeep: number;
}

export type PlateMode = "blur" | "replace" | "off";

export interface PlateConfig {
  /**
   * blur (default): plaatregio onherkenbaar maken (GDPR, EU/België).
   * replace: getekende plaat met AI.plateText, of overlayPath indien gezet.
   * off: plaat onaangetast laten.
   */
  mode: PlateMode;
  overlayPath?: string; // eigen plaatafbeelding voor mode 'replace'
  blurSigma: number;
  style: "gaussian" | "mosaic";
}

export interface AiConfig {
  enabled: boolean;
  /**
   * De twee VLM-kwaliteitscontroles (masker compleet? auto op de grond?) zijn
   * ontwikkelgereedschap: ze schrijven alleen waarschuwingen in run.jsonl en
   * veranderen het beeld niet. In productie zijn ze ~17% van de kosten per
   * beeld. Uit te zetten met --no-qa, zonder de plaat-anonimisatie te raken.
   */
  qaChecks: boolean;
  plateText: string; // tekst op de vervangende nummerplaat
  detectionModelId: string; // plaatdetectie (bbox uit tekstprompt)
  vlmModelId: string; // visual question answering voor AI-kwaliteitscontrole
  costPerDetection: number;
  costPerQuery: number;
  costPerSegment: number;
}

export interface RoutingConfig {
  /**
   * Niet-exterieurfoto's (interieur, dashboard, koffer, detailopnames) uit de
   * compositing houden. Achtergrondvervanging, grondlijn en wielcontact zijn
   * daar betekenisloos; zonder deze poort belandt een dashboard op de
   * studiovloer en wordt dat gewoon weggeschreven.
   *
   * Zulke foto's krijgen wél de kleurcorrectie van de set, de finishing grade
   * en de branding, zodat de listing als geheel consistent blijft.
   */
  enabled: boolean;
  /**
   * Hoeveel van de vijf exterieursignalen moeten kloppen (zie
   * classifyExterior). 4 van 5 laat een exterieurshot met één afwijkend
   * signaal — afgesneden auto, tweede blob — nog door, maar houdt een
   * interieuropname tegen die er op meerdere fronten naast zit.
   */
  minExteriorSignals: number;
}

export interface HarmonizeConfig {
  enabled: boolean;
  strength: number; // 0..1: hoe ver richting de achtergrondtoon
  maxGain: number; // cap op de per-kanaal gain-afwijking (bv. 0.12 = ±12%)
  /**
   * Alle foto's van één auto (= één submap in ./in/) eerst naar een gedeeld
   * witpunt trekken, daarna de set als geheel naar de plate-toon. Zonder dit
   * krijgt elke foto zijn eigen correctie en leest een set die deels in de
   * ochtend en deels in de namiddag is geschoten als twee auto's.
   */
  setConsistent: boolean;
}

export interface FinishConfig {
  /**
   * Finishing grade op het volledige eindbeeld (auto + scène samen): zachte
   * contrastcurve, diepere zwarten, subtiele warmte en saturatie. Eén
   * gedeelde grade laat de (koel tl-belichte) auto en de studioscène als
   * één foto lezen — het mathematische antwoord op de belichtingsmismatch.
   */
  enabled: boolean;
  contrast: number; // 1 = neutraal; 1.1 = zachte S
  /** Negatief = diepere zwarten. Werkt als zachte toe, niet als vlakke aftrek. */
  blackLift: number;
  /** Bovengrens van de toe: daarboven blijft de grade onaangeroerd. */
  toeKnee: number;
  warmth: number; // 0 = neutraal; 0.01 = subtiel warm
  saturation: number; // 1 = neutraal
}

export interface PaintConfig {
  /**
   * Omgevingsreflecties in de lak dempen. Glanzende lak spiegelt de omgeving
   * waarin de foto genomen is; een auto die onder bomen stond houdt een
   * bomenrij op de motorkap, ook na achtergrondvervanging. Dat is het sterkste
   * overgebleven signaal dat het beeld geen studio-opname is.
   *
   * We verwijderen niets — we trekken de verzadiging richting neutraal zodat
   * groen bladerdek als kleurloze modulatie leest. De vorm blijft; dat is de
   * bovengrens van deze aanpak zonder de lak te hertekenen.
   */
  enabled: boolean;
  strength: number; // 0..1, hoeveel van de kleur weg
  minValue: number; // onder deze helderheid is de tint ruis (0-255)
  satFloor: number; // onder deze verzadiging is er niets te dempen
  satRamp: number; // breedte van de invaarband boven satFloor
  /**
   * Boven deze verzadiging blijft alles onaangeroerd: achterlichten,
   * badges en remklauwen zitten daar ruim boven, reflecties in donkere lak
   * halen die verzadiging niet.
   */
  satProtect: number;
  /** Graden rond de dominante lakkleur die als lak tellen, niet als omgeving. */
  hueTolerance: number;
  /** Onder deze mediane verzadiging geldt de auto als zwart/wit/grijs. */
  achromaticSat: number;
  /**
   * De vórm van de gespiegelde omgeving dempen, niet alleen de kleur. Een
   * ontkleurd bladerdek op het dak leest nog steeds als "stond onder bomen".
   * Werkt alleen waar de dempstap de pixel al als omgeving aanwees, dus vlakke
   * lak blijft vlak — anders krijg je de plastic look terug.
   */
  structureStrength: number;
  /** Fijner dan deze straal blijft staan: panelnaden, grepen, badges. */
  structureFineRadius: number;
  /** Grover dan deze straal blijft staan: de lichtverdeling over het paneel. */
  structureCoarseRadius: number;
  /**
   * Alleen gestructureerde reflecties dempen (bladerdek, hekwerk), niet een
   * egale kleurzweem. De vakregel uit de automotive retouche is expliciet:
   * ruim niet alle reflecties op, want dan leest de auto als geplakt — alleen
   * de storende. Uniform dempen was een ontwerpfout.
   */
  selective: boolean;
  contrastRadius: number; // straal van de lokaal-contrastmeting in px
  contrastFull: number; // lokaal contrast waarbij de volle demping geldt
}

export interface ContactFitConfig {
  /**
   * Contactlijn per beeld verdiepen zodat ook het verste wiel onder de
   * wand/vloerovergang van de plate landt. Bij een sterke 3/4-hoek staat dat
   * wiel door het perspectief van de bronopname tot ~300px hoger; met een
   * vaste contactlijn staat de auto dan met één wiel op de muur. De config
   * loste dat op met een handmatig verdiepte waarde die voor élke hoek gold,
   * ook voor zijaanzichten die het niet nodig hebben.
   */
  enabled: boolean;
  horizonMargin: number; // px die het verste wiel onder de horizon moet blijven
}

export interface DofConfig {
  /**
   * Dieptescherpte benaderen. Twee dingen verraden een composiet: alles even
   * scherp (een echte lens heeft altijd afval), en een vloerreflectie die over
   * de hele diepte even scherp is. Microruwheid in de vloer verstrooit het
   * licht sterker naarmate de weg langer is, dus een spiegeling hoort naar
   * achteren onscherper te worden.
   */
  enabled: boolean;
  reflectionNearBlur: number; // vlak onder de contactlijn
  reflectionFarBlur: number; // onderaan de reflectie
}

export interface LightWrapConfig {
  /**
   * Het licht van de scene een paar pixels de auto in laten bloeden. In een
   * echte opname verlicht de omgeving het onderwerp ook langs de rand; een
   * alfacomposiet mist dat en houdt een mesrand over. Gemeten op de daklijn
   * van de Taycan-set: 152 -> 31 in twee pixels, zonder tussenwaarde.
   */
  enabled: boolean;
  width: number; // breedte van de randband in px (blurradius op het alfa)
  blur: number; // hoe sterk de achtergrond vervaagt voor hij bloedt
  strength: number; // 0..1
}

export interface GrainConfig {
  /**
   * Korrel van de scene gelijktrekken met die van de auto. De auto draagt
   * cameraruis, de plate is glad; dat verschil leest als "uitgeknipt" ook bij
   * een perfecte rand. We voegen ruis toe aan de scene i.p.v. de auto te
   * verzachten — detail behouden is de kernbelofte.
   */
  enabled: boolean;
  strength: number; // 0..1 op het berekende verschil
  seed: number; // deterministisch, anders is geen uitvoertest reproduceerbaar
}

export interface HighlightConfig {
  /**
   * Specular-compressie: dempt de felle reflecties van de oorspronkelijke
   * omgeving (tl-balken, spots) in de lak via een soft-knee curve op de
   * luminantie boven `knee`. `strength` = fractie van het exces dat
   * weggenomen wordt (0.6 → spikkel op 255 zakt naar knee + 40% van het
   * exces). Normale lakverlopen onder de knee blijven exact gelijk.
   */
  enabled: boolean;
  knee: number; // 0..255
  strength: number; // 0..1
}

export type GenBgProvider = "flux" | "gemini" | "qwen" | "showroom";

export interface QwenConfig {
  /**
   * fal-ai/qwen-image-edit. Instructie-editor zonder masker: de bescherming
   * komt volledig van de paste-back van de originele autopixels.
   *
   * image_size accepteert landscape_4_3, dus de output komt in de
   * canvasverhouding binnen — Gemini leverde 3:2 op een 4:3 canvas, waarna de
   * cover-crop de gegenereerde vloerlijn wegschoof.
   */
  modelId: string;
  imageSize: string;
  steps: number;
  guidanceScale: number;
  negativePrompt: string;
  costPerCall: number;
  /**
   * Instructie-prefix. Qwen krijgt het composiet MET zichtbare auto: zwart
   * afdekken leest hij als een object en dan bouwt hij een studio rond een
   * zwart paneel. De prompt vraagt hem de auto te laten staan; de garantie
   * komt niet van die vraag maar van de paste-back erna.
   */
  keepPrefix: string;
}

export interface GenBgConfig {
  /**
   * Hybride scène-stap: FLUX Fill herschildert achtergrond + contactschaduw
   * + vloerreflectie rond de auto (masker: wit = herschilderen, zwart = auto
   * behouden). De originele autopixels worden er daarna ALTIJD pixel-exact
   * terug overheen gelegd — velgen/badges kunnen dus niet vervormen. Dit is
   * de enige generatieve stap in de pipeline en raakt de auto nooit.
   */
  enabled: boolean;
  /**
   * hero: alleen de eerste bruikbare foto van de batch (de listing-hero)
   * krijgt de generatieve scène — premium eerste indruk, consistente
   * mathematische composieten voor de rest, en een fractie van de kosten.
   * all: elke foto. (Scenario-keuze 2026-07-24: hero.)
   */
  mode: "hero" | "all";
  /** flux (default): fal.ai FLUX Fill. gemini: Google Gemini Nano Banana. */
  provider: GenBgProvider;
  modelId: string;
  prompt: string;
  costPerCall: number; // ijken op het fal-dashboard
  seed: number; // basisseed; per afgekeurde poging +1
  maxAttempts: number; // hallucinatie-poort: max scène-pogingen
  /**
   * FLUX Fill rekent $0.05 per megapixel, afgerond naar boven. Het volle
   * canvas (1920×1440 = 2.76 MP) kost dus $0.15/poging; op ≤1 MP genereren
   * en de scène opschalen kost $0.05. De achtergrond bestaat uit zachte
   * verlopen — de upscale is onzichtbaar; de auto gaat op volle resolutie
   * terug op de scène.
   */
  fillMaxMegapixels: number;
  /**
   * Zachtheid van de maskerrand (differential diffusion). Bij een binair
   * masker moet het model precies op de grens van "behouden" naar "genereren"
   * springen; met een gradiënt beslist het per pixel hoeveel er mag veranderen
   * en zit de overgang in de generatie zelf i.p.v. in een light wrap achteraf.
   */
  maskFeather: number;
  /**
   * Breedte van de guard-band rond het autosilhouet, als fractie van de
   * autobreedte. Binnen die band wint het mathematische composiet.
   *
   * Zonder guard kan een generatief model carrosserie aangroeien BUITEN het
   * masker, en daar reikt de paste-back-garantie niet. Gemeten op beeld (5):
   * Qwen verlengde de achterkant met een volledig extra wiel inclusief
   * wielkast, en de hallucinatie-poort miste dat omdat de detectiebox ervan
   * overlapte met onze eigen auto.
   *
   * Afweging: de vloer vlak onder de auto komt hierdoor van de wiskunde en
   * niet van het model, dus de contactschaduw wordt niet beter. Verder weg
   * mag het model wel, en daar zit het grootste deel van de winst.
   * 0 zet de guard uit.
   */
  guardBandRatio: number;
}

export interface GeminiConfig {
  modelId: string;
  costPerCall: number;
  /** Prefix voor de GENBG-prompt: vertelt Gemini dat het zwarte silhouet een placeholder is. */
  maskPrefix: string;
  /**
   * Prompt voor de showroom-provider: meerdere invoerbeelden (cutout op
   * transparantie, plate, positioneringsraster, stijlreferenties). Overgenomen
   * uit carredo-imaging-refs/PROMPT.md — de aanpak die de live listings
   * gebruiken.
   */
  showroomPrompt: string;
  /** Stijlreferenties die als extra invoerbeelden meegaan. */
  styleRefs: string[];
  /** Moet de canvasverhouding volgen, anders klopt de scènegeometrie niet. */
  aspectRatio: "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "16:9" | "21:9";
  imageSize: "1K" | "2K" | "4K";
}

export type AnglePreset = "side" | "front34" | "rear34";

export interface PresetOverride {
  contactTargetY?: number;
  spanMeters?: number; // zichtbare spanwijdte voor deze hoek
}

export interface BackgroundProfile {
  /**
   * Kalibratie per achtergrond-plate (fase 1/2): plaatsing, schaal, licht en
   * reflectie slaan op de werkelijke vloer van déze plate. Willekeurige
   * plates werken niet — de camerahoogte/-hoek van de plate moet bij de
   * auto-shots passen; een mismatch is een plate-keuzeprobleem, geen codebug.
   */
  horizonY: number | null; // canvas-y van de vloer/wandovergang (documentatie/QA)
  contactTargetY: number; // canvas-y waar de wielcontactlijn moet landen
  floorScaleRef: number; // px per meter op de contactdiepte van deze plate
  /**
   * Zichtbare spanwijdte van de auto in meters: bij zij-/3/4-aanzichten is
   * dat de (deels verkorte) lengte (~4.4 m), niet de autobreedte van 1.8 m.
   * Per-hoek presets (fase 4) verfijnen dit.
   */
  carWidthMeters: number;
  lightDirX: number; // -1..1, richting waaruit het licht komt (negatief = links)
  lightSoftness: number; // multiplier op de schaduwblur
  floorReflectivity: number; // 0..1 sterkte van de vloerreflectie
  reflectionHeightRatio: number; // fractie van de autohoogte die meespiegelt
  glowStrength: number; // zachte hotspot achter de auto (screen blend)
  vignetteStrength: number; // donkere hoeken
  toneBrightness: number; // 1 = ongewijzigd; <1 iets donkerder
  toneWarmth: number; // 0 = neutraal; >0 warmer (r omhoog, b omlaag)
  /**
   * Horizontale positie van het middelpunt van de auto, als fractie van de
   * canvasbreedte. 0,5 = gecentreerd. De cutout-referenties zetten dit op
   * ~0,45: links van het midden, met ruimte rechts voor plaat en badge.
   */
  horizontalBias: number;
  /**
   * Schaal op SHADOW.height en SHADOW.blur voor deze plate.
   *
   * Een brede zachte schaduwband legt zich óver de vloerreflectie heen en
   * maakt van allebei grijze mush — dan zweeft de auto. Gemeten onder de band
   * op de live listing: 58 (rubber) gaat direct naar 151 (heldere vloer), dus
   * hun contactschaduw is een dunne lijn. Bij ons liep een donkere waas nog
   * 20px door: 55 -> 92 -> 81 -> 74.
   */
  shadowHeightScale: number;
  shadowBlurScale: number;
}

export interface BrandingConfig {
  enabled: boolean;
  text: string; // wordmark wanneer er geen logoPath is
  logoPath?: string; // eigen logo-afbeelding (png met transparantie)
  opacity: number;
  fontSize: number;
  margin: number; // afstand tot de rechterbenedenhoek
}

import type { LevelConfig, SweepParams } from "./composite.js";

export type OutputTarget = "showroom" | "white" | "studio";

/**
 * Uitvoerdoel. Dit is geen cosmetische keuze maar bepaalt hoe moeilijk het
 * probleem is.
 *
 * showroom — de auto op een fotografische studioplate. Dan moet je het
 *   vloerperspectief, de horizon, de korrel en de lichtrichting van die plate
 *   matchen, en botst wat er in de lak spiegelt met waar de auto staat.
 *
 * white — de auto op puur wit met een strakke contactschaduw. Dat is de
 *   canonieke referentie in carredo-imaging-refs, en het is de vorm die de
 *   markt gebruikt. Er is geen vloer om te matchen, geen korrel om gelijk te
 *   trekken en geen omgeving waarmee de reflecties kunnen botsen — het
 *   conflict verdwijnt omdat er geen tweede verhaal is.
 *
 * GRAIN en LIGHTWRAP staan op wit uit: allebei bestaan ze om tegen een
 * fotografische plate te matchen. Ruis toevoegen aan een vlak wit veld maakt
 * het vuil, en er is geen omgevingslicht om langs de rand te laten bloeden.
 */
export interface TargetPreset {
  canvas: CanvasSize;
  background: string;
  grain: boolean;
  lightWrap: boolean;
  /**
   * wheel — schaal op de gemeten wieldiameter, dus fysiek consistent: een 3/4
   *   toont een smaller silhouet dan een zijaanzicht, precies zoals in het
   *   echt. Juist voor een scene waarin de auto ergens staat.
   * frame — schaal op de bboxbreedte naar een vaste fractie van het canvas,
   *   dus consistente kadervulling ongeacht de hoek. Gemeten op de
   *   referenties in carredo-imaging-refs: 73% en 78% breed, allebei
   *   3/4-opnames. Voor een cutout-catalogus is dat de norm.
   */
  scaleMode: "wheel" | "frame";
  frameWidthRatio: number; // alleen bij scaleMode "frame"
}

export interface Config {
  TARGET: OutputTarget;
  SWEEP: SweepParams;
  TARGETS: Record<OutputTarget, TargetPreset>;
  CANVAS: CanvasSize;
  GROUND_Y: number; // y-coördinaat waar de banden komen te staan
  CAR_WIDTH_RATIO: number; // fractie canvasbreedte
  ALPHA_THRESHOLD: number;
  GROUND_PERCENTILE: number;
  /**
   * Bovengrens op de grondtrim, als fractie van de bboxhoogte. De trim gaat
   * ervan uit dat álles onder de wielcontactlijn aangesmolten slagschaduw is.
   * Bij een lage camera in 3/4 hangt de voorspoiler in projectie lager dan het
   * contactpunt van de band — dat is perspectief, geen schaduw. Op beeld (6)
   * van de Taycan-set sneed een ongelimiteerde trim 61px (7,9% van de
   * bboxhoogte) echte carrosserie weg. Gemeten over die set van 13: de
   * legitieme trims liggen tussen 0,9% en 2,7%, het defect op 7,9% — bij 3%
   * bindt de klem dus op precies dat ene beeld en op geen enkel ander.
   * Bindt hij, dan volgt een GROUND_TRIM_CAPPED-waarschuwing om na te kijken.
   */
  GROUND_TRIM_MAX_RATIO: number;
  /**
   * Nominale wieldiameter in meters, als maatlat voor de schaal.
   *
   * De oude schaal legde de bbox-breedte op een vaste canvasfractie. Hoeveel
   * auto er in die bbox zit hangt echter van de kijkhoek af: gemeten over de
   * Taycan-set liep de bbox-aspect van 1,45 tot 3,20 terwijl de widthRatio op
   * alle dertien beelden 0,720 stond — het vooraanzicht werd dus fors groter
   * uitgerekt dan het zijaanzicht, en in een galerij zie je dat meteen.
   *
   * Een wiel heeft een vaste maat, staat in vrijwel elke exterieuropname en is
   * ongevoelig voor kijkhoek én voor een auto die deels buiten beeld valt.
   * 0 zet de wielschaling uit en valt terug op de bbox-breedte.
   */
  WHEEL_DIAMETER_M: number;
  /**
   * Kadreringsgain op de wielschaal. 1,0 = zuiver fysiek: elke hoek krijgt de
   * schaal die hij in werkelijkheid zou hebben, dus een 3/4-opname is smaller
   * in beeld dan een zijaanzicht. Dat leest als één auto vanuit meerdere
   * posities — maar het laat bij 3/4 wel veel leegte over.
   *
   * Hoger trekt de hele set evenredig groter; de onderlinge verhoudingen
   * blijven kloppen. Gemeten op de Taycan-set bij 1,0: zijaanzicht 0,69 van de
   * canvasbreedte (de config mikte oorspronkelijk op 0,72), 3/4 rond 0,46.
   */
  FRAMING_GAIN: number;
  ERODE_MASK: boolean; // 1px erosie tegen kleurhalo's van de originele achtergrond
  MASK_CLEAN: MaskCleanConfig; // opschoning: dunne/losstaande structuren (windmolen, paal) weg
  SHADOW: ShadowConfig;
  JPEG_QUALITY: number;
  CAR_SHARPEN_SIGMA: number; // milde sharpen op de geschaalde autolaag (0 = uit)
  QA: QAConfig;
  FAL: FalConfig;
  DETECT: DetectConfig;
  SEGMENT: SegmentConfig; // detectie+segmentatie in één (SAM 3) of tweetraps
  MATTE: MatteConfig;
  AI: AiConfig;
  PLATE: PlateConfig;
  WINDOWS: WindowsConfig;
  BRANDING: BrandingConfig;
  CONTACT_FIT: ContactFitConfig;
  LEVEL: LevelConfig;
  DOF: DofConfig;
  LIGHTWRAP: LightWrapConfig;
  PAINT: PaintConfig;
  GRAIN: GrainConfig;
  HIGHLIGHTS: HighlightConfig; // specular-compressie op de autolaag
  FINISH: FinishConfig; // grade op het eindbeeld
  GENBG: GenBgConfig; // hybride generatieve scène rond de beschermde auto
  GEMINI: GeminiConfig;
  QWEN: QwenConfig; // Google Gemini Nano Banana (image editing)
  BACKGROUND_PROFILES: Record<string, BackgroundProfile>; // key = bestandsnaam
  DEFAULT_PROFILE: BackgroundProfile;
  ROUTING: RoutingConfig;
  HARMONIZE: HarmonizeConfig;
  PRESETS: Record<AnglePreset, PresetOverride>; // fase 4: per-hoek kadrering
  COST_PER_CALL_USD: number;
  MONTHLY_VOLUME: number; // verwacht beeldvolume voor de kostenextrapolatie
}

export const defaultConfig: Config = {
  TARGET: "showroom",
  // Gemeten op images.carredo.be, Taycan-listing, alle zes de studiobeelden
  // (1248x832). Het wandprofiel is over die zes stabiel — midden 146 bovenaan
  // naar 222 op y=220, rand 102 naar 160 — dus het is een eigenschap van hun
  // studio en niet van één opname.
  SWEEP: {
    horizonRatio: 0.55,
    // offsets zijn fracties van de wandband (horizon op y=458 bij 832 hoog):
    // y=20 -> 0,044, y=80 -> 0,175, y=140 -> 0,306, y=220 -> 0,48. De waarde
    // op 0 is doorgetrokken vanaf de eerste twee metingen.
    wallStops: [
      { at: 0, lum: 133 },
      { at: 0.175, lum: 180 },
      { at: 0.306, lum: 208 },
      { at: 0.48, lum: 226 },
      { at: 1, lum: 228 },
    ],
    // gemeten vignettering aan de rand (x=40, dus side 0,92) was 0,33 / 0,42 /
    // 0,34 / 0,31 op t = 0,04 / 0,22 / 0,48 / 0,65; hier gedeeld door 0,92
    // zodat de stops voor de uiterste rand gelden
    wallVignetteStops: [
      { at: 0, v: 0.358 },
      { at: 0.22, v: 0.455 },
      { at: 0.48, v: 0.369 },
      { at: 1, v: 0.332 },
    ],
    // vloer, gemeten weg van de auto: 138 net onder de naad, aflopend naar
    // ~118 in het midden onderaan en ~93 in de onderhoeken
    floorSeam: 160,
    floorBottom: 110,
    floorCornerVignette: 0.18,
    // de lichtpoel onder de auto piekt op 203 tegen een basis van ~130; de
    // halfwaardebreedte ligt op ~174 px, dus een smalle poel
    poolGain: 88,
    poolCentreRatio: 0.9,
    poolWidthRatio: 0.17,
    poolHeightRatio: 0.55,
    // de naad zakt naar 114 met 148 erboven en 130 eronder
    creaseDepth: 0.3,
    creaseSigma: 4,
  },
  TARGETS: {
    showroom: {
      canvas: { width: 1920, height: 1440 }, // 4:3, AutoScout24 adviseert 1280x960
      background: "showroom.jpg",
      grain: true,
      lightWrap: true,
      scaleMode: "wheel",
      frameWidthRatio: 0.76,
    },
    /**
     * Geconstrueerde studio-sweep, geijkt op de live Carredo-listings
     * (images.carredo.be, 1248x832). Geen fotografische plate maar een
     * elliptisch verloop met een lichtpoel achter de auto en een gepolijste
     * vloer met sterke spiegeling.
     */
    studio: {
      canvas: { width: 1248, height: 832 }, // 3:2, zoals de live galerij
      background: "studio-sweep.png",
      grain: false, // een verloop heeft geen korrel om mee te matchen
      lightWrap: true,
      scaleMode: "frame",
      frameWidthRatio: 0.78, // hun auto vult het kader ruimer
    },
    white: {
      // 8:5, zoals de referenties in carredo-imaging-refs (1200x750)
      canvas: { width: 1920, height: 1200 },
      background: "white.png",
      grain: false,
      lightWrap: false,
      scaleMode: "frame",
      frameWidthRatio: 0.76, // referenties meten 73% en 78%
    },
  },
  CANVAS: { width: 1920, height: 1440 },
  GROUND_Y: 1200,
  CAR_WIDTH_RATIO: 0.82,
  ALPHA_THRESHOLD: 10,
  GROUND_PERCENTILE: 0.95,
  GROUND_TRIM_MAX_RATIO: 0.03,
  WHEEL_DIAMETER_M: 0.7,
  FRAMING_GAIN: 1.0,
  ERODE_MASK: false,
  MASK_CLEAN: {
    enabled: true,
    openRadiusRatio: 0.003, // ~6px bij 2048: windmolen weg, antenne blijft heel
    minRadius: 2,
    maxRadius: 12,
  },
  SHADOW: {
    widthRatio: 0.9,
    height: 80,
    blur: 25,
    opacity: 0.45,
    offsetX: 20,
    offsetY: 0,
  },
  JPEG_QUALITY: 90,
  CAR_SHARPEN_SIGMA: 0.8,
  QA: {
    minMaskArea: 0.08,
    maxMaskArea: 0.75,
    minAspect: 1.2,
    maxAspect: 4.5,
    edgeMargin: 2,
    minBlobArea: 0.005,
  },
  FAL: {
    modelId: "fal-ai/birefnet/v2",
    model: "General Use (Heavy)",
    operatingResolution: "2048x2048",
    outputFormat: "png",
    refineForeground: true,
  },
  /**
   * Instance-aware masking (implementatie B): BiRefNet blijft het masker
   * leveren (zachte hoge-resolutie matting-randen — dat haalt SAM2's binaire
   * masker niet), maar het alfamasker wordt begrensd tot de gedetecteerde
   * auto-box. Zo verdwijnen mee-gemaskeerde slagschaduw op de grond en
   * aanpalende achtergrondobjecten (busje-dak) structureel.
   */
  DETECT: {
    enabled: true,
    modelId: "fal-ai/florence-2-large/open-vocabulary-detection",
    prompt: "car",
    minConfidence: 0.05,
    boxMargin: 0.02,
  },
  SEGMENT: {
    providers: { windows: "sam3", wheels: "florence-sam2" },
    modelId: "fal-ai/sam-3/image",
    costPerCall: 0.005,
    maxMasks: 8, // ruiten: voorruit + zijruiten + achterruit halen dit makkelijk
    minScore: 0.4,
    // korte, concrete noun phrases: SAM 3 is daarop getraind. Meerdere
    // concepten kommagescheiden in één prompt.
    prompts: {
      car: "car",
      windows: "car window, windshield",
      plate: "license plate",
      wheels: "wheel",
    },
  },
  MATTE: {
    enabled: true,
    dilateRadius: 4,
    featherSigma: 1, // strakkere rand; 2 maakte de outline zichtbaar zacht
    // A/B op ARV/RV/RVV (2026-07-23): RMBG 2.0 geeft vollere, rondere
    // bandonderkanten (BiRefNet plat de band bij RV licht af) bij even
    // scherpe spaken; geen halo's in beide. Daarom default rmbg.
    // A/B op ARV/RV/RVV (2026-07-23): RMBG 2.0 geeft vollere, rondere
    // bandonderkanten (BiRefNet plat de band bij RV licht af) bij even scherpe
    // spaken; geen halo's in beide. Daarom default rmbg.
    // Zonder geldige FAL_KEY: 'rembg' (lokaal, gratis, grovere daklijn).
    provider: "fal-rmbg",
    rmbgModelId: "fal-ai/bria/background/remove",
    rembgModel: "isnet-general-use",
    edgeSharpen: true,
    edgeLow: 64,
    edgeHigh: 192,
  },
  AI: {
    enabled: true,
    qaChecks: true,
    plateText: "CARREDO",
    detectionModelId: "fal-ai/florence-2-large/caption-to-phrase-grounding",
    vlmModelId: "fal-ai/moondream2/visual-query",
    // ijken op het fal-dashboard
    costPerDetection: 0.001,
    costPerQuery: 0.001,
    costPerSegment: 0.002,
  },
  PLATE: {
    // branded look: CARREDO-plaat i.p.v. blur (anonimiseert evengoed)
    mode: "replace",
    blurSigma: 12,
    style: "gaussian",
  },
  BRANDING: {
    enabled: true,
    text: "CARREDO",
    // echte Carredo-wordmark (navy, transparante PNG) zoals op de live site;
    // de tekst-fallback blijft voor wie zonder asset draait
    logoPath: "assets/carredo-logo.png",
    opacity: 0.92,
    fontSize: 40,
    margin: 56,
  },
  BACKGROUND_PROFILES: {
    // gegenereerde carredo-achtige studioplate (scripts/make-studio-bg.mjs)
    "studio.png": {
      horizonY: 576,
      contactTargetY: 985,
      floorScaleRef: 225, // ~0.52 canvasbreedte bij 4.4 m spanwijdte
      carWidthMeters: 4.4,
      lightDirX: -0.2,
      lightSoftness: 1.3,
      floorReflectivity: 0.22,
      reflectionHeightRatio: 0.28,
      glowStrength: 0.2,
      vignetteStrength: 0.3,
      toneBrightness: 0.94,
      toneWarmth: 0,
      horizontalBias: 0.5,
      shadowHeightScale: 1,
      shadowBlurScale: 1,
    },
    // gekalibreerd op de betonvloer-showroomplate (1536×1024 → cover 1920×1440).
    // horizonY opgemeten op de plate zelf: sterkste horizontale luminantierand
    // in het middelste beeldderde (224 → 199 over 4px) ligt op y=879.
    "showroom.jpg": {
      horizonY: 879,
      // 1195 i.p.v. 1150: bij sterke 3/4-views staat het verre wiel door de
      // gebakken fotoperspectief tot ~300px hoger dan het nabije wiel; met de
      // contactlijn dieper op de vloer blijft ook dat wiel onder de
      // wand/vloerovergang (867) in plaats van "op de muur" te landen
      contactTargetY: 1195,
      floorScaleRef: 314,
      carWidthMeters: 4.4,
      lightDirX: -0.35, // plate is links het lichtst
      lightSoftness: 1.2,
      floorReflectivity: 0.12,
      reflectionHeightRatio: 0.18, // subtiel en snel uitgefaded
      glowStrength: 0.14,
      vignetteStrength: 0.18,
      toneBrightness: 0.96, // referentie is een tikje donkerder
      toneWarmth: 0.025, // en een tikje warmer grijs
      horizontalBias: 0.5,
      shadowHeightScale: 1,
      shadowBlurScale: 1,
    },
    /**
     * Cutout op puur wit — de canonieke referentie uit carredo-imaging-refs.
     *
     * Dit is een fundamenteel makkelijker doel dan een fotografische
     * studioplate: er is geen vloerperspectief om te matchen, geen horizon,
     * geen korrel en geen omgeving waarmee de reflecties in de lak kunnen
     * botsen. Het conflict tussen "wat de lak spiegelt" en "waar de auto
     * staat" verdwijnt omdat er geen tweede verhaal is.
     *
     * floorScaleRef 390 zet een zijaanzicht op ~85% canvasbreedte, zoals de
     * referenties. Geen vloerreflectie, geen gloed, geen vignette: wit is wit.
     */
    /**
     * Sweep-profiel. Sterke vloerreflectie: de live beelden hebben een
     * gepolijste vloer waarin de auto duidelijk spiegelt, veel meer dan de
     * 0,12 van de betonplate.
     */
    "studio-sweep.png": {
      horizonY: 458, // 55% van 832, gemeten op de live listing
      contactTargetY: 640,
      floorScaleRef: 300,
      carWidthMeters: 4.4,
      lightDirX: 0,
      lightSoftness: 0.9,
      // hun spiegeling is gedetailleerd maar licht: minimum 102 net onder de
      // auto. De onze ging naar 66 — te sterk en, door de blur, te dof.
      // 0,07 was te ver teruggedraaid: de spiegeling verdween. Hun spiegeling
      // is LICHT maar GEDETAILLEERD — je ziet de velgspaken. Sturen op het
      // minimum was de verkeerde maat; het gaat om zichtbaar detail.
      floorReflectivity: 0.2,
      reflectionHeightRatio: 0.5,
      glowStrength: 0, // de sweep heeft zijn lichtpoel al ingebakken
      vignetteStrength: 0,
      toneBrightness: 1,
      toneWarmth: 0,
      horizontalBias: 0.5,
      // strakke contactlijn i.p.v. een brede waas: die legt zich anders over
      // de spiegeling heen en dan zweeft de auto
      shadowHeightScale: 0.35,
      shadowBlurScale: 0.3,
    },
    "white.png": {
      horizonY: null,
      // gemeten op de referenties: onderkant van de auto op 76% van de
      // beeldhoogte. Onze eerste poging zette hem op 83-84%.
      contactTargetY: 870,
      floorScaleRef: 390,
      carWidthMeters: 4.4,
      lightDirX: 0,
      lightSoftness: 0.55, // kleine, strakke contactschaduw
      floorReflectivity: 0,
      reflectionHeightRatio: 0,
      glowStrength: 0,
      vignetteStrength: 0,
      toneBrightness: 1,
      toneWarmth: 0,
      // PROMPT.md schrijft 45% voor, maar de referentiebeelden zelf meten
      // allebei 50%. De beelden zijn de benchmark, niet het document.
      horizontalBias: 0.5,
      shadowHeightScale: 1,
      shadowBlurScale: 1,
    },
  },
  // neutrale gradient: geen perspectief, dus de klassieke plaatsing
  DEFAULT_PROFILE: {
    horizonY: null,
    contactTargetY: 1200,
    floorScaleRef: 358, // ≈ oude CAR_WIDTH_RATIO 0.82 bij 4.4 m spanwijdte
    carWidthMeters: 4.4,
    lightDirX: 0,
    lightSoftness: 1,
    // ingetogen op de vloerloze gradient: een sterke spiegeling leest daar
    // als "natte vloer"-ghost in plaats van als subtiele verankering
    floorReflectivity: 0.08,
    reflectionHeightRatio: 0.16,
    glowStrength: 0.1,
    vignetteStrength: 0.12,
    toneBrightness: 1,
    toneWarmth: 0,
    horizontalBias: 0.5,
    shadowHeightScale: 1,
    shadowBlurScale: 1,
  },
  ROUTING: {
    enabled: true,
    minExteriorSignals: 4,
  },
  HARMONIZE: {
    enabled: true,
    strength: 0.35,
    maxGain: 0.12,
    setConsistent: true,
  },
  // Gemeten over de dertien Taycan-bronfoto's: profielopnames (aspect >= 2,9)
  // hebben hoeken van -3,8 tot 2,4 graden, 3/4-aanzichten -26,3 tot 24,3. De
  // eerste groep is scheefstand, de tweede perspectief.
  LEVEL: {
    enabled: true,
    minAspect: 2.85,
    maxAngle: 6,
  },
  CONTACT_FIT: {
    enabled: true,
    horizonMargin: 30,
  },
  DOF: {
    enabled: true,
    reflectionNearBlur: 0.7,
    reflectionFarBlur: 7,
  },
  LIGHTWRAP: {
    enabled: true,
    width: 6,
    blur: 24,
    strength: 0.35,
  },
  PAINT: {
    enabled: true,
    // Gekalibreerd op de motorkap van de Taycan-set (2026-07-25): 79% van de
    // lakpixels zit onder S=0,10 en is dus al neutraal; de groen-dominante
    // boomreflecties hebben mediaan S=0,241 en p90 S=0,411. Met satFloor 0,18
    // en een band van 0,12 kwam de mediane reflectie op maar 36% demping uit.
    strength: 0.75,
    minValue: 24,
    satFloor: 0.10,
    satRamp: 0.06,
    satProtect: 0.75,
    hueTolerance: 40,
    achromaticSat: 0.18,
    selective: true,
    contrastRadius: 6,
    contrastFull: 6,
    structureStrength: 0.8,
    structureFineRadius: 2,
    structureCoarseRadius: 24,
  },
  GRAIN: {
    enabled: true,
    strength: 0.9,
    seed: 20260725,
  },
  HIGHLIGHTS: {
    enabled: true,
    knee: 200, // ondergrens; schuift adaptief mee met de autohelderheid
    strength: 0.75,
  },
  FINISH: {
    enabled: true,
    contrast: 1.1,
    blackLift: -7,
    toeKnee: 64,
    warmth: 0.006,
    saturation: 1.05,
  },
  GENBG: {
    /**
     * Uit sinds de gekalibreerde studioplate (backgrounds/showroom.jpg) er is:
     * die levert dezelfde look deterministisch, gratis en zonder de hele
     * hallucinatieklasse (tweede auto, podium, verzonnen uitlaten, pseudo-
     * tekst) die de VLM-poorten hieronder moesten afvangen. Aanzetten met
     * --genbg hero|all blijft mogelijk voor experimenten.
     */
    enabled: false,
    mode: "hero",
    provider: "flux",
    modelId: "fal-ai/flux-pro/v1/fill",
    // géén "showroom" in de prompt: dat nodigt het model uit om er andere
    // auto's en een dealerhal bij te verzinnen
    prompt:
      "A completely empty photo studio: one plain seamless light gray " +
      "backdrop wall and a smooth matte gray concrete floor. The room is " +
      "empty — no other cars, no objects, no people, no windows, no " +
      "ceiling, no visible light fixtures, no text. Soft diffuse studio " +
      "light matching the light on the car. A realistic soft contact " +
      "shadow under the tires and a subtle car reflection on the floor. " +
      "The car stands directly on the flat floor — no podium, no " +
      "turntable, no platform. Photorealistic.",
    costPerCall: 0.05, // 1 MP-fill @ $0.05/MP (afgerond naar boven)
    seed: 20260724,
    maxAttempts: 3,
    fillMaxMegapixels: 1,
    maskFeather: 6,
    guardBandRatio: 0.06,
  },
  GEMINI: {
    // Gemini 3.1 Flash met image-generation: Nano Banana (image editing)
    modelId: "gemini-3.1-flash-image",
    costPerCall: 0.02, // schatting — ijken op Google AI Studio dashboard
    /**
     * Extra prompt-prefix voor Gemini: het model krijgt een beeld met
     * een zwart gemaskeerde auto-silhouet — zonder deze instructie vult
     * Gemini dat zwarte gat op met een zelf verzonnen auto.
     */
    maskPrefix:
      "The black silhouette is a masked-out placeholder for a car. " +
      "Do NOT draw or generate any car, vehicle, or object in the black " +
      "area. Only generate the photo studio background around and behind " +
      "the black silhouette. ",
    showroomPrompt:
      "Take the car from the FIRST image (a transparent cutout) and place it " +
      "into the studio shown in the SECOND image. The THIRD image is a " +
      "POSITIONING GUIDE ONLY: place the car inside the magenta rectangle " +
      "with its wheels on the rectangle's bottom edge, and render the " +
      "wall/floor seam exactly on the cyan line. The output must contain ZERO " +
      "magenta or cyan pixels. The remaining images are style references — " +
      "match their lighting, floor reflection and overall look.\n\n" +
      "CAMERA ANGLE: match the source cutout exactly, no rotation.\n" +
      "FLOOR: polished concrete with a soft contact shadow and a clear " +
      "reflection.\n" +
      "REFLECTIONS ON THE CAR: preserve the paint finish; swap only what is " +
      "reflected (trees and sky become the grey studio). Windows are dark " +
      "tinted glass.\n" +
      "NEVER alter the shape, wheels, rims, badges or headlights of the car.\n" +
      "No other cars, no people, no text, no watermarks.",
    styleRefs: [
      "carredo-imaging-refs/assets/thumbnail_reference.webp",
      "carredo-imaging-refs/style_refs/lizy_1.webp",
      "carredo-imaging-refs/style_refs/lizy_2.webp",
      "carredo-imaging-refs/style_refs/lizy_3.webp",
    ],
    // CANVAS is 1920×1440 = 4:3; een afwijkende ratio wordt weggecropt
    aspectRatio: "4:3",
    imageSize: "2K",
  },
  QWEN: {
    modelId: "fal-ai/qwen-image-edit",
    imageSize: "landscape_4_3",
    steps: 30,
    guidanceScale: 4,
    // de faalmodus die we bij Gemini zagen expliciet uitsluiten
    negativePrompt:
      "second car, extra vehicle, people, text, watermark, podium, turntable, " +
      "floor markings, redrawn wheels, distorted badge",
    costPerCall: 0.02, // $0.02/MP, gepubliceerd tarief
    keepPrefix:
      "Keep the car in this image exactly as it is — do not change its shape, " +
      "colour, wheels, badges or position. Replace only what is around it: ",
  },
  PRESETS: {
    side: { spanMeters: 4.3 },
    front34: { spanMeters: 4.6 },
    rear34: { spanMeters: 4.6 },
  },
  WINDOWS: {
    enabled: true,
    // "car window" en varianten leveren bij deze detector de héle auto terug
    // (gemeten: 1387×469 op een auto van 1387×469), waarna de plausibiliteits-
    // filter ze terecht weggooit en alleen de voorruit overblijft. De achterste
    // zijruit werd daardoor nooit voorgesteld en bleef vol bomen staan.
    // Deze formulering geeft wél een greenhouse-band (gemeten: 742×145).
    detectPrompts: ["all glass windows of the car", "windshield"],
    segmentModelId: "fal-ai/sam2/image",
    tintOpacity: 0.68,
    tintColor: { r: 35, g: 40, b: 48 },
    featherSigma: 5,
    greenhouse: true,
    greenhouseDetail: 0.35,
    greenhouseLowFreqRadius: 12,
    greenhouseFineRadius: 2,
    greenhouseMidKeep: 0.25,
  },
  /**
   * SCHATTING — de prijs per BiRefNet-call staat niet in de publieke docs.
   * IJk deze waarde (en AI.costPerDetection / AI.costPerQuery) op het
   * fal.ai-dashboard vóór er beslissingen op de extrapolatie worden gebaseerd.
   */
  COST_PER_CALL_USD: 0.002,
  MONTHLY_VOLUME: 75_000,
};
