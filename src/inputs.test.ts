import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { parseInputs } from "./inputs";

function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] = value;
}

function clearInput(name: string): void {
  delete process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
}

describe("parseInputs", () => {
  beforeEach(() => {
    clearInput("zone-url");
    clearInput("audience");
    clearInput("credentials");
    clearInput("allow-failure");
  });

  afterEach(() => {
    clearInput("zone-url");
    clearInput("audience");
    clearInput("credentials");
    clearInput("allow-failure");
  });

  it("parses env credential", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    const inputs = parseInputs();
    expect(inputs.zoneUrl).toBe("https://zone.keycard.cloud");
    expect(inputs.audience).toBe("https://zone.keycard.cloud");
    expect(inputs.credentials).toEqual([
      { resource: "urn:fly:app:foo:deploy-token", type: "env", envName: "FLY_API_TOKEN" },
    ]);
  });

  it("parses file credential with default mode", () => {
    setInput("zone-url", "https://zone.keycard.cloud/");
    setInput(
      "credentials",
      `
- resource: urn:secret:gh-app-key
  type: file
  file-path: /tmp/gh-app.pem
`,
    );
    const inputs = parseInputs();
    expect(inputs.zoneUrl).toBe("https://zone.keycard.cloud");
    expect(inputs.credentials).toEqual([
      {
        resource: "urn:secret:gh-app-key",
        type: "file",
        filePath: "/tmp/gh-app.pem",
        fileMode: "0600",
      },
    ]);
  });

  it("accepts same-origin audience override", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput("audience", "https://zone.keycard.cloud/custom");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(parseInputs().audience).toBe("https://zone.keycard.cloud/custom");
  });

  it("rejects cross-origin audience (H2)", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput("audience", "https://attacker.example");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(() => parseInputs()).toThrow(/audience must share origin/);
  });

  it("rejects http:// zone-url (L1)", () => {
    setInput("zone-url", "http://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(() => parseInputs()).toThrow(/must use https/);
  });

  it("allows http://localhost for dev (L1)", () => {
    setInput("zone-url", "http://localhost:8080");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(parseInputs().zoneUrl).toBe("http://localhost:8080");
  });

  it("rejects zone-url with userinfo (L1)", () => {
    setInput("zone-url", "https://attacker:pass@zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(() => parseInputs()).toThrow(/userinfo/);
  });

  it("rejects malformed zone-url (L1)", () => {
    setInput("zone-url", "not a url");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(() => parseInputs()).toThrow(/valid URL/);
  });

  it("rejects missing zone-url", () => {
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
    );
    expect(() => parseInputs()).toThrow(/zone-url/);
  });

  it("rejects unknown type", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: bogus
  env-name: FOO
`,
    );
    expect(() => parseInputs()).toThrow(/type/);
  });

  describe("type: pulumi", () => {
    it("parses with default env-name PULUMI_ACCESS_TOKEN and default token-type", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  pulumi:
    organization: foobar
`,
      );
      const [cred] = parseInputs().credentials;
      // Provider-typed creds carry the raw config block; the provider
      // re-narrows it at exchange time. envName is undefined when the
      // workflow author doesn't override; the provider supplies its own
      // default during exchange.
      expect(cred).toEqual({
        resource: "urn:pulumi:org:foobar",
        scope: undefined,
        type: "pulumi",
        envName: undefined,
        config: {
          organization: "foobar",
        },
      });
    });

    it("allows env-name override", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  env-name: PULUMI_TOKEN_STAGING
  pulumi:
    organization: foobar
`,
      );
      const [cred] = parseInputs().credentials;
      expect(cred.type).toBe("pulumi");
      if (cred.type === "pulumi") {
        expect(cred.envName).toBe("PULUMI_TOKEN_STAGING");
      }
    });

    it("applies env-name reserved-name validation to overrides", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  env-name: PATH
  pulumi:
    organization: foobar
`,
      );
      expect(() => parseInputs()).toThrow(/reserved/);
    });

    it("rejects file-path on type: pulumi", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  file-path: /tmp/pulumi-token
  pulumi:
    organization: foobar
`,
      );
      expect(() => parseInputs()).toThrow(/file-path is not valid for type "pulumi"/);
    });

    it("rejects file-mode on type: pulumi", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  file-mode: "0600"
  pulumi:
    organization: foobar
`,
      );
      expect(() => parseInputs()).toThrow(/file-mode is not valid for type "pulumi"/);
    });

    it("supports scope on type: pulumi", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  scope: org:read
  pulumi:
    organization: foobar
`,
      );
      const [cred] = parseInputs().credentials;
      expect(cred.scope).toBe("org:read");
    });

    it("rejects missing pulumi block", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
`,
      );
      expect(() => parseInputs()).toThrow(/pulumi is required/);
    });

    it("rejects missing pulumi.organization", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  pulumi: {}
`,
      );
      expect(() => parseInputs()).toThrow(/organization/);
    });

    it("rejects invalid pulumi.organization name", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  pulumi:
    organization: NotValid
`,
      );
      expect(() => parseInputs()).toThrow(/not a valid Pulumi organization name/);
    });

    it("rejects unknown token-type at parse time (via provider.validate)", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  pulumi:
    organization: foobar
    token-type: bogus
`,
      );
      expect(() => parseInputs()).toThrow(/token-type must be one of/);
    });

    it("rejects http:// pulumi.cloud-url", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:pulumi:org:foobar
  type: pulumi
  pulumi:
    organization: foobar
    cloud-url: http://api.pulumi.com
`,
      );
      expect(() => parseInputs()).toThrow(/cloud-url must use https/);
    });
  });

  it("rejects env type without env-name", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
`,
    );
    expect(() => parseInputs()).toThrow(/env-name/);
  });

  it("rejects non-list credentials", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput("credentials", "not-a-list");
    expect(() => parseInputs()).toThrow(/list/);
  });

  it("rejects empty credentials list with an actionable error", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput("credentials", "[]");
    expect(() => parseInputs()).toThrow(/at least one entry/);
  });

  // YAML 1.2 / js-yaml parses `file-mode: 0600` as the integer 600 and
  // `file-mode: 0o400` as the integer 256. Silently falling back to the
  // default mode or downstream-converting could grant unintended access.
  // We require the user to quote the value.
  describe("file-mode YAML coercion", () => {
    it("rejects numeric file-mode (unquoted 0600 becomes integer 600 in YAML)", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:secret:gh-app-key
  type: file
  file-path: gh-app.pem
  file-mode: 0600
`,
      );
      expect(() => parseInputs()).toThrow(/was parsed as the number/);
      expect(() => parseInputs()).toThrow(/Quote the value/);
    });

    it("rejects numeric file-mode (unquoted 0o400 becomes integer 256 in YAML)", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:secret:gh-app-key
  type: file
  file-path: gh-app.pem
  file-mode: 0o400
`,
      );
      expect(() => parseInputs()).toThrow(/was parsed as the number 256/);
    });

    it('accepts quoted file-mode "0400"', () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:secret:gh-app-key
  type: file
  file-path: gh-app.pem
  file-mode: "0400"
`,
      );
      const [cred] = parseInputs().credentials;
      expect(cred.type).toBe("file");
      if (cred.type === "file") {
        expect(cred.fileMode).toBe("0400");
      }
    });

    it("defaults file-mode to 0600 when omitted", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:secret:gh-app-key
  type: file
  file-path: gh-app.pem
`,
      );
      const [cred] = parseInputs().credentials;
      if (cred.type === "file") {
        expect(cred.fileMode).toBe("0600");
      }
    });

    it("rejects empty-string file-mode with a clear hint", () => {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:secret:gh-app-key
  type: file
  file-path: gh-app.pem
  file-mode: ""
`,
      );
      expect(() => parseInputs()).toThrow(/file-mode is empty/);
    });
  });

  it("parses optional scope on credential", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
  scope: deploy:write
`,
    );
    const [cred] = parseInputs().credentials;
    expect(cred.scope).toBe("deploy:write");
  });

  it("rejects empty scope value", () => {
    setInput("zone-url", "https://zone.keycard.cloud");
    setInput(
      "credentials",
      `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
  scope: ""
`,
    );
    expect(() => parseInputs()).toThrow(/scope/);
  });

  // env-name hardening: a workflow author setting env-name to PATH or
  // NODE_OPTIONS could hijack subsequent steps. Validated at parse so the
  // action fails before fetching any credential.
  describe("env-name validation", () => {
    function withEnvName(envName: string): () => unknown {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: ${envName}
`,
      );
      return parseInputs;
    }

    it("rejects PATH (runner execution hijack)", () => {
      expect(withEnvName("PATH")).toThrow(/reserved/);
    });

    it("rejects NODE_OPTIONS (arbitrary Node code via --require)", () => {
      expect(withEnvName("NODE_OPTIONS")).toThrow(/reserved/);
    });

    it("rejects LD_PRELOAD (shared-object injection on Linux)", () => {
      expect(withEnvName("LD_PRELOAD")).toThrow(/reserved/);
    });

    it("rejects DYLD_INSERT_LIBRARIES (dyld injection on macOS)", () => {
      expect(withEnvName("DYLD_INSERT_LIBRARIES")).toThrow(/reserved/);
    });

    it("rejects GITHUB_TOKEN (GHA-controlled namespace)", () => {
      expect(withEnvName("GITHUB_TOKEN")).toThrow(/reserved prefix "GITHUB_"/);
    });

    it("rejects RUNNER_TEMP (runner-controlled namespace)", () => {
      expect(withEnvName("RUNNER_TEMP")).toThrow(/reserved prefix "RUNNER_"/);
    });

    it("rejects ACTIONS_RUNTIME_TOKEN (actions-controlled namespace)", () => {
      expect(withEnvName("ACTIONS_RUNTIME_TOKEN")).toThrow(
        /reserved prefix "ACTIONS_"/,
      );
    });

    it("rejects INPUT_FOO (would shadow another action's input)", () => {
      expect(withEnvName("INPUT_ZONE_URL")).toThrow(/reserved prefix "INPUT_"/);
    });

    it("rejects BASH_FUNC_XYZ (Shellshock-style function injection)", () => {
      expect(withEnvName("BASH_FUNC_FOO")).toThrow(/reserved prefix "BASH_FUNC_"/);
    });

    it("rejects JAVA_TOOL_OPTIONS (JVM-wide flag injection)", () => {
      expect(withEnvName("JAVA_TOOL_OPTIONS")).toThrow(/reserved/);
    });

    it("rejects PYTHONHOME (Python interpreter hijack)", () => {
      expect(withEnvName("PYTHONHOME")).toThrow(/reserved/);
    });

    it("rejects NPM_CONFIG_PREFIX (npm install-g target hijack)", () => {
      expect(withEnvName("NPM_CONFIG_PREFIX")).toThrow(/reserved/);
    });

    it("rejects PERL5OPT (perl interpreter flag injection)", () => {
      expect(withEnvName("PERL5OPT")).toThrow(/reserved/);
    });

    it("rejects lowercase names", () => {
      expect(withEnvName("fly_api_token")).toThrow(/must match/);
    });

    it("rejects names starting with a digit", () => {
      expect(withEnvName("1TOKEN")).toThrow(/must match/);
    });

    it("rejects names containing dashes", () => {
      expect(withEnvName("FLY-TOKEN")).toThrow(/must match/);
    });

    it("rejects names with shell metacharacters", () => {
      expect(withEnvName("FOO;rm -rf /")).toThrow(/must match/);
    });

    it("accepts well-formed names like FLY_API_TOKEN", () => {
      const inputs = withEnvName("FLY_API_TOKEN")() as { credentials: { envName?: string }[] };
      expect(inputs.credentials[0].envName).toBe("FLY_API_TOKEN");
    });

    it("accepts a leading underscore", () => {
      const inputs = withEnvName("_PRIVATE_VAR")() as { credentials: { envName?: string }[] };
      expect(inputs.credentials[0].envName).toBe("_PRIVATE_VAR");
    });
  });

  describe("allow-failure", () => {
    function setBaseInputs(): void {
      setInput("zone-url", "https://zone.keycard.cloud");
      setInput(
        "credentials",
        `
- resource: urn:fly:app:foo:deploy-token
  type: env
  env-name: FLY_API_TOKEN
`,
      );
    }

    it("defaults to false when input is unset", () => {
      setBaseInputs();
      expect(parseInputs().allowFailure).toBe(false);
    });

    it("treats empty string as false (the unset-vars case)", () => {
      // vars.KEYCARD_ALLOW_FAILURE wired into the input but unset on the
      // org renders as the empty string at action invocation time. That
      // must mean "off", not "error".
      setBaseInputs();
      setInput("allow-failure", "");
      expect(parseInputs().allowFailure).toBe(false);
    });

    it("treats literal \"false\" as false", () => {
      setBaseInputs();
      setInput("allow-failure", "false");
      expect(parseInputs().allowFailure).toBe(false);
    });

    it("treats literal \"true\" as true", () => {
      setBaseInputs();
      setInput("allow-failure", "true");
      expect(parseInputs().allowFailure).toBe(true);
    });

    it("rejects other truthy spellings loudly", () => {
      // A typo here would silently leave bypass disabled during an
      // outage. Reject so the operator sees the error immediately.
      setBaseInputs();
      for (const bad of ["yes", "1", "True", "TRUE", "on"]) {
        setInput("allow-failure", bad);
        expect(() => parseInputs()).toThrow(/allow-failure must be/);
      }
    });
  });
});
