# Changelog

All notable changes to `gha-keycard-auth` will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is a 0.x release line — the API may change between minor versions per
[SemVer §4](https://semver.org/spec/v2.0.0.html#spec-item-4). Pin to a
40-character commit SHA for any non-experimental use
(`uses: keycardai/gha-keycard-auth@<sha> # v0.1.0`). Resolve the SHA for a
given release via its git tag, e.g. `git rev-parse v0.1.0`, or from the
GitHub release page.

## [Unreleased]

## [0.2.0] - 2026-05-19

### Changed

- Action runtime bumped from `node20` to `node24`. GitHub deprecated the
  Node.js 20 runtime; default runs flip to Node.js 24 on 2026-06-02 and the
  Node.js 20 runner is removed on 2026-09-16. Self-hosted runners must have
  Node.js 24 available before pinning to a SHA at or past this release.

### Internal

Contributor-visible only — no impact on consumers pinning by SHA.

- CI: bump pinned `actions/checkout` 4.2.2 → 6.0.2 and
  `actions/setup-node` 4.1.0 → 6.4.0 (Dependabot, #1, #3).
- CodeQL workflow: bump pinned `github/codeql-action` 3.35.5 → 4.35.5
  (Dependabot, #2).
- Add `.github/CODEOWNERS` requiring review from `@keycardai/engineering`
  (#4).

## [0.1.0] - 2026-05-15

First public release.

### Added

- OAuth 2.0 Authorization Server Metadata discovery (RFC 8414) against the
  configured Keycard zone (`/.well-known/oauth-authorization-server`), with
  cross-origin and scheme hardening on the discovered `token_endpoint`.
- GitHub Actions OIDC token minting via `@actions/core.getIDToken`, with the
  audience defaulting to the zone URL and an optional same-origin override.
- JWT-bearer client-assertion exchange against the Keycard STS
  `token_endpoint` (RFC 6749 client_credentials grant, RFC 7521/7523 assertion
  framing, RFC 8707 resource indicator), requesting per-credential
  `resource` URNs and optional OAuth `scope`.
- Two credential exporters:
  - `type: env` - sets an env var available to subsequent steps, masked via
    `core.setSecret` per-line so multi-line values (e.g. PEM keys) are
    redacted in their entirety. `env-name` is validated against POSIX syntax
    and a reject-list of reserved names that would hijack subsequent steps
    (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `JAVA_TOOL_OPTIONS`, the bash
    function namespace `BASH_FUNC_*`, the GHA/runner-controlled prefixes
    `GITHUB_*`, `RUNNER_*`, `ACTIONS_*`, `INPUT_*`, and others).
  - `type: file` - writes the credential to a file under
    `$RUNNER_TEMP/keycard-auth/` with an owner-only mode (group/world bits
    rejected), `O_NOFOLLOW | O_EXCL` to refuse following symlinks and refuse
    to clobber pre-existing files at the target, and post-step
    zero-overwrite + unlink.
- Atomic apply semantics: if any credential exchange fails, no credentials are
  exported (`orchestrate.ts`).
- Post-step cleanup driven by a `0600` manifest file inside the credentials
  root (not `core.saveState`), so a malicious intermediate step cannot direct
  cleanup to arbitrary paths. The post step independently re-validates every
  manifest entry against the credentials root.
- Secret masking for credential-shaped fields in STS responses before any
  error message is constructed.
- 10-second request timeout on discovery and exchange (`AbortSignal.timeout`).

### Security

Inline mitigation comments in `src/` document the threats this action
defends against. CodeQL analysis runs on push, PR, and weekly. Vulnerability
reports: security@keycard.ai (see `SECURITY.md`).

[Unreleased]: https://github.com/keycardai/gha-keycard-auth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/keycardai/gha-keycard-auth/releases/tag/v0.1.0
