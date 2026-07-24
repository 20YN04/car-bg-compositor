# Carredo Imaging Reference Prompt

Deze prompt wordt gebruikt voor generatieve showroom-compositing van auto's. De
car-bg-compositor pipeline is de niet-generatieve tegenhanger — de prompt hier
dient als referentie voor styling, compositie en output-eisen.

---

## SHOWROOM_PROMPT

Take the car from the FIRST image and place it into the grey studio shown in the SECOND image. The THIRD image is a positioning guide… The output must look like a real studio photograph.

### POSITIONING GRID (THIRD image) — ALIGNMENT GUIDE ONLY

Magenta raster (10% lines) + magenta CAR TARGET rectangle + cyan WALL/FLOOR SEAM line. Place car inside the magenta rectangle, wheels on its bottom edge; render the wall/floor seam exactly on the cyan line; zero magenta/cyan pixels in the output.

### POSITIONING — STRICT

Studio HUGE like an aircraft hangar, car ≥6 m in front of the wall; ≥30% image-height of empty floor behind the car; car horizontally centred, ~60% frame width; camera elevated ~1.7 m tilted slightly down.

### CAMERA ANGLE

MATCH THE SOURCE EXACTLY (no rotation).

### FLOOR

Polished concrete, contact shadow + soft reflection.

### REFLECTIONS ON THE CAR

Preserve paint finish; swap only what is reflected (trees/sky → grey studio); no hard softbox/skylight; windows = dark tinted glass.

### WHEELS AND RIMS

NEVER alter shape/finish/centre cap.

### DO NOT REGENERATE

Headlights/badges; LICENSE PLATE replaced with solid-black + bold white "CARREDO" when a bumper is visible, omitted otherwise.

---

## _CUTOUT_RULES

- MATCH THE REFERENCE IMAGES EXACTLY (framing, angle, height, lighting, shadow, plate shape/size/position/tilt).
- POSITIONING GRID conveys NO car identity — identity comes only from source + spec.
- OUTPUT: pure white #FFFFFF edge-to-edge, 8:5 aspect ratio, zero magenta pixels.
- Camera: 3/4 front-RIGHT (~30–35°, front on the RIGHT); height ~1.0–1.3 m.
- Car: ~85% width, midpoint at ~45% (left-biased, room for badge on right).
- Shadow: small tight contact shadow only.
- LICENSE PLATE: solid-black + bold white "CARREDO", mounted low on the RIGHT half of the bumper (~65–75% across), rounded corners, ~11–13% of body length — identical across all four references regardless of the car's real plate mount.

---

## Reference Images

| File | Description |
|------|-------------|
| `assets/thumbnail_reference.webp` | Canonical anchor — black Kia EV SUV with CARREDO plate |
| `style_refs/lizy_1.webp` | Tesla Model 3 — plate placement example |
| `style_refs/lizy_2.webp` | Black Kia SUV — identical to the canonical reference |
| `style_refs/lizy_3.webp` | Kia EV4 / lower-slung Kia — plate placement example |
