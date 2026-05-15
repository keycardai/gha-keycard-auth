import * as core from "@actions/core";
import { recordEnvForCleanup } from "../state";
import { maskSecret } from "../mask";

/**
 * Export a credential value as an environment variable available to subsequent
 * steps in the same job. Mask the value first so it never appears in logs,
 * and record the env name so the post step can unset it.
 */
export function exportEnv(name: string, value: string): void {
  maskSecret(value);
  core.exportVariable(name, value);
  recordEnvForCleanup(name);
}
