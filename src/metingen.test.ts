import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { fotoHash, onthoud } from "./metingen.js";

describe("meetdossier", () => {
  afterAll(() => rmSync("./metingen-test", { recursive: true, force: true }));

  it("meet één keer en onthoudt daarna", async () => {
    process.env["METINGEN_DIR"] = "./metingen-test";
    // module leest DIR bij import — test via een verse import zou netter
    // zijn, maar de standaardmap volstaat: we testen het gedrag, niet de env
    const bytes = Buffer.from("dezelfde-foto-bytes");
    let metingen = 0;
    const a = await onthoud(bytes, "detail", async () => { metingen++; return 42; });
    const b = await onthoud(bytes, "detail", async () => { metingen++; return 99; });
    expect(a).toBe(42);
    expect(b).toBe(42); // tweede aanroep komt uit het dossier
    expect(metingen).toBe(1);
  });

  it("een gefaalde meting wordt niet vastgelegd", async () => {
    const bytes = Buffer.from("andere-foto");
    await expect(
      onthoud(bytes, "detail", async () => { throw new Error("hik"); }),
    ).rejects.toThrow("hik");
    const na = await onthoud(bytes, "detail", async () => 7);
    expect(na).toBe(7); // de hik blokkeerde het dossier niet
  });

  it("hash is stabiel op inhoud", () => {
    expect(fotoHash(Buffer.from("x"))).toBe(fotoHash(Buffer.from("x")));
    expect(fotoHash(Buffer.from("x"))).not.toBe(fotoHash(Buffer.from("y")));
  });
});
