import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../client");

let cached: string | null = null;

/**
 * Stable id for the console scripts this process is serving.
 * A new process after a deploy gets a new id when those files changed.
 * /health reports it. The page records the id it was served with.
 */
export function clientBuildId(): string {
  if (cached) return cached;
  const hash = createHash("sha256");
  for (const file of clientFiles(clientDir)) {
    hash.update(path.relative(clientDir, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  cached = hash.digest("hex").slice(0, 16);
  return cached;
}

/** The open tab loaded this id. A different server id means those scripts are stale. */
export function clientBuildIsCurrent(loaded: string, server: string): boolean {
  return loaded.length > 0 && server.length > 0 && loaded === server;
}

function clientFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...clientFiles(full));
    else if (/\.(html|js|css)$/.test(entry.name)) found.push(full);
  }
  found.sort();
  return found;
}
