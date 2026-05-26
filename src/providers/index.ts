import { pulumiProvider, PULUMI_ENV_NAME_DEFAULT } from "./pulumi";
import type { Provider } from "./types";

/**
 * Registry of second-hop providers. Adding a provider means:
 *   1. Implement `Provider` in `./<name>.ts`.
 *   2. Add the export here.
 *
 * No types are introduced or widened — each provider validates and
 * narrows its own config internally. The dispatcher in main.ts has zero
 * per-provider knowledge.
 */
export const PROVIDERS: Record<string, Provider> = {
  pulumi: pulumiProvider,
};

/**
 * Default env-var names per provider, used when the workflow author
 * doesn't override via `env-name:`. Lives here (not in the provider
 * module) because it's a cross-cutting concern that inputs.ts needs at
 * parse time, before exchange runs.
 */
export const PROVIDER_DEFAULT_ENV_NAMES: Record<string, string> = {
  pulumi: PULUMI_ENV_NAME_DEFAULT,
};

export function isProviderType(t: string): boolean {
  return t in PROVIDERS;
}

export function getProvider(type: string): Provider {
  const p = PROVIDERS[type];
  if (!p) throw new Error(`Internal error: unknown provider type "${type}"`);
  return p;
}

export type { Provider, DistributeFn } from "./types";
