import * as core from "@actions/core";

/**
 * Register a secret value with GitHub Actions so it is redacted from logs.
 *
 * GHA's `::add-mask::` workflow command masks values on a per-line basis:
 * a multi-line secret registered as a single blob is only redacted on the
 * line that exactly matches the full blob, which in practice means lines
 * 2..N of a PEM key, JSON web key, or similar leak verbatim if any later
 * step prints the value (e.g. `cat $RUNNER_TEMP/keycard-auth/foo.pem`).
 *
 * We work around this by registering each non-empty line as its own mask,
 * in addition to the whole value. Anything `core.setSecret` would have
 * masked is still masked; anything it would have missed (lines 2..N) is
 * now masked too.
 */
export function maskSecret(value: string): void {
  if (!value) return;
  core.setSecret(value);
  // Split on CR, LF, or CRLF. setSecret on the empty string is a no-op in
  // GHA, but we filter empties anyway to avoid noise.
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.length <= 1) return;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    core.setSecret(line);
  }
}
