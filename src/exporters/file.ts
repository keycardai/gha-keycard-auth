import * as fs from "fs";
import * as path from "path";
import { recordFileForCleanup } from "../state";
import { credentialsRoot, resolveSafeCredentialPath } from "../paths";
import { maskSecret } from "../mask";

/**
 * Write a credential value to a file under the action-managed credentials
 * root. The workflow-supplied file-path is resolved relative to that root
 * and validated to ensure it cannot escape (H3/M1/M3 mitigations).
 *
 * Returns the absolute path written, so callers can surface it to the user.
 */
export function exportFile(filePath: string, mode: string, value: string): string {
  maskSecret(value);
  const root = credentialsRoot();
  const resolved = resolveSafeCredentialPath(filePath, root);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });

  // O_NOFOLLOW: if a symlink was planted at `resolved` between mkdir and
  // open (TOCTOU), the open fails with ELOOP instead of writing through it.
  // O_EXCL: refuse to open if the path already exists as a regular file.
  // The credentials root is wiped between runs, so a pre-existing file is
  // always suspicious — fail loud rather than silently overwriting.
  const fd = fs.openSync(
    resolved,
    fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    parseMode(mode),
  );
  try {
    fs.writeSync(fd, value);
  } finally {
    fs.closeSync(fd);
  }
  // Belt-and-suspenders: enforce mode in case the umask altered it on create.
  fs.chmodSync(resolved, parseMode(mode));
  recordFileForCleanup(resolved);
  return resolved;
}

/**
 * Parse a workflow-supplied file mode string.
 *
 * Accepts "0600", "600", "0o600". Throws on anything that doesn't parse as
 * octal, including the empty string or values that include 1-bits in the
 * group or world triads — credential files on a shared CI runner have no
 * legitimate reason to be readable by anyone other than the owner. We prefer
 * a loud failure over silently downgrading a misspecified mode (which would
 * either over-permit or surprise the user).
 */
export function parseMode(mode: string): number {
  const cleaned = mode.replace(/^0o?/, "");
  if (!/^[0-7]+$/.test(cleaned)) {
    throw new Error(
      `file-mode must be octal (e.g. "0600", "600", "0o600"); got "${mode}"`,
    );
  }
  const parsed = parseInt(cleaned, 8);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 0o777) {
    throw new Error(`file-mode out of range: "${mode}"`);
  }
  if ((parsed & 0o077) !== 0) {
    const octal = parsed.toString(8).padStart(4, "0");
    throw new Error(
      `file-mode "${mode}" (0${octal}) grants group or world access; credential files must be owner-only (e.g. 0600, 0400, 0700)`,
    );
  }
  return parsed;
}
