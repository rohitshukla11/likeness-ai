import { describe, expect, it } from "vitest";
import { videoRefusal } from "./model";

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
    expect(videoRefusal(l, 10, 10)).toMatch(/daily video limit \(10\)/);
  });
});
