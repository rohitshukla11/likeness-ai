/** Face-aware cropping and label placement: geometry only, no models needed. */
import { describe, expect, it } from "vitest";
import { cropWindow, faceRegion, labelSpot } from "./framing";

const inside = (r: { left: number; top: number; width: number; height: number }, b: { x: number; y: number; w: number; h: number }) =>
  b.x >= r.left && b.y >= r.top && b.x + b.w <= r.left + r.width && b.y + b.h <= r.top + r.height;

describe("face-aware crop", () => {
  it("keeps the whole face and headroom when cropping a square still to 16:9", () => {
    const face = { x: 430, y: 210, w: 180, h: 245 };
    const r = cropWindow(1024, 1024, face, 16 / 9)!;
    expect(r.width).toBe(1024);
    expect(r.height).toBe(576);
    expect(inside(r, faceRegion(face, 1024, 1024))).toBe(true);
    // Eyes (about 40% down the face) near the upper third, not a centre crop.
    expect(r.top).not.toBe(Math.round((1024 - 576) / 2));
    expect(Math.abs(face.y + face.h * 0.4 - (r.top + r.height / 3))).toBeLessThan(60);
  });

  it("follows a face near the edge into a 9:16 crop", () => {
    const face = { x: 820, y: 300, w: 150, h: 200 };
    const r = cropWindow(1024, 1024, face, 9 / 16)!;
    expect(inside(r, faceRegion(face, 1024, 1024))).toBe(true);
    expect(r.left).toBeGreaterThan(400);
  });

  it("refuses to crop when the face and headroom don't fit, or no face is found", () => {
    expect(cropWindow(1024, 1024, { x: 200, y: 150, w: 600, h: 700 }, 16 / 9)).toBeNull();
    expect(cropWindow(1024, 1024, null, 16 / 9)).toBeNull();
  });
});

describe("label placement", () => {
  const label = { w: 300, h: 34 };
  it("goes bottom-left when that corner is clear", () => {
    expect(labelSpot(1280, 720, label, [{ x: 800, y: 150, w: 200, h: 260 }]).corner).toBe("bottom-left");
  });
  it("moves away from a face on the left, and from the area below it", () => {
    expect(labelSpot(1280, 720, label, [{ x: 80, y: 150, w: 200, h: 260 }]).corner).toBe("bottom-right");
  });
  it("never sits over a face", () => {
    const face = { x: 0, y: 0, w: 1280, h: 300 };
    const s = labelSpot(1280, 720, label, [face]);
    expect(s.y).toBeGreaterThanOrEqual(300);
  });
});
