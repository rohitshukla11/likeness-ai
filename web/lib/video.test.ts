import { describe, expect, it } from "vitest";
import { videoPrice, videoRefusal, withVideoDefaults, type LicenceDoc } from "./model";
import { stillRules, veoPrompt } from "./creative";

describe("video caps", () => {
  const l = { videoAllowed: true, maxVideos: 3, videoCount: 0 };
  it("allows a video under both caps", () => {
    expect(videoRefusal(l, 0, 10)).toBeNull();
  });
  it("refuses when the creator doesn't allow video", () => {
    expect(videoRefusal({ ...l, videoAllowed: false }, 0, 10)).toMatch(/doesn't allow video/);
  });
  it("refuses at the per-licence cap", () => {
    expect(videoRefusal({ ...l, videoCount: 3 }, 0, 10)).toMatch(/video limit \(3\) is used up/);
  });
  it("refuses at the site's daily cap", () => {
    expect(videoRefusal(l, 10, 10)).toMatch(/today.s 10 video ads across all brands/);
  });
});

describe("licences approved before video ads", () => {
  const old = { maxRenders: 2 } as Omit<LicenceDoc, "videoAllowed" | "maxVideos" | "videoCount">;
  it("get decide()'s defaults, capped by the render limit", () => {
    expect(withVideoDefaults(old)).toMatchObject({ videoAllowed: true, maxVideos: 2, videoCount: 0 });
  });
  it("keep their own video terms when set", () => {
    expect(withVideoDefaults({ ...old, videoAllowed: false, maxVideos: 1, videoCount: 1 })).toMatchObject({ videoAllowed: false, maxVideos: 1, videoCount: 1 });
  });
});

describe("video price and prompts", () => {
  it("charges twice the video price for 1080p", () => {
    expect(videoPrice({ pricePerVideo: 200 })).toBe(200);
    expect(videoPrice({ pricePerVideo: 200 }, "1080p")).toBe(400);
  });
  it("always appends the framing rules to stills and the motion and framing rules to Veo", () => {
    expect(stillRules("9:16")).toMatch(/full head and face visible/);
    expect(stillRules("9:16")).toMatch(/centre third/);
    const p = veoPrompt("She lifts the cup", "16:9");
    expect(p.startsWith("She lifts the cup")).toBe(true);
    expect(p).toMatch(/full face stays in frame/);
    expect(p).toMatch(/eyes in the upper third/);
    expect(veoPrompt("x", "16:9", true)).toMatch(/no zoom-in/);
  });
});
