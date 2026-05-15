import * as core from "@actions/core";

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

interface ErrorResponse {
  error: string;
  error_description?: string;
}

/** Default timeout for STS exchange; overridable for tests. */
export const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * OAuth 2.0 client-credentials grant against Keycard STS, presenting the
 * GHA OIDC token as a JWT bearer client assertion (RFC 7523) and requesting
 * a specific resource URN.
 *
 * H5 mitigation — proactively scan the parsed response for credential-shaped
 * fields and register them as secrets BEFORE constructing any error message
 * or returning. This protects against:
 *   - misbehaving STS that returns 200 with both error and access_token
 *   - intermediaries that echo request headers/bodies in error responses
 *   - future maintainers who interpolate response text into error messages
 *
 * The request is bounded by AbortSignal.timeout so a slow or hung STS cannot
 * make the action consume billable runner minutes.
 */
export async function exchangeForResource(args: {
  tokenEndpoint: string;
  oidcToken: string;
  resource: string;
  scope?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? EXCHANGE_TIMEOUT_MS;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: args.oidcToken,
    resource: args.resource,
  });
  if (args.scope) {
    body.set("scope", args.scope);
  }

  const resp = await fetchImpl(args.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `STS returned ${resp.status} with non-JSON body (resource=${args.resource})`,
    );
  }

  // Mask any credential-shaped strings before doing anything else with them.
  // This guards against unusual response shapes (errors with embedded tokens,
  // intermediaries that echo material into error_description, etc.).
  maskCredentialFields(parsed);

  if (!resp.ok) {
    const err = parsed as ErrorResponse;
    const code = typeof err.error === "string" ? err.error : "unknown_error";
    const desc =
      typeof err.error_description === "string"
        ? err.error_description
        : `HTTP ${resp.status}`;
    throw new Error(
      `STS exchange failed for ${args.resource}: ${code} — ${desc}`,
    );
  }

  const ok = parsed as TokenResponse;
  if (!ok.access_token || typeof ok.access_token !== "string") {
    throw new Error(
      `STS response missing access_token (resource=${args.resource})`,
    );
  }
  return ok.access_token;
}

/**
 * Walk a parsed JSON value (object or scalar) and call core.setSecret on
 * any string field whose key suggests it carries credential material.
 * Best-effort, one level deep — STS responses are flat per RFC 6749.
 */
function maskCredentialFields(value: unknown): void {
  if (!isRecord(value)) return;
  // The pattern is intentionally over-inclusive — false-positive masks (e.g.
  // matching a field named "token_endpoint") are harmless, missed masks are
  // not.
  const sensitiveKeyPattern = /token|secret|key|assertion|password|credential/i;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > 0 && sensitiveKeyPattern.test(k)) {
      core.setSecret(v);
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
