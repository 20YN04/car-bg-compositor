import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { adoptSceneLight, detailDrift } from "./relight.js";

const W = 192;
// Ruim genoeg voor een schoon binnengebied: het verschuivingsveld heeft
// kromming binnen tweemaal de blurstraal van elke overgang, dus een auto van
// 48 px hoog heeft met straal 10 helemaal geen onaangeroerd midden.
const H = 240;

/**
 * Twee versies van dezelfde auto op dezelfde plek.
 *
 *   ons     vlak grijs met een fijn dambord: dat dambord staat voor badges,
 *           velgspaken en panelnaden — de identiteit.
 *   scène   dezelfde auto, maar door het model belicht: een verloop over de
 *           flank plus een donkere zone onderaan waar de vloer hem opvangt.
 *           Géén dambord: het model heeft de details anders getekend.
 *
 * Slaagt de stap, dan draagt het resultaat het verloop van de scène en het
 * dambord van ons.
 */
function paar() {
  const ours = Buffer.alloc(W * H * 3);
  const scene = Buffer.alloc(W * H * 3);
  const mask = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inCar = x >= 32 && x < 160 && y >= 24 && y < 200;
      mask[i] = inCar ? 255 : 0;

      const dambord = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0 ? 26 : 0;
      const onsV = inCar ? 90 + dambord : 140;

      // het model belicht: lichter naar rechts, donker onderaan bij de vloer
      const verloop = inCar ? 40 * (x - 32) / 128 : 0;
      const contact = inCar && y >= 170 ? -35 : 0;
      const sceneV = inCar ? 90 + verloop + contact : 140;

      for (let c = 0; c < 3; c++) {
        ours[i * 3 + c] = Math.max(0, Math.min(255, Math.round(onsV)));
        scene[i * 3 + c] = Math.max(0, Math.min(255, Math.round(sceneV)));
      }
    }
  }
  return { ours, scene, mask };
}

const png = (raw: Buffer, ch = 3) =>
  sharp(raw, { raw: { width: W, height: H, channels: ch as 1 | 3 } }).png().toBuffer();

describe("adoptSceneLight", () => {
  it("neemt de belichting van de scène over", async () => {
    const p = paar();
    const r = await adoptSceneLight(
      await png(p.scene), await png(p.ours), await png(p.mask, 1), 10, 60,
    );
    const out = await sharp(r.image).removeAlpha().raw().toBuffer();
    // Middelen over 4x4 vanaf een even coordinaat: dat is precies één periode
    // van het dambord. Een kleiner venster valt binnen één cel en dan meet je
    // de cel in plaats van de belichting.
    const at = (x: number, y: number) => {
      let sum = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        sum += out[((y + dy) * W + x + dx) * 3]!;
      }
      return sum / 16;
    };
    // links donker, rechts licht: het verloop van de scène is aangekomen
    expect(at(150, 40) - at(40, 40)).toBeGreaterThan(20);
    // en de contactzone onderaan is donkerder geworden
    expect(at(96, 100) - at(96, 180)).toBeGreaterThan(15);
  });

  it("laat het detail van de auto onaangeroerd", async () => {
    const p = paar();
    const before = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      for (let c = 0; c < 3; c++) before[i * 4 + c] = p.ours[i * 3 + c]!;
      before[i * 4 + 3] = 255;
    }
    const r = await adoptSceneLight(
      await png(p.scene), await png(p.ours), await png(p.mask, 1), 10, 60,
    );
    const outRaw = await sharp(r.image).ensureAlpha().raw().toBuffer();
    // De belofte direct meten: de amplitude van het dambord — onze identiteit —
    // hoort exact 26 te blijven, waar de scène de auto ook heen belicht.
    const out = await sharp(r.image).removeAlpha().raw().toBuffer();
    const v = (x: number, y: number) => out[(y * W + x) * 3]!;
    for (const [x, y] of [[50, 60], [96, 100], [140, 150], [60, 180]] as const) {
      // Twee naburige dambordcellen. Marge van 1,5 niveau, niet nul: het
      // verloop van de scène loopt zelf 0,6 niveau op over die twee pixels,
      // plus afronding op acht bits. Strakker eisen zou het model verwijten
      // dat het licht geeft.
      expect(Math.abs(Math.abs(v(x, y) - v(x + 2, y)) - 26)).toBeLessThan(1.5);
    }

    // En de indirecte maat, gemeten weg van de rand én weg van de contactstap
    // in de scène. Die stap is een belichtingsrand die het model toevoegt; de
    // detailmaat kan zo'n rand niet onderscheiden van veranderd detail, dus
    // daar zegt hij niets zinnigs.
    const binnen = new Uint8Array(W * H);
    for (let y = 50; y < 145; y++) {
      for (let x = 56; x < 136; x++) binnen[y * W + x] = 255;
    }
    const drift = detailDrift(before, outRaw, binnen, W, H, 10);
    expect(drift).toBeLessThan(2);
  });

  it("raakt niets buiten het masker", async () => {
    const p = paar();
    const r = await adoptSceneLight(
      await png(p.scene), await png(p.ours), await png(p.mask, 1), 10, 60,
    );
    const out = await sharp(r.image).removeAlpha().raw().toBuffer();
    for (const [x, y] of [[5, 5], [180, 230], [96, 5], [20, 120]] as const) {
      const i = (y * W + x) * 3;
      expect(out[i]).toBe(p.ours[i]);
    }
  });

  it("begrenst de verschuiving en meldt hoeveel er tegenaan liep", async () => {
    const p = paar();
    // model tekent de auto veel te licht: zonder rem zou hij worden overschreven
    for (let i = 0; i < W * H; i++) {
      if (p.mask[i] !== 255) continue;
      for (let c = 0; c < 3; c++) p.scene[i * 3 + c] = 245;
    }
    const r = await adoptSceneLight(
      await png(p.scene), await png(p.ours), await png(p.mask, 1), 10, 12,
    );
    expect(r.maxShift).toBeLessThanOrEqual(12);
    expect(r.clipped).toBeGreaterThan(0.5);
    const out = await sharp(r.image).removeAlpha().raw().toBuffer();
    // de auto is hooguit 12 niveaus opgeschoven, niet naar 245 getrokken
    expect(out[(100 * W + 96) * 3]!).toBeLessThan(90 + 26 + 13);
  });

  it("weigert een scène van een andere maat i.p.v. hem stil te herschalen", async () => {
    const p = paar();
    const klein = await sharp(p.scene, { raw: { width: W, height: H, channels: 3 } })
      .resize(W / 2, H / 2)
      .png()
      .toBuffer();
    await expect(
      adoptSceneLight(klein, await png(p.ours), await png(p.mask, 1), 10, 60),
    ).rejects.toThrow(/verschillen van maat/);
  });
});
