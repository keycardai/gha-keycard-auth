import type { CredentialSpec, Inputs } from "./inputs";

/**
 * Pluggable seam between orchestration logic and side effects, so the
 * atomic-semantics behavior (M2) can be tested without hitting real
 * STS endpoints, real OIDC, or real env/disk.
 */
export interface OrchestrateDeps {
  discoverTokenEndpoint: (zoneUrl: string) => Promise<string>;
  getOidcToken: (audience: string) => Promise<string>;
  exchange: (args: {
    tokenEndpoint: string;
    oidcToken: string;
    resource: string;
    scope?: string;
  }) => Promise<string>;
  applyCredential: (spec: CredentialSpec, accessToken: string) => void;
  log: (message: string) => void;
}

/**
 * Orchestrates the full action: discover, mint, exchange (parallel),
 * then apply ONLY IF every exchange succeeded.
 *
 * M2 mitigation — exchange and apply are two separate phases. If any
 * single exchange fails, we throw without applying any credential, so
 * "failed" means "no side effects."
 */
export async function orchestrate(
  inputs: Inputs,
  deps: OrchestrateDeps,
): Promise<void> {
  const [tokenEndpoint, oidcToken] = await Promise.all([
    deps.discoverTokenEndpoint(inputs.zoneUrl),
    deps.getOidcToken(inputs.audience),
  ]);

  deps.log(
    `Exchanging OIDC token for ${inputs.credentials.length} credential(s) at ${tokenEndpoint}`,
  );

  // Phase 1: exchange all credentials in parallel.
  const results = await Promise.allSettled(
    inputs.credentials.map((spec) =>
      deps
        .exchange({
          tokenEndpoint,
          oidcToken,
          resource: spec.resource,
          scope: spec.scope,
        })
        .then((accessToken) => ({ spec, accessToken })),
    ),
  );

  const failures = results.flatMap((r) =>
    r.status === "rejected"
      ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} credential exchange(s) failed; no credentials were exported:\n  - ${failures.join("\n  - ")}`,
    );
  }

  // Phase 2: every exchange succeeded, safe to apply exporters.
  for (const result of results) {
    if (result.status === "fulfilled") {
      deps.applyCredential(result.value.spec, result.value.accessToken);
    }
  }

  deps.log(`Successfully fetched ${inputs.credentials.length} credential(s).`);
}
