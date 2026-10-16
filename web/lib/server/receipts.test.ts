import { describe, expect, it, vi } from "vitest";
vi.mock("./kms", () => ({ signReceipt: vi.fn(), verifyReceiptSignature: vi.fn() }));
import { canonical } from "./receipts";

describe("receipt canonical form", () => {
  it("sorts keys, so the signed bytes don't depend on property order", () => {
    const a = { v: 1, contentSha256: "ab", mime: "image/jpeg", licenceId: "L", creatorId: "C", brandId: "B", use: "advertising", renderType: "image", renderIndex: 0, model: "m", price: 200, createdAt: 1 } as const;
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(canonical(b)).toBe(canonical(a));
    expect(canonical(a).startsWith('{"brandId":"B","contentSha256":"ab"')).toBe(true);
  });
});
