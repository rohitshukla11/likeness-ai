import { existsSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { labelVideo, motionAd } from "./motion";
import { embedManifest, readManifest } from "./c2pa";

const ff = process.env.FFMPEG_PATH ?? "";
const haveFfmpeg = !!ff && existsSync(ff);
const haveCert = existsSync("../.secrets/c2pa/signer.pem");
const isMp4 = (b: Uint8Array) => Buffer.from(b.subarray(4, 8)).toString() === "ftyp";

describe.skipIf(!haveFfmpeg)("ffmpeg motion ad (fallback)", () => {
  it("makes a labelled 16:9 H.264 MP4 with a C2PA manifest from a still", async () => {
    const still = new Uint8Array(await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#c9a27e" } }).jpeg().toBuffer());
    const ad = await motionAd({ still, caption: "Spring oat latte, now in store", brand: "Brew & Co.", aspectRatio: "16:9", seconds: 6 });
    expect(isMp4(ad)).toBe(true);
    const labelled = await labelVideo(ad, 1280);
    expect(isMp4(labelled)).toBe(true);
    if (!haveCert) return;
    const signed = embedManifest(labelled, "video/mp4", {
      protocol: "likeness-ai/1", licenceId: "L", renderIndex: 0, renderType: "video",
      creator: { id: "c", name: "Demo", youtubeChannelId: null }, licensee: { id: "b", name: "Brew & Co." }, use: "advertising",
      receipt: { store: "Firestore receipts/{sha256}", key: "sha256 of this file, manifest included", signedBy: "Cloud KMS EC_SIGN_P256_SHA256", verify: "/verify" },
      renderer: { provider: "ffmpeg", model: "ffmpeg motion ad (fallback)" }, promptSha256: "00", createdAt: new Date().toISOString(),
    });
    const m = await readManifest(signed, "video/mp4");
    expect(m.present && m.licence?.renderType).toBe("video");
    expect(m.present && m.signatureValid).toBe(true);
  }, 60_000);
});
