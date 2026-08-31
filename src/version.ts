import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved relative to this module's own compiled location (dist/version.js),
// not the importer's — so it's always one level up from dist/, where
// package.json ships alongside it (package.json is included in every npm
// package by default; "files" in package.json only restricts extras).
const FALLBACK_VERSION = "0.0.0";

let cached: string | undefined;

export function getPackageVersion(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cached = pkg.version ?? FALLBACK_VERSION;
  } catch (err) {
    // Report rather than swallow. stdout is the MCP protocol channel, so this
    // goes to stderr, where the client surfaces it as a server log line.
    // Silently reporting 0.0.0 would make a packaging fault indistinguishable
    // from a genuine version, to clients and to whoever is debugging it.
    console.error(
      `claude-presence: could not read package.json for version, falling back to ${FALLBACK_VERSION} —`,
      err instanceof Error ? err.message : err,
    );
    cached = FALLBACK_VERSION;
  }
  return cached;
}
