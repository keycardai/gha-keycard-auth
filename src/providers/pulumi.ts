import * as core from "@actions/core";
import { exportEnv } from "../exporters/env";
import type { Provider, DistributeFn } from "./types";

/**
 * Internal — narrowed config shape after validation. Not exported; the
 * provider interface is generic over Record<string, unknown> and we
 * re-narrow at each entry point.
 */
interface PulumiConfig {
  organization: string;
  tokenType: string;
  cloudUrl: string;
}

const PULUMI_TOKEN_TYPE_PREFIX = "urn:pulumi:token-type:access_token:";
const ALLOWED_PULUMI_TOKEN_TYPES = new Set(["organization", "team", "personal"]);
const DEFAULT_PULUMI_CLOUD_URL = "https://api.pulumi.com";
const PULUMI_DEFAULT_ENV_NAME = "PULUMI_ACCESS_TOKEN";

/** Default for env-name when the workflow author doesn't override. */
export const PULUMI_ENV_NAME_DEFAULT = PULUMI_DEFAULT_ENV_NAME;

/** Default timeout for the Pulumi token-exchange POST; overridable for tests. */
export const PULUMI_EXCHANGE_TIMEOUT_MS = 10_000;

interface PulumiTokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
}

interface PulumiErrorResponse {
  error?: string;
  error_description?: string;
}

export const pulumiProvider: Provider = {
  type: "pulumi",

  validate(config, index) {
    // Throws on bad shape. Discards the parsed value — exchange() will
    // re-narrow. The duplication is intentional: validate runs at parse
    // time (no network), exchange runs in Phase 1; both must be safe in
    // isolation, and casts inside one shouldn't depend on the other.
    parseConfig(config, index);
  },

  async exchange({ keycardJwt, config, envName }) {
    const parsed = parseConfig(config, 0);
    const accessToken = await exchangeKeycardJwtForPulumiToken({
      cloudUrl: parsed.cloudUrl,
      organization: parsed.organization,
      tokenType: parsed.tokenType,
      keycardJwt,
    });
    const targetEnvName = envName ?? PULUMI_DEFAULT_ENV_NAME;
    const distribute: DistributeFn = () => {
      exportEnv(targetEnvName, accessToken);
    };
    return distribute;
  },
};

function parseConfig(raw: unknown, index: number): PulumiConfig {
  if (!isRecord(raw)) {
    throw new Error(
      `credentials[${index}].pulumi is required for type "pulumi" and must be a mapping (got ${typeof raw})`,
    );
  }
  const organization = requiredString(raw, "organization", index);
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(organization)) {
    throw new Error(
      `credentials[${index}].pulumi.organization "${organization}" is not a valid Pulumi organization name`,
    );
  }

  const rawTokenType = optionalString(raw, "token-type", index) ?? "organization";
  if (!ALLOWED_PULUMI_TOKEN_TYPES.has(rawTokenType)) {
    throw new Error(
      `credentials[${index}].pulumi.token-type must be one of ${[...ALLOWED_PULUMI_TOKEN_TYPES].join(", ")} (got "${rawTokenType}")`,
    );
  }
  const tokenType = `${PULUMI_TOKEN_TYPE_PREFIX}${rawTokenType}`;

  const cloudUrl = parseCloudUrl(
    optionalString(raw, "cloud-url", index) ?? DEFAULT_PULUMI_CLOUD_URL,
    index,
  );

  return { organization, tokenType, cloudUrl };
}

/**
 * RFC 8693 token exchange against Pulumi's /api/oauth/token, taking a
 * Keycard zone JWT (with aud=urn:pulumi:org:<org>) as subject_token.
 * Pulumi accepts a JSON body — see pulumi/actions-helpers oauth2.ts.
 *
 * H5 mitigation — proactively scan the parsed response for credential-shaped
 * fields before constructing any error message or returning. Protects against
 * misbehaving servers, intermediaries that echo material into error bodies,
 * and future maintainers who interpolate response text into error strings.
 *
 * Exported so direct callers (or future actor-token / chained flows) can
 * use the wire primitive without going through the Provider interface.
 */
export async function exchangeKeycardJwtForPulumiToken(args: {
  cloudUrl: string;
  organization: string;
  tokenType: string;
  keycardJwt: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? PULUMI_EXCHANGE_TIMEOUT_MS;

  const url = new URL("/api/oauth/token", args.cloudUrl).toString();
  const body = {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: `urn:pulumi:org:${args.organization}`,
    subject_token: args.keycardJwt,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: args.tokenType,
  };

  const resp = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Pulumi token exchange returned ${resp.status} with non-JSON body (org=${args.organization})`,
    );
  }

  maskCredentialFields(parsed);

  if (!resp.ok) {
    const err = parsed as PulumiErrorResponse;
    const code = typeof err.error === "string" ? err.error : "unknown_error";
    const desc =
      typeof err.error_description === "string"
        ? err.error_description
        : `HTTP ${resp.status}`;
    throw new Error(
      `Pulumi token exchange failed for org=${args.organization}: ${code} — ${desc}`,
    );
  }

  const ok = parsed as PulumiTokenResponse;
  if (!ok.access_token || typeof ok.access_token !== "string") {
    throw new Error(
      `Pulumi token exchange response missing access_token (org=${args.organization})`,
    );
  }
  return ok.access_token;
}

function parseCloudUrl(raw: string, index: number): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `credentials[${index}].pulumi.cloud-url is not a valid URL: ${raw}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      `credentials[${index}].pulumi.cloud-url must not contain userinfo`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `credentials[${index}].pulumi.cloud-url must use https (got ${parsed.protocol})`,
    );
  }
  return parsed.origin;
}

function requiredString(
  entry: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const v = entry[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `credentials[${index}].pulumi.${key} is required and must be a string`,
    );
  }
  return v;
}

function optionalString(
  entry: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `credentials[${index}].pulumi.${key} must be a non-empty string when present`,
    );
  }
  return v;
}

function maskCredentialFields(value: unknown): void {
  if (!isRecord(value)) return;
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
