import "server-only";
/**
 * Face-aware framing, so a video ad never starts from a still with the face cropped out:
 *  - cropWindow: the largest crop of the target aspect that keeps the whole face plus headroom,
 *    eyes near the upper third. If the face and its margins don't fit, there is no crop (null);
 *  - fitStill: crop with that window, or, when it is null (or no face is found), fit the whole still
 *    over a blurred copy of itself. Never a centre crop;
 *  - labelSpot: where the visible label goes, bottom-left by default, away from the face and from
 *    the area directly below it (where hands holding a product usually are; hands aren't detected).
 */
import sharp from "sharp";
import { analyseFaces } from "./facematch";

export type Box = { x: number; y: number; w: number; h: number };
export type Rect = { left: number; top: number; width: number; height: number };

/** The face plus the margins that must stay in frame: headroom above the hair, chin and ears. */
export function faceRegion(face: Box, imgW: number, imgH: number): Box {
  const x0 = Math.max(0, face.x - face.w * 0.25);
  const y0 = Math.max(0, face.y - face.h * 0.55);
  const x1 = Math.min(imgW, face.x + face.w * 1.25);
  const y1 = Math.min(imgH, face.y + face.h * 1.3);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function cropWindow(imgW: number, imgH: number, face: Box | null, aspect: number): Rect | null {
  if (!face) return null;
  const [width, height] = imgW / imgH > aspect ? [Math.round(imgH * aspect), imgH] : [imgW, Math.round(imgW / aspect)];
  const need = faceRegion(face, imgW, imgH);
  if (need.w > width || need.h > height) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  // Centre on the face horizontally, eyes (about 40% down the face box) on the upper third.
  let left = face.x + face.w / 2 - width / 2;
  left = clamp(left, need.x + need.w - width, need.x);
  left = clamp(left, 0, imgW - width);
  let top = face.y + face.h * 0.4 - height / 3;
  top = clamp(top, need.y + need.h - height, need.y);
  top = clamp(top, 0, imgH - height);
  return { left: Math.round(left), top: Math.round(top), width, height };
}

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The label's top-left corner: the first safe corner of bottom-left, bottom-right, top-left, top-right. */
export function labelSpot(W: number, H: number, label: { w: number; h: number }, faces: Box[]): { x: number; y: number; corner: string } {
  const m = Math.round(Math.min(W, H) * 0.04);
  const corners = [
    { corner: "bottom-left", x: m, y: H - label.h - m },
    { corner: "bottom-right", x: W - label.w - m, y: H - label.h - m },
    { corner: "top-left", x: m, y: m },
    { corner: "top-right", x: W - label.w - m, y: m },
  ];
  // Keep clear of each face (with a margin) and of the column below it, down to the bottom edge.
  const avoid = faces.flatMap((f) => [
    { x: f.x - f.w * 0.15, y: f.y - f.h * 0.15, w: f.w * 1.3, h: f.h * 1.3 },
    { x: f.x - f.w * 0.5, y: f.y + f.h, w: f.w * 2, h: H - (f.y + f.h) },
  ]);
  const free = corners.find((c) => avoid.every((a) => !overlaps({ x: c.x, y: c.y, w: label.w, h: label.h }, a)));
  return free ?? corners[0];
}

const toBox = (b: [number, number, number, number]): Box => ({ x: b[0], y: b[1], w: b[2], h: b[3] });

/** Faces in an image as boxes, best first. */
export async function faceBoxes(bytes: Uint8Array): Promise<{ width: number; height: number; faces: Box[] }> {
  const a = await analyseFaces(bytes);
  return { width: a.width, height: a.height, faces: a.faces.map((f) => toBox(f.box)) };
}

/** The still at exactly W×H for Veo, framed around the face. */
export async function fitStill(raw: Uint8Array, W: number, H: number): Promise<{ bytes: Uint8Array; method: string; face: Box | null }> {
  const upright = await sharp(raw).rotate().jpeg({ quality: 95 }).toBuffer();
  const { width, height, faces } = await faceBoxes(new Uint8Array(upright));
  const face = faces[0] ?? null;
  const rect = cropWindow(width, height, face, W / H);
  if (rect) {
    const out = await sharp(upright).extract(rect).resize(W, H).jpeg({ quality: 94 }).toBuffer();
    const exact = rect.width === width && rect.height === height;
    return { bytes: new Uint8Array(out), method: exact ? "native aspect, no crop" : "face-aware crop (YuNet)", face };
  }
  // No safe crop: the whole still, fitted, over a blurred fill of itself.
  const bg = await sharp(upright).resize(W, H, { fit: "cover" }).blur(40).modulate({ brightness: 0.8 }).toBuffer();
  const fg = await sharp(upright).resize(W, H, { fit: "inside" }).toBuffer({ resolveWithObject: true });
  const out = await sharp(bg)
    .composite([{ input: fg.data, left: Math.round((W - fg.info.width) / 2), top: Math.round((H - fg.info.height) / 2) }])
    .jpeg({ quality: 94 })
    .toBuffer();
  return { bytes: new Uint8Array(out), method: face ? "fitted without cropping (the face and headroom wouldn't fit a crop)" : "fitted without cropping (no face found)", face };
}
