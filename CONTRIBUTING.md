# Contributing to `gha-keycard-auth`

Thanks for considering a contribution. This action is on the credential-distribution
path for every workflow that uses it, so we hold the bar high on security,
clarity, and test coverage. The notes below are designed to keep PRs short and
the review loop quick.

## Reporting security issues

**Do not** open public issues for vulnerabilities. See [SECURITY.md](./SECURITY.md).

## Setting up the environment

You need:

- Node.js **24.x** (matches the `node24` action runtime).
- `npm` 10+.

```sh
git clone git@github.com:keycardai/gha-keycard-auth.git
cd gha-keycard-auth
npm install
```

Note: `package.json` sets `"private": true`. The action is distributed by
referencing the GitHub repo + SHA, not by publishing to npm, so the private
flag prevents accidental `npm publish` while keeping the repo public.

## Common commands

```sh
npm test          # vitest run — runs the full test suite
npm run test:watch
npm run typecheck # tsc --noEmit
npm run build     # bundles src/ into dist/ via @vercel/ncc
```

`npm run build` writes:

- `dist/index.js` — main entry, run on action start.
- `dist/post/index.js` — post-step cleanup entry.
- `dist/licenses.txt` — aggregated third-party licenses (bundled deps only).
- `dist/*.js.map` — source maps for stack traces.

## Repository layout

```
src/
  main.ts          # action entry: parses inputs, runs orchestrate()
  post.ts          # post-step entry: reads cleanup manifest, zeroes + unlinks files
  inputs.ts        # input parsing + URL/audience hardening
  discovery.ts     # OAuth Authorization Server Metadata discovery
  oidc.ts          # GitHub OIDC token minting
  exchange.ts      # RFC 7523 JWT-bearer client_credentials exchange against STS
  orchestrate.ts   # atomic two-phase exchange + apply
  paths.ts         # credentials root + safe-path resolution
  state.ts         # cleanup manifest read/write (0600 file inside credentials root)
  exporters/
    env.ts         # type: env  → core.exportVariable + setSecret
    file.ts        # type: file → O_NOFOLLOW write under credentials root
  providers/
    types.ts       # Provider interface (validate + exchange-returning-closure)
    index.ts       # PROVIDERS registry + lookup helpers
    pulumi.ts      # pulumi provider (Keycard JWT → Pulumi access token via RFC 8693)
  *.test.ts        # vitest unit tests, colocated with sources
dist/              # bundled output — committed, regenerated on every PR
action.yml         # action manifest (inputs, runtime)
```

## Modifying code

### `dist/` MUST stay in sync with `src/`

JavaScript GitHub Actions ship the bundled `dist/` at the SHA consumers pin to.
If you change `src/` without rebuilding, consumers will run stale code. Our CI
fails any PR where `git diff dist/` is non-empty after `npm run build`. Always
run `npm run build` and commit `dist/` in the same PR.

### Tests

Every code change needs a corresponding test. We use [vitest](https://vitest.dev/).

- **Pure logic / parsing** — direct unit tests (see `inputs.test.ts`).
- **Network calls** — pass a `fetchImpl` (see `discovery.test.ts`, `exchange.test.ts`).
- **Filesystem effects** — use a real `mkdtempSync` tmp dir and set
  `process.env.RUNNER_TEMP` to it (see `paths.test.ts`, `exporters/file.test.ts`).
- **Orchestration** — pass mock `OrchestrateDeps` (see `orchestrate.test.ts`).

Run the full suite before pushing:

```sh
npm run typecheck && npm test
```

### Adding a provider

A **provider** brokers credentials from the Keycard zone JWT to a downstream
identity provider (Pulumi, AWS, GCP, …) and distributes the resulting
credential into the workflow environment. Providers ship inside this action —
there is no runtime plugin mechanism. Adding one is a PR.

The contract (`src/providers/types.ts`) is intentionally narrow:

```ts
interface Provider {
  type: string;                                      // YAML `type:` value
  validate(config: unknown, index: number): void;    // parse-time validation
  exchange(args: {
    keycardJwt: string;
    config: Record<string, unknown>;
    envName?: string;
  }): Promise<() => void>;                           // returns the distribute closure
}
```

No type parameters. Each provider validates and narrows its own config
internally. The closure returned by `exchange` runs in `orchestrate.ts`
Phase 2 — invoke `core.exportVariable`, `exportFile`, whatever your
provider needs.

To add a new provider:

1. Create `src/providers/<name>.ts` implementing the `Provider` interface.
   Use `src/providers/pulumi.ts` as a template. Validation throws with
   `credentials[${index}].<name>.<field>`-shaped error messages so the
   workflow author sees which entry is bad.
2. Register it in `src/providers/index.ts`:
   ```ts
   import { newProvider } from "./<name>";
   export const PROVIDERS: Record<string, Provider> = {
     pulumi: pulumiProvider,
     <name>: newProvider,
   };
   ```
3. Add colocated tests (`src/providers/<name>.test.ts`). Network calls
   take a `fetchImpl` arg; env-export tests stub `GITHUB_ENV` to a tmp
   file (see `pulumi.test.ts`).
4. Update `README.md`'s providers table and add a `### <name>` subsection
   documenting the YAML config block and any downstream-side setup.
5. `npm run build` to refresh `dist/`.

No changes to `main.ts`, `inputs.ts`, `orchestrate.ts`, or `action.yml`
should be required. If you find yourself wanting to touch those, the
provider interface probably needs a discussion first — open an issue.

### Security-sensitive changes

Changes to any of the following must include explicit threat-model reasoning in
the PR description and updated mitigation comments in code:

- Anything that touches `core.setSecret` or where credential material flows.
- URL parsing or origin checks (`discovery.ts`, `inputs.ts`).
- Filesystem writes, mode bits, or path validation (`paths.ts`, `exporters/file.ts`).
- Cleanup-manifest read/write (`state.ts`, `post.ts`).

Open an issue first if you're unsure — happy to talk it through before you
write code.

## Style

- TypeScript strict mode is on. No `any`, no `@ts-ignore` without a justifying
  comment.
- We prefer small, side-effect-free modules with explicit dependency injection
  (`orchestrate.ts` is the model).
- Comments should explain **why** the code is shaped a certain way — especially
  for security defenses. The H1/H2/H3/H5/M1/M2/M3/L1 mitigation tags are
  load-bearing context for future maintainers; preserve and extend them.
- No emojis in source files unless explicitly requested.

## Commit and PR conventions

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- Keep PRs focused — one concern per PR makes review and bisect easier.
- The PR description should answer: **what changed**, **why**, **how it was
  tested**, and (for security-relevant changes) **what threat this addresses**.
- Update `CHANGELOG.md` under `## [Unreleased]` for any user-visible change.

## Releases

Releases are tagged from `main` after CI passes. The release workflow:

1. Bump version in `package.json` and `CHANGELOG.md`.
2. Tag the commit `v<MAJOR>.<MINOR>.<PATCH>`.
3. Publish a GitHub release with the changelog entry.
4. The release notes include the SHA consumers should pin to.

During the `0.x` line, only immutable release tags (`v0.1.0`, `v0.2.0`, …)
are published — no moving major or minor tags, since 0.x explicitly allows
breaking changes between minor versions. Consumers SHA-pin and Dependabot or
Renovate keeps the pin fresh.

## Questions

For general questions, open a [GitHub discussion](https://github.com/keycardai/gha-keycard-auth/discussions)
or email **support@keycard.ai**.
