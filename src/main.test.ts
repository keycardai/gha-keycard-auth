import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";

const { values } = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock("@actions/core", () => ({
  getInput: vi.fn((name: string) => values[name] ?? ""),
  getIDToken: vi.fn().mockResolvedValue("OIDC_JWT"),
  setSecret: vi.fn(),
  info: vi.fn(),
  setFailed: vi.fn(),
}));
vi.mock("./exporters/env", () => ({ exportEnv: vi.fn() }));
vi.mock("./exporters/file", () => ({ exportFile: vi.fn() }));

describe("main", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    Object.assign(values, {
      "zone-url": "https://zone.keycard.cloud",
      credentials: "- resource: urn:pulumi:org:acme\n  type: pulumi\n  pulumi:\n    organization: acme",
    });
  });

  afterEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    vi.unstubAllGlobals();
  });

  it.each([
    ["", "https://github.com/acme-corp"],
    ["  client-123  ", "custom-audience"],
  ])("threads client-id %j and audience %j only to the appropriate endpoints", async (clientId, audience) => {
    values["client-id"] = clientId;
    values.audience = audience;
    const fetchImpl = vi.fn(async (url: string) => {
      const body = url.endsWith("/.well-known/oauth-authorization-server")
        ? { token_endpoint: "https://zone.keycard.cloud/oauth/2/token" }
        : { access_token: "ACCESS_TOKEN" };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    });
    vi.stubGlobal("fetch", fetchImpl);

    await import("./main");
    await vi.waitFor(() => {
      expect(core.info).toHaveBeenCalledWith("Successfully fetched 1 credential(s).");
    });
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.getIDToken).toHaveBeenCalledWith(audience);
    const requests = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const sts = requests.find(([url]) => url === "https://zone.keycard.cloud/oauth/2/token");
    expect(new URLSearchParams(sts![1].body as string).get("client_id")).toBe(clientId.trim() || null);
    const pulumi = requests.find(([url]) => url === "https://api.pulumi.com/api/oauth/token");
    expect(JSON.parse(pulumi![1].body as string)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: "urn:pulumi:org:acme",
      subject_token: "ACCESS_TOKEN",
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:pulumi:token-type:access_token:organization",
    });
  });
});
