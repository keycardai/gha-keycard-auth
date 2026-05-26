import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import {
  exchangeKeycardJwtForPulumiToken,
  pulumiProvider,
} from "./pulumi";

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe("exchangeKeycardJwtForPulumiToken", () => {
  let setSecretSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSecretSpy = vi.spyOn(core, "setSecret").mockImplementation(() => {});
  });

  afterEach(() => {
    setSecretSpy.mockRestore();
  });

  it("returns the Pulumi access_token on success", async () => {
    const fetchImpl = makeFetch(200, { access_token: "pul-xyz" });
    const token = await exchangeKeycardJwtForPulumiToken({
      cloudUrl: "https://api.pulumi.com",
      organization: "foobar",
      tokenType: "urn:pulumi:token-type:access_token:organization",
      keycardJwt: "kc.jwt.sig",
      fetchImpl,
    });
    expect(token).toBe("pul-xyz");
  });

  it("POSTs to <cloud-url>/api/oauth/token with the correct RFC 8693 body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ access_token: "x" }),
    });
    await exchangeKeycardJwtForPulumiToken({
      cloudUrl: "https://api.pulumi.com",
      organization: "foobar",
      tokenType: "urn:pulumi:token-type:access_token:organization",
      keycardJwt: "kc.jwt.sig",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe("https://api.pulumi.com/api/oauth/token");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: "urn:pulumi:org:foobar",
      subject_token: "kc.jwt.sig",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:pulumi:token-type:access_token:organization",
    });
  });

  it("respects a non-default cloud-url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ access_token: "x" }),
    });
    await exchangeKeycardJwtForPulumiToken({
      cloudUrl: "https://staging.pulumi.example",
      organization: "foobar",
      tokenType: "urn:pulumi:token-type:access_token:organization",
      keycardJwt: "kc.jwt.sig",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://staging.pulumi.example/api/oauth/token",
    );
  });

  it("masks access_token before returning (H5)", async () => {
    const fetchImpl = makeFetch(200, { access_token: "pul-xyz" });
    await exchangeKeycardJwtForPulumiToken({
      cloudUrl: "https://api.pulumi.com",
      organization: "foobar",
      tokenType: "urn:pulumi:token-type:access_token:organization",
      keycardJwt: "kc.jwt.sig",
      fetchImpl,
    });
    expect(setSecretSpy).toHaveBeenCalledWith("pul-xyz");
  });

  it("masks token-shaped fields even on error responses (H5)", async () => {
    const fetchImpl = makeFetch(400, {
      error: "invalid_grant",
      error_description: "bad subject_token",
      access_token: "leaked-token",
    });
    await expect(
      exchangeKeycardJwtForPulumiToken({
        cloudUrl: "https://api.pulumi.com",
        organization: "foobar",
        tokenType: "urn:pulumi:token-type:access_token:organization",
        keycardJwt: "kc.jwt.sig",
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(setSecretSpy).toHaveBeenCalledWith("leaked-token");
  });

  it("throws a structured error on 4xx", async () => {
    const fetchImpl = makeFetch(403, {
      error: "access_denied",
      error_description: "policy denied",
    });
    await expect(
      exchangeKeycardJwtForPulumiToken({
        cloudUrl: "https://api.pulumi.com",
        organization: "foobar",
        tokenType: "urn:pulumi:token-type:access_token:organization",
        keycardJwt: "kc.jwt.sig",
        fetchImpl,
      }),
    ).rejects.toThrow(/access_denied — policy denied/);
  });

  it("throws if response is not JSON", async () => {
    const fetchImpl = makeFetch(500, "<html>nginx error</html>");
    await expect(
      exchangeKeycardJwtForPulumiToken({
        cloudUrl: "https://api.pulumi.com",
        organization: "foobar",
        tokenType: "urn:pulumi:token-type:access_token:organization",
        keycardJwt: "kc.jwt.sig",
        fetchImpl,
      }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it("throws if response is missing access_token", async () => {
    const fetchImpl = makeFetch(200, { token_type: "Bearer" });
    await expect(
      exchangeKeycardJwtForPulumiToken({
        cloudUrl: "https://api.pulumi.com",
        organization: "foobar",
        tokenType: "urn:pulumi:token-type:access_token:organization",
        keycardJwt: "kc.jwt.sig",
        fetchImpl,
      }),
    ).rejects.toThrow(/missing access_token/);
  });
});

describe("pulumiProvider.validate", () => {
  it("accepts the minimal valid config", () => {
    expect(() =>
      pulumiProvider.validate({ organization: "foobar" }, 0),
    ).not.toThrow();
  });

  it("rejects missing block", () => {
    expect(() => pulumiProvider.validate(undefined, 0)).toThrow(
      /pulumi is required/,
    );
  });

  it("rejects missing organization", () => {
    expect(() => pulumiProvider.validate({}, 0)).toThrow(/organization/);
  });

  it("rejects invalid organization name", () => {
    expect(() =>
      pulumiProvider.validate({ organization: "NotValid" }, 0),
    ).toThrow(/not a valid Pulumi organization name/);
  });

  it("accepts token-type team", () => {
    expect(() =>
      pulumiProvider.validate(
        { organization: "foobar", "token-type": "team" },
        0,
      ),
    ).not.toThrow();
  });

  it("rejects unknown token-type", () => {
    expect(() =>
      pulumiProvider.validate(
        { organization: "foobar", "token-type": "bogus" },
        0,
      ),
    ).toThrow(/token-type must be one of/);
  });

  it("accepts cloud-url with a path (normalization happens in exchange)", () => {
    expect(() =>
      pulumiProvider.validate(
        {
          organization: "foobar",
          "cloud-url": "https://api.pulumi.com/some/path/",
        },
        0,
      ),
    ).not.toThrow();
  });

  it("rejects http:// cloud-url", () => {
    expect(() =>
      pulumiProvider.validate(
        { organization: "foobar", "cloud-url": "http://api.pulumi.com" },
        0,
      ),
    ).toThrow(/cloud-url must use https/);
  });
});

describe("pulumiProvider.exchange", () => {
  it("returns a distribute closure that exports the Pulumi token", async () => {
    const fetchImpl = makeFetch(200, { access_token: "pul-from-exchange" });
    vi.stubGlobal("fetch", fetchImpl);
    // exportEnv writes to $GITHUB_ENV; stub it to a temp path.
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-prov-"));
    const savedGithubEnv = process.env.GITHUB_ENV;
    const savedRunnerTemp = process.env.RUNNER_TEMP;
    const githubEnvFile = path.join(tmpDir, "github-env");
    fs.writeFileSync(githubEnvFile, "");
    process.env.GITHUB_ENV = githubEnvFile;
    process.env.RUNNER_TEMP = tmpDir;
    try {
      const distribute = await pulumiProvider.exchange({
        keycardJwt: "kc.jwt.sig",
        config: { organization: "foobar" },
      });
      expect(typeof distribute).toBe("function");
      // Token isn't exported until the closure runs.
      expect(process.env.PULUMI_ACCESS_TOKEN).toBeUndefined();
      distribute();
      expect(process.env.PULUMI_ACCESS_TOKEN).toBe("pul-from-exchange");
    } finally {
      delete process.env.PULUMI_ACCESS_TOKEN;
      if (savedGithubEnv === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = savedGithubEnv;
      if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = savedRunnerTemp;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it("honors envName override", async () => {
    const fetchImpl = makeFetch(200, { access_token: "pul-override" });
    vi.stubGlobal("fetch", fetchImpl);
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gha-keycard-prov-"));
    const savedGithubEnv = process.env.GITHUB_ENV;
    const savedRunnerTemp = process.env.RUNNER_TEMP;
    const githubEnvFile = path.join(tmpDir, "github-env");
    fs.writeFileSync(githubEnvFile, "");
    process.env.GITHUB_ENV = githubEnvFile;
    process.env.RUNNER_TEMP = tmpDir;
    try {
      const distribute = await pulumiProvider.exchange({
        keycardJwt: "kc.jwt.sig",
        config: { organization: "foobar" },
        envName: "MY_PULUMI_TOKEN",
      });
      distribute();
      expect(process.env.MY_PULUMI_TOKEN).toBe("pul-override");
      expect(process.env.PULUMI_ACCESS_TOKEN).toBeUndefined();
    } finally {
      delete process.env.MY_PULUMI_TOKEN;
      if (savedGithubEnv === undefined) delete process.env.GITHUB_ENV;
      else process.env.GITHUB_ENV = savedGithubEnv;
      if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = savedRunnerTemp;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});
