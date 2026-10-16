/** The video quality gate's decision rule and its "fully visible" test. */
import { describe, expect, it } from "vitest";
import { fullyVisible, gateVerdict, type FrameCheck } from "./gate";

const ok: FrameCheck = { face: true, fullyVisible: true, similarity: 0.5 };
const cut: FrameCheck = { face: true, fullyVisible: false, similarity: 0.5 };
const other: FrameCheck = { face: true, fullyVisible: true, similarity: 0.1 };

describe("quality gate", () => {
  it("passes when most frames show the full face and match the creator", () => {
    const v = gateVerdict([ok, ok, ok, ok, cut, other], 0.35);
    expect(v.passed).toBe(true);
    expect(v.visible).toBe(5);
    expect(v.matched).toBe(4);
    expect(v.need).toBe(4);
  });
  it("fails when the face is cropped in most frames", () => {
    const v = gateVerdict([ok, ok, ok, cut, cut, cut], 0.35);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/fully visible in only 3 of 6/);
  });
  it("fails when the face is someone else in most frames", () => {
    const v = gateVerdict([ok, ok, other, other, other, other], 0.35);
    expect(v.passed).toBe(false);
    expect(v.reason).toMatch(/matched the creator in only 2 of 6/);
  });
  it("fails with no frames", () => {
    expect(gateVerdict([], 0.35).passed).toBe(false);
  });
  it("treats a face box past the frame edge, or without headroom, as not fully visible", () => {
    const lm: [number, number][] = [[600, 300], [680, 300], [640, 340], [610, 380], [670, 380]];
    expect(fullyVisible({ box: [560, 220, 160, 220], landmarks: lm }, 1280, 720)).toBe(true);
    expect(fullyVisible({ box: [1180, 220, 160, 220], landmarks: lm }, 1280, 720)).toBe(false);
    expect(fullyVisible({ box: [560, 5, 160, 220], landmarks: lm }, 1280, 720)).toBe(false);
  });
});
