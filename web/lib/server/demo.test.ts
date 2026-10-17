/** Demo brand guards that don't need Firestore: who counts as a demo caller, and the default caps. */
import { describe, expect, it } from "vitest";
import { forbidDemo } from "./authn";
import { demoLimits, isDemoUid } from "./demo";

describe("demo brands", () => {
  it("are recognised by their uid", () => {
    expect(isDemoUid("demo-brand-abc123")).toBe(true);
    expect(isDemoUid("hGi8Whxyz")).toBe(false);
    expect(isDemoUid("demo-maya-okafor")).toBe(false);
  });
  it("can't do what needs a real Google account", () => {
    expect(() => forbidDemo({ uid: "demo-brand-x", email: null, name: null, picture: null, demo: true }, "become a creator")).toThrow(/can't become a creator/);
    expect(() => forbidDemo({ uid: "u1", email: "a@b.c", name: "A", picture: null, demo: false }, "become a creator")).not.toThrow();
  });
  it("have small default caps that bound the daily spend", () => {
    const l = demoLimits();
    expect(l.rendersPerLicence).toBe(3);
    expect(l.videosPerLicence).toBe(1);
    expect(l.rendersPerDay).toBeLessThanOrEqual(15);
    expect(l.videosPerDay).toBeLessThanOrEqual(3);
  });
});
