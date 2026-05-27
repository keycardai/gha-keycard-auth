import * as core from "@actions/core";
import {
  parseInputs,
  type CredentialSpec,
  type Inputs,
  type ProviderCredentialSpec,
} from "./inputs";
import { discoverTokenEndpoint } from "./discovery";
import { getGithubOidcToken } from "./oidc";
import { exchangeForResource } from "./exchange";
import { exportEnv } from "./exporters/env";
import { exportFile } from "./exporters/file";
import { orchestrate, type ExchangeOutcome } from "./orchestrate";
import { getProvider, isProviderType } from "./providers";

/**
 * The CredentialSpec union has env/file literal-typed and
 * ProviderCredentialSpec.type as `string` (provider key, opaque to the
 * dispatcher). TS can't discriminate via the literal alone because
 * `string` overlaps the literals. These predicates do the narrowing
 * explicitly.
 */
function isProviderSpec(spec: CredentialSpec): spec is ProviderCredentialSpec {
  return isProviderType(spec.type) && spec.type !== "env" && spec.type !== "file";
}
function isEnvSpec(
  spec: CredentialSpec,
): spec is { resource: string; scope?: string; type: "env"; envName: string } {
  return spec.type === "env" && !isProviderSpec(spec);
}
function isFileSpec(
  spec: CredentialSpec,
): spec is {
  resource: string;
  scope?: string;
  type: "file";
  filePath: string;
  fileMode: string;
} {
  return spec.type === "file" && !isProviderSpec(spec);
}

async function run(): Promise<void> {
  // Parse inputs OUTSIDE the soft-fail wrapper. A malformed action
  // invocation (bad zone-url, missing credentials, etc.) is a workflow
  // author error, not a Keycard availability problem — failing loudly
  // is correct even when allow-failure would otherwise be in effect.
  // parseAllowFailure itself rejecting an invalid value (e.g. "yes")
  // also surfaces here, before the wrapper.
  const inputs = parseInputs();

  try {
    await orchestrate(inputs, {
      discoverTokenEndpoint,
      getOidcToken: getGithubOidcToken,
      exchange: makeExchange(inputs),
      applyCredential,
      log: (message) => core.info(message),
    });
  } catch (err) {
    if (!inputs.allowFailure) throw err;
    const message = err instanceof Error ? err.message : String(err);
    core.warning(
      `Keycard exchange failed; allow-failure is enabled so the step ` +
        `will succeed without exporting credentials. Downstream steps ` +
        `must detect missing credentials and route to a fallback. ` +
        `Underlying error: ${message}`,
    );
  }
}

/**
 * Wrap the base Keycard STS exchange so that provider-typed credentials
 * transparently chain into their downstream IdP's token endpoint. Provider
 * lookup is by string; this dispatcher has no per-provider knowledge.
 *
 * Keeping the second hop inside the exchange step preserves orchestrate.ts's
 * atomic semantics: a failure here aborts Phase 1 before any exporter runs.
 */
function makeExchange(inputs: Inputs) {
  const specByResource = new Map<string, CredentialSpec>();
  for (const spec of inputs.credentials) {
    specByResource.set(spec.resource, spec);
  }

  return async (args: {
    tokenEndpoint: string;
    oidcToken: string;
    resource: string;
    scope?: string;
  }): Promise<ExchangeOutcome> => {
    const keycardToken = await exchangeForResource(args);
    const spec = specByResource.get(args.resource);
    if (!spec || !isProviderSpec(spec)) {
      return { kind: "raw", token: keycardToken };
    }
    const provider = getProvider(spec.type);
    const distribute = await provider.exchange({
      keycardJwt: keycardToken,
      config: spec.config,
      envName: spec.envName,
    });
    return { kind: "bundle", providerType: spec.type, distribute };
  };
}

function applyCredential(spec: CredentialSpec, outcome: ExchangeOutcome): void {
  if (outcome.kind === "bundle") {
    outcome.distribute();
    return;
  }
  // Raw outcome — must be a primitive (env/file) variant; provider specs
  // produce bundle outcomes.
  if (isEnvSpec(spec)) {
    exportEnv(spec.envName, outcome.token);
    return;
  }
  if (isFileSpec(spec)) {
    const written = exportFile(spec.filePath, spec.fileMode, outcome.token);
    core.info(`wrote credential to ${written}`);
    return;
  }
  throw new Error(
    `Internal error: raw outcome for non-primitive spec type "${spec.type}"`,
  );
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
