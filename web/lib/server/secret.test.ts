/** Secrets come from an env value on a host like Vercel, else from the file the env names. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { secretText } from "./secret";

const KEY = `0x${"ab".repeat(32)}`;
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("secretText", () => {
  it("prefers the value and unescapes \\n in a PEM", () => {
    process.env.T_PEM = "-----BEGIN X-----\\nabc\\n-----END X-----";
    process.env.T_FILE = "/no/such/file";
    expect(secretText("T_PEM", "T_FILE")).toBe("-----BEGIN X-----\nabc\n-----END X-----");
  });

  it("falls back to the named file, then to the default file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "secret-"));
    writeFileSync(path.join(dir, "a"), "from file");
    writeFileSync(path.join(dir, "b"), "from default");
    process.env.T_FILE = path.join(dir, "a");
    expect(secretText("T_PEM", "T_FILE", path.join(dir, "b"))).toBe("from file");
    delete process.env.T_FILE;
    expect(secretText("T_PEM", "T_FILE", path.join(dir, "b"))).toBe("from default");
  });

  it("is null, not a throw, when a named file is missing (a host without ../.secrets)", () => {
    process.env.T_FILE = "/no/such/file";
    expect(secretText("T_PEM", "T_FILE", "/also/missing")).toBeNull();
  });
});
