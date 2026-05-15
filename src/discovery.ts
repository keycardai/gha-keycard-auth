interface AuthorizationServerMetadata {
  token_endpoint: string;
  issuer?: string;
}

/** Default timeout for discovery; overridable for tests. */
export const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Fetch the OAuth 2.0 Authorization Server Metadata for the given Keycard zone
 * and return the token_endpoint.
 *
 * H1 mitigation — the discovered token_endpoint MUST share an origin with the
 * zone URL. Without this, a malicious or compromised discovery response could
 * redirect the OIDC token POST to an attacker-controlled host.
 *
 * Redirects are disabled (`redirect: "manual"`); if the discovery endpoint
 * tries to redirect us elsewhere, we treat that as a failure.
 *
 * The request is bounded by AbortSignal.timeout so a slow or hung STS cannot
 * make the action consume billable runner minutes.
 */
export async function discoverTokenEndpoint(
  zoneUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<string> {
  const zoneOrigin = new URL(zoneUrl).origin;
  const url = `${zoneUrl}/.well-known/oauth-authorization-server`;
  const resp = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(
      `OAuth discovery failed: ${resp.status} ${resp.statusText} from ${url}`,
    );
  }
  // Defense-in-depth: reject if fetch silently followed a cross-origin redirect.
  if (resp.url && new URL(resp.url).origin !== zoneOrigin) {
    throw new Error(
      `OAuth discovery returned cross-origin response (${resp.url} vs zone ${zoneOrigin})`,
    );
  }
  const body = (await resp.json()) as AuthorizationServerMetadata;
  if (!body.token_endpoint || typeof body.token_endpoint !== "string") {
    throw new Error(
      `OAuth discovery response missing token_endpoint (from ${url})`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(body.token_endpoint);
  } catch {
    throw new Error(
      `OAuth discovery returned invalid token_endpoint URL: ${body.token_endpoint}`,
    );
  }
  if (endpoint.origin !== zoneOrigin) {
    throw new Error(
      `OAuth discovery returned cross-origin token_endpoint (endpoint=${endpoint.origin}, zone=${zoneOrigin})`,
    );
  }
  if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
    throw new Error(
      `token_endpoint must use https (got ${endpoint.protocol})`,
    );
  }
  return endpoint.toString();
}
