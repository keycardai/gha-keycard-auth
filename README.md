# gha-keycard-auth

[![Version](https://img.shields.io/github/v/tag/keycardai/gha-keycard-auth?label=version)](https://github.com/keycardai/gha-keycard-auth/tags)
[![CI](https://github.com/keycardai/gha-keycard-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/keycardai/gha-keycard-auth/actions/workflows/ci.yml)
[![CodeQL](https://github.com/keycardai/gha-keycard-auth/actions/workflows/codeql.yml/badge.svg)](https://github.com/keycardai/gha-keycard-auth/actions/workflows/codeql.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

GitHub Actions action that exchanges a workflow's OIDC token for credentials via Keycard STS.

[Keycard](https://keycard.ai) is an identity broker for non-human workloads — it issues short-lived, scoped credentials to a workflow (or service, or agent) based on the identity it can prove it has.

## Why

Workflows present their OIDC identity to Keycard and get back scoped credentials. No static secrets in repo settings, no `secrets: inherit` blast radius, audit per credential per run.

## Quickstart

> **Prerequisite:** a Keycard zone configured to trust GitHub's OIDC provider. See [Setup](#setup).

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: keycardai/gha-keycard-auth@<sha>
    with:
      zone-url: https://<id>.keycard.cloud
      credentials: |
        - resource: urn:fly:app:my-app:deploy-token
          type: env
          env-name: FLY_API_TOKEN
          scope: deploy:write
  - run: flyctl deploy
```

For credentials that need to be on disk (e.g. a PEM private key), use `type: file`:

```yaml
credentials: |
  - resource: urn:secret:gh-app-key
    type: file
    file-path: gh-app.pem      # resolved under $RUNNER_TEMP/keycard-auth/
    file-mode: "0400"          # must be quoted — see file-mode notes below
```

## Providers

Beyond raw env/file distribution, the action can broker credentials to specific downstream identity providers. A **provider** takes the Keycard zone JWT, performs the second-hop exchange with the downstream IdP (e.g. RFC 8693 token exchange to Pulumi), and exports the resulting credential into the workflow's environment. The workflow author writes one step; the Keycard zone controls the JWT's claims; the downstream's allow policy controls what the resulting credential can do.

**Supported providers:**

| Type | Downstream | Default output env var |
|---|---|---|
| `pulumi` | Pulumi Cloud (RFC 8693 to `/api/oauth/token`) | `PULUMI_ACCESS_TOKEN` |

### `pulumi`

```yaml
steps:
  - uses: keycardai/gha-keycard-auth@<sha>
    with:
      zone-url: https://<id>.keycard.cloud
      credentials: |
        - resource: urn:pulumi:org:keycardlabs
          type: pulumi
          pulumi:
            organization: keycardlabs
  - run: pulumi preview --stack acme/prod
```

| Field | Required | Notes |
|---|---|---|
| `pulumi.organization` | yes | Pulumi organization the issued token is scoped to. Becomes `audience=urn:pulumi:org:<org>` in the exchange request. |
| `pulumi.token-type` | no | `organization` (default), `team`, or `personal`. Maps to `urn:pulumi:token-type:access_token:<value>`. |
| `pulumi.cloud-url` | no | Pulumi API origin, default `https://api.pulumi.com`. Must be https; path is stripped. |

Downstream setup: register the Keycard zone as an OIDC issuer in Pulumi Cloud (Settings → Access Management → OIDC Issuers), and add an allow policy matching `aud=urn:pulumi:org:<org>` plus the `sub`/`client_id` claim shape Keycard mints for your workflows. This replaces `pulumi/auth-actions` in workflows that want credential issuance + audit flowing through Keycard.

### Adding a provider

Providers ship inside this action — there is no runtime plugin mechanism. See [CONTRIBUTING.md](./CONTRIBUTING.md#adding-a-provider) for the step-by-step.

## Inputs

| Input | Required | Description |
|---|---|---|
| `zone-url` | yes | Base URL of the Keycard zone. |
| `audience` | no | Audience for the GHA OIDC token. Accepts any string. Must equal the credential's `allowed_audience` for v2 credentials. When omitted, defaults to the zone issuer (`zone-url`, for example `https://<zone-id>.keycard.cloud`). |
| `client-id` | no | Client ID of a v2 workload identity credential. Omit for v1 credentials. Whitespace within the value is not allowed. |
| `credentials` | yes | YAML list of credential specs (see below). |

### Version 2 credentials

For a v2 workload identity credential, set `client-id` and an `audience` that
matches the credential's `allowed_audience`. The audience can be any string,
not just a Zone URL. If the credential uses the default Zone issuer audience,
omit `audience`. Leave `client-id` unset for v1 credentials.

```yaml
permissions:
  id-token: write
  contents: read

steps:
  - uses: keycardai/gha-keycard-auth@<sha>
    with:
      zone-url: https://<id>.keycard.cloud
      client-id: ${{ vars.KEYCARD_CLIENT_ID }}
      audience: https://github.com/acme-corp
      credentials: |
        - resource: urn:fly:app:my-app:deploy-token
          type: env
          env-name: FLY_API_TOKEN
```

### Credential spec

| Field | Required | Notes |
|---|---|---|
| `resource` | yes | Keycard resource URN. |
| `type` | yes | `env`, `file`, or a [provider type](#providers). |
| `scope` | no | OAuth scope to request on the resource. |
| `env-name` | when `type=env` | Env var to set. Must match `^[A-Z_][A-Z0-9_]*$` and is not allowed to be a reserved name (e.g. `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, anything starting with `GITHUB_`/`RUNNER_`/`ACTIONS_`/`INPUT_`). Providers also accept this field as an optional override of their default env var. |
| `file-path` | when `type=file` | Path on disk. Resolved against an action-managed directory under `$RUNNER_TEMP`; absolute paths and `..` traversal are rejected. |
| `file-mode` | no | Octal mode for `file`, default `0600`. **Must be a quoted string** (`"0600"`) — unquoted YAML coerces it to a decimal integer. Must be owner-only; group/world bits are rejected (so `0640`, `0644`, etc. fail). |
| `<provider>` | when `type=<provider>` | Provider-specific config block. See [Providers](#providers). |

## Setup

You need a Keycard zone with GitHub Actions configured as a trusted OIDC provider, plus an application and resource to authorize. See the [Keycard documentation](https://docs.keycard.ai) for the step-by-step (console and Terraform).

## Pinning

This is a `0.x` release line. The API may change between minor versions.
Use `@v0` to follow releases in the `0.x` line:

```yaml
uses: keycardai/gha-keycard-auth@v0
```

Pinning to the 40-character commit SHA of a `vX.Y.Z` tag is safer.
The code stays fixed until the pin changes:

```yaml
uses: keycardai/gha-keycard-auth@<40-char-sha>   # v0.1.0
```

[Dependabot](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/keeping-your-actions-up-to-date-with-dependabot)
uses the `# v0.1.0` comment to update the SHA when a new version tag lands.
Fetch tags, then run `git rev-parse 'v0.1.0^{commit}'` to resolve a tag's commit SHA.

A single release job installs Commitizen from a hash-locked requirements file.
Checkout does not persist credentials. Only Git push subprocesses receive the
App token. They disable hooks and use a controlled credential helper.
Commitizen runs without the token in its environment. This is not a sandbox.
Release tools share the job and can inspect parent processes.

## Contributing

External contributions welcome via forks and pull requests. See [CONTRIBUTING](./CONTRIBUTING.md). For vulnerabilities see [SECURITY](./SECURITY.md) — please do not file public issues for security reports.
