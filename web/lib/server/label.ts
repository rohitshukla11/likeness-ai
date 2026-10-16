import "server-only";
/** The visible "AI-generated · licensed likeness" label, bottom-right, scaled to the image width. */
import sharp from "sharp";
import { LABEL_AI_RENDER, WATERMARK_PROFILE } from "./watermarks";

async function stamp(bytes: Uint8Array, mark: Buffer, fraction: number, out: "jpeg" | "png"): Promise<Buffer> {
  const img = sharp(bytes).rotate();
  const { width = 1024, height = 1024 } = await img.metadata();
  const w = Math.max(160, Math.round(width * fraction));
  const label = await sharp(mark).resize({ width: w }).png().toBuffer();
  const lh = (await sharp(label).metadata()).height ?? 40;
  const margin = Math.round(width * 0.025);
  const composed = img.composite([{ input: label, left: Math.max(0, width - w - margin), top: Math.max(0, height - lh - margin) }]);
  return out === "png" ? composed.png().toBuffer() : composed.jpeg({ quality: 92 }).toBuffer();
}

export const labelRender = (bytes: Uint8Array) => stamp(bytes, LABEL_AI_RENDER, 0.42, "jpeg");

/** The creator's public photo: 512 px, metadata removed, labelled "profile photo, not licensed for reuse". */
export async function publicPhoto(front: Uint8Array): Promise<Buffer> {
  const small = await sharp(front).rotate().resize(512, 512, { fit: "cover" }).jpeg({ quality: 88 }).toBuffer();
  return stamp(small, WATERMARK_PROFILE, 0.62, "jpeg");
}
