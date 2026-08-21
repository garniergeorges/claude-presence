import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this module's own compiled location (dist/version.js),
// not the importer's — so it's always one level up from dist/, where
// package.json ships alongside it (package.json is included in every npm
// package by default; "files" in package.json only restricts extras).
let cached: string | undefined;

export function getPackageVersion(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
