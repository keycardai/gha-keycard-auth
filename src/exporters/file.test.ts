import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exportFile } from "./file";

describe("exportFile", () => {
  let tmpDir: string;
  let savedRunnerTemp: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-test-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = tmpDir;
    // Stub out @actions/core's setSecret so it doesn't try to write to GHA env
    vi.spyOn(
      require("@actions/core"),
      "setSecret",
    ).mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function rootPath(): string {
    return path.join(tmpDir, "keycard-auth");
  }

  it("writes the value with the requested mode under the credentials root", () => {
    const written = exportFile("secret.pem", "0600", "PEM-CONTENT");
    expect(written).toBe(path.join(rootPath(), "secret.pem"));
    expect(fs.readFileSync(written, "utf8")).toBe("PEM-CONTENT");
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
  });

  it("creates nested parent dirs inside the credentials root", () => {
    const written = exportFile("nested/dir/secret.pem", "0600", "X");
    expect(written).toBe(path.join(rootPath(), "nested/dir/secret.pem"));
    expect(fs.readFileSync(written, "utf8")).toBe("X");
  });

  it("throws on bad mode strings rather than silently falling back", () => {
    expect(() => exportFile("bad-mode.txt", "not-a-mode", "X")).toThrow(
      /file-mode must be octal/,
    );
  });

  it("accepts 600 (without leading zero)", () => {
    const written = exportFile("no-prefix.txt", "600", "X");
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
  });

  it("accepts 0o600 (explicit prefix)", () => {
    const written = exportFile("with-prefix.txt", "0o600", "X");
    expect(fs.statSync(written).mode & 0o777).toBe(0o600);
  });

  it("accepts 0400 (read-only owner)", () => {
    const written = exportFile("ro.txt", "0400", "X");
    expect(fs.statSync(written).mode & 0o777).toBe(0o400);
  });

  it("rejects group-readable mode (0640)", () => {
    expect(() => exportFile("g-read.txt", "0640", "X")).toThrow(
      /group or world access/,
    );
  });

  it("rejects world-readable mode (0644)", () => {
    expect(() => exportFile("w-read.txt", "0644", "X")).toThrow(
      /group or world access/,
    );
  });

  it("rejects world-readable mode (0666)", () => {
    expect(() => exportFile("w-rw.txt", "0666", "X")).toThrow(
      /group or world access/,
    );
  });

  it("rejects fully-permissive mode (0777)", () => {
    expect(() => exportFile("full.txt", "0777", "X")).toThrow(
      /group or world access/,
    );
  });

  it("rejects empty mode string", () => {
    expect(() => exportFile("empty.txt", "", "X")).toThrow(
      /file-mode must be octal/,
    );
  });

  it("rejects mode containing non-octal digits", () => {
    expect(() => exportFile("nonoct.txt", "0800", "X")).toThrow(
      /file-mode must be octal/,
    );
  });

  it("rejects out-of-range mode", () => {
    expect(() => exportFile("oor.txt", "01000", "X")).toThrow(
      /file-mode out of range/,
    );
  });

  it("rejects absolute paths outside the credentials root (H3)", () => {
    expect(() => exportFile("/etc/passwd", "0600", "X")).toThrow(
      /escapes the credentials root/,
    );
  });

  it("rejects ../ traversal (H3)", () => {
    expect(() => exportFile("../../../etc/passwd", "0600", "X")).toThrow(
      /escapes the credentials root/,
    );
  });

  it("rejects writing into ~/.ssh (H3)", () => {
    const home = process.env.HOME || "/home/runner";
    expect(() =>
      exportFile(path.join(home, ".ssh/authorized_keys"), "0600", "X"),
    ).toThrow(/escapes the credentials root/);
  });

  it("rejects symlink in parent path (M3)", () => {
    // Pre-create the credentials root, then plant a symlink inside it that
    // points outside. exportFile must refuse rather than write through it.
    fs.mkdirSync(rootPath(), { recursive: true, mode: 0o700 });
    const evilTarget = path.join(tmpDir, "outside");
    fs.mkdirSync(evilTarget);
    const symlink = path.join(rootPath(), "evil");
    fs.symlinkSync(evilTarget, symlink);
    expect(() => exportFile("evil/secret.pem", "0600", "X")).toThrow(
      /traverses a symlink/,
    );
  });

  it("does not clobber an existing symlinked file via O_NOFOLLOW (M3)", () => {
    // Pre-create root and a file that's actually a symlink to /etc/hosts.
    // openSync with O_NOFOLLOW must fail with ELOOP, not write through.
    fs.mkdirSync(rootPath(), { recursive: true, mode: 0o700 });
    const target = path.join(tmpDir, "victim.txt");
    fs.writeFileSync(target, "ORIGINAL");
    const symlink = path.join(rootPath(), "secret.pem");
    fs.symlinkSync(target, symlink);
    expect(() => exportFile("secret.pem", "0600", "PWNED")).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("ORIGINAL");
  });

  it("refuses to clobber a pre-existing regular file at the target (O_EXCL)", () => {
    // The credentials root is wiped between runs, so a pre-existing file at
    // the target is suspicious — fail loud rather than silently overwriting.
    fs.mkdirSync(rootPath(), { recursive: true, mode: 0o700 });
    const existing = path.join(rootPath(), "secret.pem");
    fs.writeFileSync(existing, "ORIGINAL", { mode: 0o600 });
    expect(() => exportFile("secret.pem", "0600", "PWNED")).toThrow(/EEXIST/);
    expect(fs.readFileSync(existing, "utf8")).toBe("ORIGINAL");
  });

  it("masks each line of a multi-line credential (e.g. PEM)", () => {
    const setSecretSpy = vi.spyOn(require("@actions/core"), "setSecret");
    setSecretSpy.mockClear();
    const pem =
      "-----BEGIN PRIVATE KEY-----\nLINE2\nLINE3\n-----END PRIVATE KEY-----";
    exportFile("gh-app.pem", "0600", pem);
    const masked = setSecretSpy.mock.calls.map((c) => c[0]);
    expect(masked).toContain(pem);
    expect(masked).toContain("LINE2");
    expect(masked).toContain("LINE3");
  });
});
