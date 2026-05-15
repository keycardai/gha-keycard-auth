import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { readCleanupState } from "./state";
import { credentialsRoot } from "./paths";

/**
 * Post-step cleanup. Exported for testing — main entry point invokes this at
 * the bottom of the file. We intentionally swallow errors and emit warnings
 * rather than failing the job: a post-step failure cannot un-export already-
 * applied credentials, and surfacing the failure as a job error would mask
 * the real result.
 */
export async function runCleanup(): Promise<void> {
  const { envNames, filePaths } = readCleanupState();
  const root = credentialsRoot();

  for (const name of envNames) {
    core.exportVariable(name, "");
    delete process.env[name];
  }

  let cleanedFiles = 0;
  for (const file of filePaths) {
    try {
      cleanupFile(file, root);
      cleanedFiles++;
    } catch (err) {
      core.warning(
        `failed to clean up ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Remove the credentials root last (manifest file inclusive).
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    core.warning(
      `failed to remove credentials root ${root}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (envNames.length > 0 || cleanedFiles > 0) {
    core.info(
      `post: cleared ${envNames.length} env var(s), removed ${cleanedFiles} file(s)`,
    );
  }
}

/**
 * Securely zero-overwrite and unlink a credential file.
 *
 * H3/M1/M3 mitigations:
 *   - Path must be under the credentials root; otherwise refuse.
 *   - Open with O_NOFOLLOW so a swapped-in symlink causes ELOOP
 *     rather than overwriting the symlink target.
 *   - Read the size from the open fd (fstat), not from a separate
 *     statSync that races against the open.
 */
export function cleanupFile(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`refusing to clean path outside credentials root: ${resolved}`);
  }

  let fd: number;
  try {
    fd = fs.openSync(
      resolved,
      fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // already gone
    if (code === "ELOOP") {
      // The path is a symlink — don't follow, just unlink the symlink itself.
      try {
        fs.unlinkSync(resolved);
      } catch {
        // best effort
      }
      return;
    }
    throw err;
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size > 0) {
      fs.writeSync(fd, Buffer.alloc(size, 0), 0, size, 0);
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(resolved);
}

// Top-level entry. Vitest imports this module to test the exported helpers
// without invoking the side-effecting entry point, because process.env.VITEST
// is set by the test runner.
if (!process.env.VITEST) {
  runCleanup().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`post cleanup failed: ${message}`);
  });
}
