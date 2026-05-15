import * as core from "@actions/core";
import * as yaml from "js-yaml";

export type CredentialSpec =
  | {
      resource: string;
      scope?: string;
      type: "env";
      envName: string;
    }
  | {
      resource: string;
      scope?: string;
      type: "file";
      filePath: string;
      fileMode: string;
    };

export interface Inputs {
  zoneUrl: string;
  audience: string;
  credentials: CredentialSpec[];
}

export function parseInputs(): Inputs {
  const zoneUrl = parseZoneUrl(required("zone-url"));
  const audience = parseAudience(core.getInput("audience").trim(), zoneUrl);
  const credentialsRaw = required("credentials");

  let parsed: unknown;
  try {
    parsed = yaml.load(credentialsRaw);
  } catch (err) {
    throw new Error(`credentials input is not valid YAML: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("credentials input must be a YAML list");
  }
  if (parsed.length === 0) {
    throw new Error(
      'credentials input must contain at least one entry. Example:\n' +
        '  credentials: |\n' +
        '    - resource: urn:example:resource\n' +
        '      type: env\n' +
        '      env-name: MY_TOKEN',
    );
  }

  const credentials = parsed.map((entry, i) => parseCredential(entry, i));

  return { zoneUrl, audience, credentials };
}

/**
 * L1 mitigation — parse zone-url through the URL parser, require https,
 * reject userinfo, return a normalized origin form (no trailing slash).
 *
 * Allowing http://localhost is intentional for local action development;
 * any other http:// is rejected.
 */
function parseZoneUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`zone-url is not a valid URL: ${raw}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("zone-url must not contain userinfo");
  }
  const isLocalhost =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocalhost)) {
    throw new Error(`zone-url must use https (got ${parsed.protocol})`);
  }
  // Strip trailing slash and any path; we always derive paths from the origin.
  const origin = `${parsed.protocol}//${parsed.host}`;
  const pathless = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return origin + pathless;
}

/**
 * H2 mitigation — if an explicit audience is provided, require it to share
 * the same origin as the zone URL. This prevents a workflow author from
 * minting a GHA OIDC token with an arbitrary audience and exfiltrating it.
 */
function parseAudience(raw: string, zoneUrl: string): string {
  if (!raw) return zoneUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`audience is not a valid URL: ${raw}`);
  }
  const zone = new URL(zoneUrl);
  if (parsed.origin !== zone.origin) {
    throw new Error(
      `audience must share origin with zone-url (audience=${parsed.origin}, zone=${zone.origin})`,
    );
  }
  return raw;
}

function parseCredential(entry: unknown, index: number): CredentialSpec {
  if (!isRecord(entry)) {
    throw new Error(`credentials[${index}] must be a mapping`);
  }
  const resource = stringField(entry, "resource", index);
  const type = stringField(entry, "type", index);
  const scope = optionalStringField(entry, "scope", index);

  switch (type) {
    case "env": {
      const envName = stringField(entry, "env-name", index);
      validateEnvName(envName, index);
      return { resource, scope, type: "env", envName };
    }
    case "file": {
      const filePath = stringField(entry, "file-path", index);
      const fileMode = parseFileMode(entry["file-mode"], index);
      return { resource, scope, type: "file", filePath, fileMode };
    }
    default:
      throw new Error(
        `credentials[${index}].type must be "env" or "file" (got "${type}")`,
      );
  }
}

/**
 * Reject env names that would let a workflow author hijack the runner's
 * execution environment. The most direct attack is `env-name: PATH` — that
 * silently replaces `$PATH` for every subsequent step, redirecting binary
 * lookups to attacker-controlled directories. Same shape applies to
 * NODE_OPTIONS (arbitrary code via --require), LD_PRELOAD (shared-object
 * injection), and the GHA/runner-controlled namespaces.
 *
 * We also enforce POSIX identifier syntax (^[A-Z_][A-Z0-9_]*$). The kernel
 * accepts lowercase, but mixed case in env vars is a footgun multiplier and
 * we want loud failures, not subtle ones.
 */
const ENV_NAME_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_ENV_PREFIXES = [
  "GITHUB_",
  "RUNNER_",
  "ACTIONS_",
  "INPUT_",
  // Bash exported function namespace ("Shellshock"-class). Setting any
  // BASH_FUNC_* env var redefines a shell function for every subsequent
  // bash invocation.
  "BASH_FUNC_",
];
const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "IFS",
  "PS1",
  "PS2",
  "PS4",
  "CDPATH",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  // JVM analog of NODE_OPTIONS — injects flags into every JVM launched in
  // subsequent steps.
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  // Redirects npm's binary install location, hijacking subsequent
  // `npm install -g` invocations.
  "NPM_CONFIG_PREFIX",
]);

/**
 * Parse a workflow-supplied `file-mode` field. The actual mode-bit validation
 * (owner-only, in-range, etc.) is done downstream in `parseMode`; this layer
 * only handles the YAML coercion footgun.
 *
 * YAML 1.2 / js-yaml parses `file-mode: 0600` as the **integer 600** and
 * `file-mode: 0o400` as the **integer 256**. That is not what the user
 * means — they mean octal modes — and silently accepting the coerced value
 * would either grant an unintended permission set or fall through to the
 * default. We reject numbers with an explicit "quote it" hint so users get
 * a one-line fix path rather than a confusing downstream error.
 */
function parseFileMode(raw: unknown, index: number): string {
  if (raw === undefined || raw === null) return "0600";
  if (typeof raw === "number") {
    throw new Error(
      `credentials[${index}].file-mode was parsed as the number ${raw}, ` +
        `not an octal mode string. YAML treats unquoted values like 0600 as ` +
        `decimal integers. Quote the value to keep it as a string ` +
        `(e.g. file-mode: "0600").`,
    );
  }
  if (typeof raw !== "string") {
    throw new Error(
      `credentials[${index}].file-mode must be a quoted octal string ` +
        `(e.g. "0600", "0400"); got ${typeof raw}.`,
    );
  }
  if (raw.length === 0) {
    throw new Error(
      `credentials[${index}].file-mode is empty. Omit the field to use the ` +
        `default of "0600", or set a quoted octal string.`,
    );
  }
  return raw;
}

function validateEnvName(name: string, index: number): void {
  if (!ENV_NAME_REGEX.test(name)) {
    throw new Error(
      `credentials[${index}].env-name must match ${ENV_NAME_REGEX.source} (got "${name}")`,
    );
  }
  for (const prefix of RESERVED_ENV_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new Error(
        `credentials[${index}].env-name "${name}" uses reserved prefix "${prefix}"`,
      );
    }
  }
  if (RESERVED_ENV_NAMES.has(name)) {
    throw new Error(
      `credentials[${index}].env-name "${name}" is reserved and cannot be overwritten`,
    );
  }
}

function required(name: string): string {
  const value = core.getInput(name).trim();
  if (!value) throw new Error(`input "${name}" is required`);
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringField(
  entry: Record<string, unknown>,
  key: string,
  index: number,
): string {
  const v = entry[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`credentials[${index}].${key} is required and must be a string`);
  }
  return v;
}

function optionalStringField(
  entry: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const v = entry[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`credentials[${index}].${key} must be a non-empty string when present`);
  }
  return v;
}
