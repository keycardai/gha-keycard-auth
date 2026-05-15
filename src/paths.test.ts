import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { credentialsRoot, manifestPath, resolveSafeCredentialPath } from "./paths";

describe("paths", () => {
  let tmpDir: string;
  let savedRunnerTemp: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-paths-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = tmpDir;
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("credentialsRoot", () => {
    it("returns RUNNER_TEMP/keycard-auth and creates it with mode 0700", () => {
      const root = credentialsRoot();
      expect(root).toBe(path.join(tmpDir, "keycard-auth"));
      const stat = fs.statSync(root);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it("throws when RUNNER_TEMP is unset", () => {
      delete process.env.RUNNER_TEMP;
      expect(() => credentialsRoot()).toThrow(/RUNNER_TEMP/);
    });
  });

  describe("resolveSafeCredentialPath", () => {
    it("resolves relative paths inside the root", () => {
      const root = credentialsRoot();
      expect(resolveSafeCredentialPath("foo.pem", root)).toBe(
        path.join(root, "foo.pem"),
      );
      expect(resolveSafeCredentialPath("nested/foo.pem", root)).toBe(
        path.join(root, "nested/foo.pem"),
      );
    });

    it("rejects absolute paths outside the root (H3)", () => {
      const root = credentialsRoot();
      expect(() => resolveSafeCredentialPath("/etc/passwd", root)).toThrow(
        /escapes the credentials root/,
      );
    });

    it("rejects ../ traversal (H3)", () => {
      const root = credentialsRoot();
      expect(() =>
        resolveSafeCredentialPath("../../etc/passwd", root),
      ).toThrow(/escapes the credentials root/);
    });

    it("rejects the root itself", () => {
      const root = credentialsRoot();
      expect(() => resolveSafeCredentialPath(".", root)).toThrow(
        /not the root itself/,
      );
    });

    it("rejects paths whose parent dir is a symlink (M3)", () => {
      const root = credentialsRoot();
      const evilTarget = path.join(tmpDir, "outside");
      fs.mkdirSync(evilTarget);
      const symlink = path.join(root, "evil");
      fs.symlinkSync(evilTarget, symlink);
      expect(() =>
        resolveSafeCredentialPath("evil/secret.pem", root),
      ).toThrow(/traverses a symlink/);
    });
  });

  describe("manifestPath", () => {
    it("lives inside the credentials root", () => {
      expect(manifestPath()).toBe(
        path.join(tmpDir, "keycard-auth", "cleanup-manifest.json"),
      );
    });
  });
});
