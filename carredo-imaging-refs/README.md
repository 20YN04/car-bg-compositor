# Carredo Imaging Reference

Referentiebeelden en prompts voor het generatief plaatsen van auto's in
showroom-scènes via Gemini Nano Banana. Deze directory is de kwaliteits-
benchmark — elk gegenereerd beeld moet visueel in lijn liggen met deze
referenties.

## Pipeline (concept)

1. **Maskeren** — BiRefNet verwijdert de originele achtergrond; de auto
   blijft over als transparante cutout. De auto is het enige wat Gemini
   te zien krijgt — geen bomen, geen parkings, geen afleiding.
2. **Gemini plaatst** — De gemaskeerde auto + achtergrond-plate +
   stijlreferenties + prompt → Gemini voegt samen. Doordat Gemini alleen
   het silhouet ziet, kan het geen details verzinnen.
3. **Pixel-bescherming** — De originele autopixels gaan altijd als laatste
   laag terug op het beeld. Velgen, badges en koplampen blijven exact zoals
   ze in de bronfoto stonden.

## Bestanden

| Pad | Beschrijving |
|-----|-------------|
| `PROMPT.md` | Referentieprompts: SHOWROOM_PROMPT (volledige scène) en _CUTOUT_RULES (geïsoleerde auto) |
| `assets/thumbnail_reference.webp` | Canonieke referentie: zwarte Kia EV SUV met CARREDO-plaat |
| `style_refs/lizy_1.webp` | Tesla Model 3 — voorbeeld van plaatplaatsing |
| `style_refs/lizy_2.webp` | Zwarte Kia SUV — identiek aan de canonieke referentie |
| `style_refs/lizy_3.webp` | Kia EV4 / lagere Kia — voorbeeld van plaatplaatsing |

## Achtergrond

De target-achtergrond staat in `backgrounds/showroom_bg.png`. Dit is de
grijze studioplate met betonvloer waarop Gemini de auto moet plaatsen.
