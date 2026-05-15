import { describe, expect, it, vi } from "vitest";
import { discoverTokenEndpoint } from "./discovery";

function makeFetch(
  status: number,
  body: unknown,
  url?: string,
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: url ?? "",
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("discoverTokenEndpoint", () => {
  it("returns the advertised token_endpoint when same-origin", async () => {
    const fetchImpl = makeFetch(200, {
      issuer: "https://zone.keycard.cloud",
      token_endpoint: "https://zone.keycard.cloud/oauth/2/token",
    });
    const result = await discoverTokenEndpoint(
      "https://zone.keycard.cloud",
      fetchImpl,
    );
    expect(result).toBe("https://zone.keycard.cloud/oauth/2/token");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://zone.keycard.cloud/.well-known/oauth-authorization-server",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = makeFetch(404, {});
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/discovery failed.*404/);
  });

  it("throws when token_endpoint is missing", async () => {
    const fetchImpl = makeFetch(200, { issuer: "https://zone.keycard.cloud" });
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/missing token_endpoint/);
  });

  it("rejects cross-origin token_endpoint (H1)", async () => {
    const fetchImpl = makeFetch(200, {
      issuer: "https://zone.keycard.cloud",
      token_endpoint: "https://attacker.example/steal",
    });
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/cross-origin token_endpoint/);
  });

  it("rejects token_endpoint on different port (H1)", async () => {
    const fetchImpl = makeFetch(200, {
      token_endpoint: "https://zone.keycard.cloud:9999/oauth/2/token",
    });
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/cross-origin token_endpoint/);
  });

  it("rejects http:// token_endpoint when zone is non-localhost (H1)", async () => {
    // The cross-origin check fires first because origins differ — but this
    // also documents the scheme guard for the localhost path.
    const fetchImpl = makeFetch(200, {
      token_endpoint: "http://zone.keycard.cloud/oauth/2/token",
    });
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/cross-origin|https/);
  });

  it("rejects malformed token_endpoint URL (H1)", async () => {
    const fetchImpl = makeFetch(200, {
      token_endpoint: "not-a-url",
    });
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/invalid token_endpoint/);
  });

  it("rejects cross-origin via fetch redirect (H1)", async () => {
    // fetch.url reflects the final URL after redirects; if the runtime
    // followed a redirect to a different origin, reject defensively.
    const fetchImpl = makeFetch(
      200,
      { token_endpoint: "https://zone.keycard.cloud/oauth/2/token" },
      "https://attacker.example/.well-known/oauth-authorization-server",
    );
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl),
    ).rejects.toThrow(/cross-origin response/);
  });

  it("aborts the request if it exceeds the timeout (H6)", async () => {
    // A hung discovery endpoint must not let the action burn runner minutes.
    // We pass a tiny timeout and a fetch that never resolves until aborted.
    const fetchImpl = vi.fn((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal!.reason ?? new Error("aborted"));
        });
      });
    }) as unknown as typeof fetch;
    await expect(
      discoverTokenEndpoint("https://zone.keycard.cloud", fetchImpl, 5),
    ).rejects.toThrow();
  });
});
