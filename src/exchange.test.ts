import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
import { exchangeForResource } from "./exchange";

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  }) as unknown as typeof fetch;
}

describe("exchangeForResource", () => {
  let setSecretSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setSecretSpy = vi.spyOn(core, "setSecret").mockImplementation(() => {});
  });

  afterEach(() => {
    setSecretSpy.mockRestore();
  });

  it("returns access_token on success", async () => {
    const fetchImpl = makeFetch(200, {
      access_token: "fly-deploy-token-value",
      token_type: "Bearer",
    });
    const token = await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "header.payload.sig",
      resource: "urn:fly:app:foo:deploy-token",
      fetchImpl,
    });
    expect(token).toBe("fly-deploy-token-value");
  });

  it("sends correct form body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ access_token: "x" }),
    });
    await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "OIDC_JWT",
      resource: "urn:fly:app:foo:deploy-token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(body.get("client_assertion")).toBe("OIDC_JWT");
    expect(body.get("resource")).toBe("urn:fly:app:foo:deploy-token");
    expect(body.get("scope")).toBeNull();
  });

  it("forwards scope when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ access_token: "x" }),
    });
    await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "OIDC_JWT",
      resource: "urn:fly:app:foo:deploy-token",
      scope: "deploy:write",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("scope")).toBe("deploy:write");
  });

  it("surfaces OAuth error details on failure", async () => {
    const fetchImpl = makeFetch(401, {
      error: "invalid_client",
      error_description: "No token application credential configured",
    });
    await expect(
      exchangeForResource({
        tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
        oidcToken: "x",
        resource: "urn:fly:app:foo:deploy-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid_client.*No token application credential/);
  });

  it("throws on non-JSON error body", async () => {
    const fetchImpl = makeFetch(502, "<html>bad gateway</html>");
    await expect(
      exchangeForResource({
        tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
        oidcToken: "x",
        resource: "urn:fly:app:foo:deploy-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it("throws when access_token is missing", async () => {
    const fetchImpl = makeFetch(200, { token_type: "Bearer" });
    await expect(
      exchangeForResource({
        tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
        oidcToken: "x",
        resource: "urn:fly:app:foo:deploy-token",
        fetchImpl,
      }),
    ).rejects.toThrow(/missing access_token/);
  });

  it("masks access_token on success (H5)", async () => {
    const fetchImpl = makeFetch(200, {
      access_token: "fly-deploy-token-value",
    });
    await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "x",
      resource: "urn:fly:app:foo:deploy-token",
      fetchImpl,
    });
    expect(setSecretSpy).toHaveBeenCalledWith("fly-deploy-token-value");
  });

  it("masks access_token even when STS returns 200 with both error and token (H5)", async () => {
    // Pathological: STS returns 200 with an `error` field AND an access_token.
    // We must mask the token before any error message is constructed.
    const fetchImpl = makeFetch(200, {
      error: "partial_failure",
      access_token: "leaked-token-material",
    });
    // 200 OK still goes through the success path; access_token is present.
    const token = await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "x",
      resource: "urn:fly:app:foo:deploy-token",
      fetchImpl,
    });
    expect(token).toBe("leaked-token-material");
    expect(setSecretSpy).toHaveBeenCalledWith("leaked-token-material");
  });

  it("masks credential-shaped fields in error response (H5)", async () => {
    // Defense in depth: STS returns 4xx with credential material echoed back.
    // We must mask before constructing the error message.
    const fetchImpl = makeFetch(400, {
      error: "invalid_request",
      error_description: "echoed bad client_assertion: header.payload.sig",
      access_token: "should-not-leak",
    });
    await expect(
      exchangeForResource({
        tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
        oidcToken: "x",
        resource: "urn:fly:app:foo:deploy-token",
        fetchImpl,
      }),
    ).rejects.toThrow();
    expect(setSecretSpy).toHaveBeenCalledWith("should-not-leak");
  });

  it("aborts the request if it exceeds the timeout (H6)", async () => {
    // Hung STS must not let the action consume runner minutes indefinitely.
    const fetchImpl = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal!.reason ?? new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    await expect(
      exchangeForResource({
        tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
        oidcToken: "x",
        resource: "urn:fly:app:foo:deploy-token",
        fetchImpl,
        timeoutMs: 5,
      }),
    ).rejects.toThrow();
  });

  it("does not mask clearly non-credential fields (H5)", async () => {
    const fetchImpl = makeFetch(200, {
      access_token: "real-token",
      expires_in: 3600,
      issuer: "https://zone.keycard.cloud",
      scope: "read",
    });
    await exchangeForResource({
      tokenEndpoint: "https://zone.keycard.cloud/oauth/2/token",
      oidcToken: "x",
      resource: "urn:fly:app:foo:deploy-token",
      fetchImpl,
    });
    expect(setSecretSpy).toHaveBeenCalledWith("real-token");
    // expires_in is a number; setSecret only fires on string values matching
    // sensitive keys (token/secret/key/assertion/password/credential). Issuer
    // and scope don't match the pattern, so they're not masked.
    expect(setSecretSpy).not.toHaveBeenCalledWith("https://zone.keycard.cloud");
    expect(setSecretSpy).not.toHaveBeenCalledWith("read");
  });
});
