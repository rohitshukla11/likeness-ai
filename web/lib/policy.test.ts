/** Who auto-approves licence requests, and the daily caps for public brands. */
import { describe, expect, it } from "vitest";
import { AUTO_APPROVED_LABEL, autoApproves, capRefusal, type DailyCaps } from "./model";

describe("auto-approval", () => {
  it("is only for synthetic demo creators", () => {
    expect(autoApproves({ demo: true })).toBe(true);
    expect(autoApproves({ demo: false })).toBe(false);
    expect(autoApproves({})).toBe(false);
    expect(autoApproves(null)).toBe(false);
  });
  it("is labelled as such", () => {
    expect(AUTO_APPROVED_LABEL).toBe("auto-approved (synthetic demo creator)");
  });
});

describe("daily caps", () => {
  const caps: DailyCaps = { siteRenders: 40, siteVideos: 10, brandRenders: 3, brandVideos: 1 };
  const none = { renders: 0, videos: 0 };
  it("allow a brand's first ads", () => {
    expect(capRefusal("image", none, none, caps)).toBeNull();
    expect(capRefusal("video", none, { renders: 2, videos: 0 }, caps)).toBeNull();
  });
  it("stop a brand at 3 ads a day, videos included", () => {
    expect(capRefusal("image", none, { renders: 3, videos: 1 }, caps)).toMatch(/today's 3 ads, the daily limit per brand/);
  });
  it("stop a brand's second video but not its images", () => {
    expect(capRefusal("video", none, { renders: 1, videos: 1 }, caps)).toMatch(/still make image ads today/);
    expect(capRefusal("image", none, { renders: 1, videos: 1 }, caps)).toBeNull();
  });
  it("stop everyone at the site-wide limits, with a friendly reason", () => {
    expect(capRefusal("image", { renders: 40, videos: 3 }, none, caps)).toMatch(/today's 40 ads across all brands/);
    expect(capRefusal("video", { renders: 12, videos: 10 }, none, caps)).toMatch(/today's 10 video ads across all brands/);
    expect(capRefusal("image", { renders: 12, videos: 10 }, none, caps)).toBeNull();
  });
});
