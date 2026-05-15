import * as core from "@actions/core";

/**
 * Mint a GitHub Actions OIDC JWT for the given audience.
 *
 * H4 mitigation — register the JWT as a secret immediately so it never
 * appears in logs. The OIDC token is the entire trust root; if it leaks
 * within its short lifetime, an attacker can exchange it for credentials
 * themselves.
 *
 * Requires `permissions: id-token: write` in the workflow.
 */
export async function getGithubOidcToken(audience: string): Promise<string> {
  const token = await core.getIDToken(audience);
  core.setSecret(token);
  return token;
}
