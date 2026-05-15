import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as core from "@actions/core";
import { cleanupFile, runCleanup } from "./post";

describe("cleanupFile", () => {
  let tmpDir: string;
  let root: string;
  let savedRunnerTemp: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-post-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = tmpDir;
    root = path.join(tmpDir, "keycard-auth");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("zero-overwrites and unlinks a regular file under root", () => {
    const target = path.join(root, "secret.pem");
    fs.writeFileSync(target, "SENSITIVE", { mode: 0o600 });
    cleanupFile(target, root);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("tolerates a missing file (ENOENT — already gone)", () => {
    const target = path.join(root, "missing.pem");
    expect(() => cleanupFile(target, root)).not.toThrow();
  });

  it("refuses to touch /etc/passwd via a tampered manifest entry (M1)", () => {
    // A malicious intermediate step that rewrites the manifest cannot make
    // the post step unlink arbitrary paths — the root check fires first.
    expect(() => cleanupFile("/etc/passwd", root)).toThrow(
      /refusing to clean path outside credentials root/,
    );
    expect(fs.existsSync("/etc/passwd")).toBe(true);
  });

  it("refuses paths that escape root via traversal", () => {
    const outside = path.join(tmpDir, "outside-root.txt");
    fs.writeFileSync(outside, "OTHER");
    expect(() => cleanupFile(outside, root)).toThrow(
      /refusing to clean path outside credentials root/,
    );
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("refuses the credentials root itself", () => {
    // The root removal happens separately in runCleanup via fs.rmSync.
    // A manifest entry that names the root must not be processed as a file.
    expect(() => cleanupFile(root, root)).toThrow();
  });

  it("does NOT follow a symlink at target (M3) — unlinks the symlink, leaves target intact", () => {
    const outsideTarget = path.join(tmpDir, "real-secret.pem");
    fs.writeFileSync(outsideTarget, "OUTSIDE-CONTENT", { mode: 0o600 });
    const link = path.join(root, "linked.pem");
    fs.symlinkSync(outsideTarget, link);

    cleanupFile(link, root);

    // The symlink is gone, but the file it pointed to is untouched.
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.existsSync(outsideTarget)).toBe(true);
    expect(fs.readFileSync(outsideTarget, "utf8")).toBe("OUTSIDE-CONTENT");
  });

  it("zero-overwrites file contents before unlinking", () => {
    // We can't reliably spy on the default fs functions in ESM, so instead
    // we observe disk state from a "shoulder peek" — point the test at the
    // file, capture its bytes immediately before unlink by hard-linking it
    // first, and assert those bytes are all zero.
    const target = path.join(root, "trace.pem");
    const original = "SENSITIVE-PAYLOAD-12345";
    fs.writeFileSync(target, original, { mode: 0o600 });
    // Hard-link the file. After cleanupFile unlinks `target`, the linked
    // inode survives and reflects the final on-disk state of the data
    // (post zero-overwrite, pre-unlink).
    const peek = path.join(root, "peek.pem");
    fs.linkSync(target, peek);

    cleanupFile(target, root);

    expect(fs.existsSync(target)).toBe(false);
    // The other hard-link still points at the same inode. Its content must
    // be all-zero, the same length as the original.
    const peekBytes = fs.readFileSync(peek);
    expect(peekBytes.length).toBe(original.length);
    expect(peekBytes.every((b) => b === 0)).toBe(true);
  });

  it("handles a zero-byte file (no write, but still unlinks)", () => {
    const target = path.join(root, "empty.pem");
    fs.writeFileSync(target, "", { mode: 0o600 });
    cleanupFile(target, root);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("runCleanup (end-to-end)", () => {
  let tmpDir: string;
  let root: string;
  let savedRunnerTemp: string | undefined;
  let savedGithubEnv: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-post-e2e-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    savedGithubEnv = process.env.GITHUB_ENV;
    process.env.RUNNER_TEMP = tmpDir;
    process.env.GITHUB_ENV = path.join(tmpDir, "github-env");
    fs.writeFileSync(process.env.GITHUB_ENV, "");
    root = path.join(tmpDir, "keycard-auth");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    warn = vi.spyOn(core, "warning").mockImplementation(() => {});
    info = vi.spyOn(core, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    if (savedGithubEnv === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = savedGithubEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeManifest(envNames: string[], filePaths: string[]): void {
    fs.writeFileSync(
      path.join(root, "cleanup-manifest.json"),
      JSON.stringify({ envNames, filePaths }),
      { mode: 0o600 },
    );
  }

  it("removes recorded files and the credentials root", async () => {
    const a = path.join(root, "a.pem");
    const b = path.join(root, "b.pem");
    fs.writeFileSync(a, "AA", { mode: 0o600 });
    fs.writeFileSync(b, "BB", { mode: 0o600 });
    writeManifest([], [a, b]);

    await runCleanup();

    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(root)).toBe(false);
  });

  it("clears recorded env vars (sets to empty and deletes from process.env)", async () => {
    process.env.FAKE_KEYCARD_VAR = "leaked-token";
    writeManifest(["FAKE_KEYCARD_VAR"], []);

    await runCleanup();

    expect(process.env.FAKE_KEYCARD_VAR).toBeUndefined();
  });

  it("warns but does not throw when a manifest path is outside root (M1)", async () => {
    // Tampered manifest pointing at a file outside root. Each bad path
    // generates a warning, the post step continues, and the root is removed.
    const outside = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(outside, "DO-NOT-TOUCH");
    writeManifest([], [outside, "/etc/passwd"]);

    await expect(runCleanup()).resolves.toBeUndefined();

    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe("DO-NOT-TOUCH");
    expect(warn).toHaveBeenCalled();
    const warnMessages = warn.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => /outside credentials root/.test(m))).toBe(true);
  });

  it("removes the credentials root even when no files were recorded", async () => {
    writeManifest([], []);
    await runCleanup();
    expect(fs.existsSync(root)).toBe(false);
  });

  it("is a no-op when no manifest exists (post called without main)", async () => {
    // No manifest file. runCleanup should not throw; root might or might not
    // exist depending on whether credentialsRoot() created it on read. It
    // *will* be created (then removed), so just assert no warnings about
    // unexpected paths.
    await expect(runCleanup()).resolves.toBeUndefined();
    expect(fs.existsSync(root)).toBe(false);
  });

  it("logs a summary count when work was done", async () => {
    const f = path.join(root, "one.pem");
    fs.writeFileSync(f, "X", { mode: 0o600 });
    writeManifest(["SOME_VAR"], [f]);
    await runCleanup();
    expect(info).toHaveBeenCalled();
    const infoMessages = info.mock.calls.map((c) => String(c[0]));
    expect(infoMessages.some((m) => /1 env var\(s\), removed 1 file\(s\)/.test(m))).toBe(true);
  });
});
