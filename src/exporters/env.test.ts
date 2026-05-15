import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as core from "@actions/core";
import { exportEnv } from "./env";

describe("exportEnv", () => {
  let tmpDir: string;
  let savedRunnerTemp: string | undefined;
  let savedGithubEnv: string | undefined;
  let githubEnvFile: string;
  let setSecret: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-env-"));
    savedRunnerTemp = process.env.RUNNER_TEMP;
    savedGithubEnv = process.env.GITHUB_ENV;
    process.env.RUNNER_TEMP = tmpDir;
    // `core.exportVariable` writes to $GITHUB_ENV; point it at a temp file so
    // the test does not depend on the GHA environment.
    githubEnvFile = path.join(tmpDir, "github-env");
    fs.writeFileSync(githubEnvFile, "");
    process.env.GITHUB_ENV = githubEnvFile;
    setSecret = vi.spyOn(core, "setSecret").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
    if (savedGithubEnv === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = savedGithubEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("masks the value and exports it", () => {
    exportEnv("FLY_API_TOKEN", "secret-value");
    expect(setSecret).toHaveBeenCalledWith("secret-value");
    expect(process.env.FLY_API_TOKEN).toBe("secret-value");
  });

  it("masks every line of a multi-line value (so logs in subsequent steps don't leak lines 2..N)", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nLINE2\nLINE3\n-----END PRIVATE KEY-----";
    exportEnv("GH_APP_KEY", pem);
    const masked = setSecret.mock.calls.map((c) => c[0]);
    expect(masked).toContain(pem);
    expect(masked).toContain("-----BEGIN PRIVATE KEY-----");
    expect(masked).toContain("LINE2");
    expect(masked).toContain("LINE3");
    expect(masked).toContain("-----END PRIVATE KEY-----");
  });

  it("records the env name in the cleanup manifest for the post step", () => {
    exportEnv("FLY_API_TOKEN", "secret-value");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "keycard-auth", "cleanup-manifest.json"), "utf8"),
    );
    expect(manifest.envNames).toContain("FLY_API_TOKEN");
  });
});
