import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getPackageVersion } from "../src/version.js";

describe("getPackageVersion", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  it("returns the version declared in package.json", () => {
    expect(getPackageVersion()).toBe(pkg.version);
  });

  it("does not return the fallback when package.json is readable", () => {
    // Guards the failure mode that motivated this change: a fallback that is
    // indistinguishable from a real version tells you nothing went wrong.
    expect(getPackageVersion()).not.toBe("0.0.0");
  });

  it("returns a semver-shaped string", () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is stable across calls", () => {
    expect(getPackageVersion()).toBe(getPackageVersion());
  });

  // Note on coverage: these exercise the SOURCE-tree resolution, where
  // import.meta.url is src/version.ts and ../package.json is the repo root.
  // The published layout resolves dist/version.js against the package root,
  // which is the same relationship but not the same path. The fallback branch
  // is likewise not reachable here, since package.json is always present in a
  // checkout — it was verified manually by copying dist/version.js into a
  // directory with no package.json above it, which returns "0.0.0" and emits
  // the stderr line.
});
