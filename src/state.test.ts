import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readCleanupState,
  recordEnvForCleanup,
  recordFileForCleanup,
} from "./state";

describe("state (cleanup manifest)", () => {
  let tmpDir: string;
  let savedRunnerTemp: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-state-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = tmpDir;
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when no manifest exists", () => {
    expect(readCleanupState()).toEqual({ envNames: [], filePaths: [] });
  });

  it("records env names across calls", () => {
    recordEnvForCleanup("FLY_API_TOKEN");
    recordEnvForCleanup("EXAMPLE_API_KEY");
    const state = readCleanupState();
    expect(state.envNames).toEqual(["FLY_API_TOKEN", "EXAMPLE_API_KEY"]);
  });

  it("records file paths across calls", () => {
    recordFileForCleanup("/tmp/keycard-auth/a.pem");
    recordFileForCleanup("/tmp/keycard-auth/b.pem");
    expect(readCleanupState().filePaths).toEqual([
      "/tmp/keycard-auth/a.pem",
      "/tmp/keycard-auth/b.pem",
    ]);
  });

  it("manifest file is written with mode 0600 (M1)", () => {
    recordEnvForCleanup("FOO");
    const manifestFile = path.join(tmpDir, "keycard-auth", "cleanup-manifest.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    expect(fs.statSync(manifestFile).mode & 0o777).toBe(0o600);
  });

  it("returns empty on corrupted manifest (M1)", () => {
    // An attacker who can write into the credentials root can corrupt the
    // manifest, but cannot make us cleanup arbitrary paths — see post.ts.
    const manifestFile = path.join(tmpDir, "keycard-auth", "cleanup-manifest.json");
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, "not valid json {{");
    expect(readCleanupState()).toEqual({ envNames: [], filePaths: [] });
  });

  it("filters non-string entries from a tampered manifest (M1)", () => {
    const manifestFile = path.join(tmpDir, "keycard-auth", "cleanup-manifest.json");
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({
        envNames: ["VALID", 42, null, "ALSO_VALID"],
        filePaths: [{ path: "/etc/passwd" }, "/tmp/keycard-auth/x"],
      }),
    );
    expect(readCleanupState()).toEqual({
      envNames: ["VALID", "ALSO_VALID"],
      filePaths: ["/tmp/keycard-auth/x"],
    });
  });
});
