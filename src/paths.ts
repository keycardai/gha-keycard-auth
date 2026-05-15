import * as fs from "fs";
import * as path from "path";

/**
 * Returns the directory under which all credential files MUST live.
 *
 * H3/M1 mitigation — credentials may only be written under a directory the
 * action itself creates inside RUNNER_TEMP. Workflow-supplied file paths are
 * validated against this root before any filesystem operation, and the post
 * step refuses to touch files outside it. This prevents a malicious
 * file-path from writing tokens to ~/.ssh/authorized_keys, /etc/hosts, the
 * actions cache, etc., and prevents a state-tampering intermediate step
 * from getting the post step to unlink arbitrary paths.
 */
export function credentialsRoot(): string {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    throw new Error(
      "RUNNER_TEMP is not set; this action must run on a GitHub Actions runner",
    );
  }
  const root = path.join(runnerTemp, "keycard-auth");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  // Ensure it actually has tight permissions even if mkdirSync ignored mode
  // (some filesystems / older Node versions). chmod is a no-op if already set.
  try {
    fs.chmodSync(root, 0o700);
  } catch {
    // Best effort.
  }
  return root;
}

/**
 * Validate that the workflow-supplied filePath resolves to a location strictly
 * inside the credentials root. Returns the resolved absolute path on success.
 *
 * Rejects:
 *   - paths that escape the root via "../" components
 *   - paths whose parent components contain symlinks (TOCTOU defense)
 *   - paths exactly equal to the root itself
 */
export function resolveSafeCredentialPath(filePath: string, root: string): string {
  const resolved = path.resolve(root, filePath);

  // After resolve(), the path must still be inside root.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `file-path escapes the credentials root: ${filePath} resolved to ${resolved}, must be under ${root}`,
    );
  }
  if (resolved === root) {
    throw new Error(`file-path must be a file within ${root}, not the root itself`);
  }

  // Walk parent dirs from root → leaf. Each existing component must NOT be a
  // symlink. This blocks an attacker who pre-populates a symlink inside root
  // (e.g. via a prior step) and races the action.
  const parent = path.dirname(resolved);
  let current = root;
  for (const segment of path.relative(root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `file-path traverses a symlink (${current}); refusing to write`,
        );
      }
    }
  }

  return resolved;
}

/**
 * Path within RUNNER_TEMP where the cleanup manifest is persisted between
 * main and post. We use a file (mode 0600) inside the credentials root rather
 * than core.saveState, so an intermediate step cannot tamper with cleanup
 * targets via $GITHUB_STATE.
 */
export function manifestPath(): string {
  return path.join(credentialsRoot(), "cleanup-manifest.json");
}
