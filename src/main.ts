import * as core from "@actions/core";
import { parseInputs, type CredentialSpec } from "./inputs";
import { discoverTokenEndpoint } from "./discovery";
import { getGithubOidcToken } from "./oidc";
import { exchangeForResource } from "./exchange";
import { exportEnv } from "./exporters/env";
import { exportFile } from "./exporters/file";
import { orchestrate } from "./orchestrate";

async function run(): Promise<void> {
  const inputs = parseInputs();
  await orchestrate(inputs, {
    discoverTokenEndpoint,
    getOidcToken: getGithubOidcToken,
    exchange: exchangeForResource,
    applyCredential,
    log: (message) => core.info(message),
  });
}

function applyCredential(spec: CredentialSpec, accessToken: string): void {
  switch (spec.type) {
    case "env":
      exportEnv(spec.envName, accessToken);
      return;
    case "file": {
      const written = exportFile(spec.filePath, spec.fileMode, accessToken);
      core.info(`wrote credential to ${written}`);
      return;
    }
  }
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  core.setFailed(message);
});
