import * as fs from "fs";
import { manifestPath } from "./paths";

/**
 * Cleanup manifest persisted by the main step and consumed by the post step.
 *
 * M1 mitigation — written to a 0600 file inside the credentials root rather
 * than core.saveState. core.saveState writes to $GITHUB_STATE which any
 * intermediate step in the same job can append to, allowing an attacker to
 * make the post step zero-overwrite/unlink arbitrary paths. The manifest
 * file lives in a directory the action created with mode 0700; even if
 * tampered with, the post step still validates every path is under the
 * credentials root before touching it.
 */
interface CleanupManifest {
  envNames: string[];
  filePaths: string[];
}

function readManifest(): CleanupManifest {
  const path = manifestPath();
  if (!fs.existsSync(path)) {
    return { envNames: [], filePaths: [] };
  }
  try {
    const raw = fs.readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CleanupManifest>;
    return {
      envNames: sanitizeStringArray(parsed.envNames),
      filePaths: sanitizeStringArray(parsed.filePaths),
    };
  } catch {
    return { envNames: [], filePaths: [] };
  }
}

function writeManifest(manifest: CleanupManifest): void {
  const path = manifestPath();
  fs.writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
}

export function recordEnvForCleanup(name: string): void {
  const m = readManifest();
  m.envNames.push(name);
  writeManifest(m);
}

export function recordFileForCleanup(path: string): void {
  const m = readManifest();
  m.filePaths.push(path);
  writeManifest(m);
}

export function readCleanupState(): CleanupManifest {
  return readManifest();
}

function sanitizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}
