import { describe, expect, it, vi } from "vitest";
import { orchestrate, type OrchestrateDeps, type ExchangeOutcome } from "./orchestrate";
import type { CredentialSpec, Inputs } from "./inputs";

const RAW: ExchangeOutcome = { kind: "raw", token: "ACCESS_TOKEN" };

function makeDeps(overrides: Partial<OrchestrateDeps> = {}): OrchestrateDeps {
  return {
    discoverTokenEndpoint: vi.fn().mockResolvedValue("https://zone.keycard.cloud/oauth/2/token"),
    getOidcToken: vi.fn().mockResolvedValue("OIDC_JWT"),
    exchange: vi.fn().mockResolvedValue(RAW),
    applyCredential: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

function inputs(creds: CredentialSpec[]): Inputs {
  return {
    zoneUrl: "https://zone.keycard.cloud",
    audience: "https://zone.keycard.cloud",
    credentials: creds,
  };
}

const envCred: CredentialSpec = {
  resource: "urn:fly:foo",
  type: "env",
  envName: "FLY_API_TOKEN",
};

const envCred2: CredentialSpec = {
  resource: "urn:example:second",
  type: "env",
  envName: "EXAMPLE_API_KEY",
};

const envCred3: CredentialSpec = {
  resource: "urn:other:thing",
  type: "env",
  envName: "OTHER",
};

describe("orchestrate", () => {
  it("applies all credentials when all exchanges succeed", async () => {
    const apply = vi.fn();
    const deps = makeDeps({ applyCredential: apply });
    await orchestrate(inputs([envCred, envCred2]), deps);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith(envCred, RAW);
    expect(apply).toHaveBeenCalledWith(envCred2, RAW);
  });

  it("applies NO credentials if ANY exchange fails (M2)", async () => {
    const apply = vi.fn();
    const exchange = vi.fn(async ({ resource }) => {
      if (resource === "urn:example:second") {
        throw new Error("invalid_client: not configured");
      }
      return RAW;
    });
    const deps = makeDeps({ exchange, applyCredential: apply });
    await expect(
      orchestrate(inputs([envCred, envCred2, envCred3]), deps),
    ).rejects.toThrow(/no credentials were exported/);
    expect(apply).not.toHaveBeenCalled();
  });

  it("aggregates multiple failure messages (M2)", async () => {
    const exchange = vi.fn(async ({ resource }) => {
      throw new Error(`exchange failed for ${resource}`);
    });
    const deps = makeDeps({ exchange, applyCredential: vi.fn() });
    let caught: Error | null = null;
    try {
      await orchestrate(inputs([envCred, envCred2]), deps);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/2 credential exchange\(s\) failed/);
    expect(caught!.message).toContain("urn:fly:foo");
    expect(caught!.message).toContain("urn:example:second");
  });

  it("runs exchanges in parallel (Phase 1)", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const exchange = vi.fn(async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return RAW;
    });
    const deps = makeDeps({ exchange });
    await orchestrate(inputs([envCred, envCred2, envCred3]), deps);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("does not call applyCredential before all exchanges resolve (M2)", async () => {
    const apply = vi.fn();
    let resolveSlowExchange: (value: ExchangeOutcome) => void = () => {};
    const exchange = vi.fn(async ({ resource }) => {
      if (resource === "urn:fly:foo") {
        return new Promise<ExchangeOutcome>((res) => {
          resolveSlowExchange = res;
        });
      }
      throw new Error("fast failure");
    });
    const deps = makeDeps({ exchange, applyCredential: apply });

    const promise = orchestrate(inputs([envCred, envCred2]), deps);
    // Yield so that the "fast failure" exchange resolves and Phase 1 can
    // observe it. Without atomic semantics, applyCredential might be called
    // for the slow one as soon as it resolves. With atomic semantics, we
    // wait for ALL phase-1 promises before applying any.
    await new Promise((r) => setTimeout(r, 10));
    resolveSlowExchange(RAW);

    await expect(promise).rejects.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });
});
