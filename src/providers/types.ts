/**
 * Contract for "second-hop" credential providers — those that take a Keycard
 * zone JWT and exchange it (via RFC 8693, AWS STS, GCP Workload Identity,
 * etc.) for a downstream credential, then distribute that credential into
 * the workflow's environment.
 *
 * Three responsibilities, each with a clear failure window:
 *
 *   validate — pure validation of the YAML `<provider>:` block at parse time.
 *              Throws on invalid input. No network IO.
 *
 *   exchange — network IO with the downstream IdP. Returns a "distribute"
 *              closure that, when invoked, writes the resulting credential
 *              into the workflow environment. Throws on exchange failure.
 *              Runs in orchestrate.ts Phase 1, so a failure aborts before
 *              any exporter runs (atomic-apply guarantee).
 *
 *   The closure itself runs in Phase 2 after every other Phase 1 call has
 *   succeeded. It does the env-var exports / file writes.
 *
 * The interface has no type parameters. Each provider validates +
 * narrows its own config internally and owns the closure's captured
 * state. The dispatcher (main.ts) has zero per-provider knowledge.
 */
export interface Provider {
  /** YAML `type:` value that selects this provider (e.g. "pulumi"). */
  readonly type: string;

  /**
   * Validate the provider-specific YAML block at parse time. Throws an
   * error with a `credentials[${index}].${provider-type}.<field>` shaped
   * message on invalid input.
   */
  validate(config: unknown, index: number): void;

  /**
   * Perform the second-hop exchange. Returns the closure that distributes
   * the resulting credential into the workflow environment. The closure
   * captures whatever typed state the provider needs internally.
   *
   * `envName` is the optional cross-cutting env-var override from the
   * outer credential spec. Providers that distribute to a single env var
   * honor it; others may ignore it.
   */
  exchange(args: {
    keycardJwt: string;
    config: Record<string, unknown>;
    envName?: string;
  }): Promise<DistributeFn>;
}

/**
 * Distribute the exchanged credential into the workflow environment.
 * Sync — runs in orchestrate Phase 2, must not throw under normal
 * conditions (validation should have caught bad inputs already).
 */
export type DistributeFn = () => void;
