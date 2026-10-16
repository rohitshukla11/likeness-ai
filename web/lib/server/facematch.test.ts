/**
 * The local face matcher's geometry (always) and, when the models are present (`pnpm face:models`),
 * that a picture with no face is refused rather than scored.
 */
import { existsSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { compareFaces, similarity, facesIn } from "./facematch";

describe("similarity transform", () => {
  it("recovers a known scale, rotation and translation exactly", () => {
    const theta = 0.3;
    const s = 1.7;
    const [p, q, tx, ty] = [s * Math.cos(theta), s * Math.sin(theta), 12, -5];
    const src = [
      [10, 20],
      [40, 22],
      [25, 35],
      [14, 50],
      [37, 51],
    ];
    const dst = src.map(([x, y]) => [p * x - q * y + tx, q * x + p * y + ty]);
    const t = similarity(src, dst);
    expect(t.p).toBeCloseTo(p, 9);
    expect(t.q).toBeCloseTo(q, 9);
    expect(t.tx).toBeCloseTo(tx, 9);
    expect(t.ty).toBeCloseTo(ty, 9);
  });
});

describe.skipIf(!existsSync(".models/auraface_glintr100.onnx"))("local matcher with models", () => {
  it("refuses images without a face", async () => {
    const blank = new Uint8Array(await sharp({ create: { width: 400, height: 400, channels: 3, background: "#808080" } }).jpeg().toBuffer());
    await expect(compareFaces(blank, blank)).rejects.toThrow(/no face/);
  });

  it("counts no faces in a blank avatar, so the channel is refused", async () => {
    const blank = new Uint8Array(await sharp({ create: { width: 800, height: 800, channels: 3, background: "#d0c8bc" } }).jpeg().toBuffer());
    expect((await facesIn(blank)).count).toBe(0);
  });
});
