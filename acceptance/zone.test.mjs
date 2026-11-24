import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "vitest";

function run(code) {
  return spawnSync("bash", ["-c", `source acceptance/zone.sh\n${code}`], { encoding: "utf8" });
}

test("ensure creates missing fixtures", () => {
  const result = run(`
    items() { echo '[]'; }
    api() { [[ $1 == POST && $2 == /fixtures ]] || return 1; echo '{"id":"created"}'; }
    ensure /fixtures '{"identifier":"test","name":"Test"}'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "created");
});

test("ensure keeps matching fixtures and patches changed fields", () => {
  for (const name of ["Test", "Old"]) {
    const result = run(`
      Z=/zones/test
      items() { jq -nc --arg marker "$MARKER" '{id:"existing",identifier:"test",name:"${name}",description:$marker} | [.]'; }
      api() { [[ $1 == PATCH && $2 == /fixtures/existing ]] || return 1; echo patched >&2; }
      ensure /fixtures '{"identifier":"test","name":"Test"}'
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "existing");
    assert.equal(result.stderr.includes("patched"), name === "Old");
  }
});

test("ensure propagates API failures", () => {
  const result = run(`api() { return 22; }; ensure /fixtures '{"identifier":"test"}'`);
  assert.notEqual(result.status, 0);
});

test("items follows pagination", () => {
  const result = run(`
    api() {
      if [[ $2 == *'after=next'* ]]; then
        echo '{"items":[{"id":"second"}],"page_info":{"has_next_page":false}}'
      else
        echo '{"items":[{"id":"first"}],"page_info":{"has_next_page":true,"end_cursor":"next"}}'
      fi
    }
    items /fixtures
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ id: "first" }, { id: "second" }]);
});

test("credentials create v2 fixtures and omit the default audience", () => {
  for (const audience of ["", "https://github.com/keycardai/gha-keycard-auth"]) {
    const result = run(`
      Z=/zones/test APP=application PROVIDER=provider
      items() { echo '[]'; }
      api() { [[ $1 == POST ]] || return 1; echo "$3" >&2; echo '{"id":"credential"}'; }
      credential '${audience}'
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "credential");
    const body = JSON.parse(result.stderr);
    assert.equal(body.version, 2);
    assert.equal(body.allowed_audience, audience || undefined);
    assert.equal(body.subject, "repo:keycardai/gha-keycard-auth:*");
  }
});

test("credentials update subject and clear stale conditions", () => {
  const result = run(`
    Z=/zones/test APP=application PROVIDER=provider
    items() { echo '[{"id":"credential","type":"token","version":2,"provider_id":"provider","allowed_audience":null,"subject":"old"}]'; }
    api() { [[ $1 == PATCH && $2 == /zones/test/application-credentials/credential ]] || return 1; echo "$3" >&2; }
    credential ''
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stderr).authentication_condition, null);
});

test("credentials create a v1 fixture without v2-only fields", () => {
  const result = run(`
    Z=/zones/test APP=application PROVIDER=provider
    items() { echo '[]'; }
    api() { echo "$3" >&2; echo '{"id":"v1"}'; }
    credential '' 1
  `);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stderr);
  assert.equal(body.version, 1);
  assert.equal(body.allowed_audience, undefined);
  assert.equal(body.authentication_condition, undefined);
});

test("up rejects missing configuration", () => {
  const result = run("unset KEYCARD_CLIENT_ID; main up");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KEYCARD_CLIENT_ID/);
});

test("token requests use form credentials and the configured endpoint", () => {
  for (const endpoint of ["https://api.keycard.ai", "https://api.example.com/"]) {
    const result = run(`
      KEYCARD_ENDPOINT='${endpoint}' KEYCARD_CLIENT_ID='id+value' KEYCARD_CLIENT_SECRET='secret&value'
      curl() { printf '%s\\n' "$@" >&2; echo '{"access_token":"test-token"}'; }
      get_token
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "test-token");
    const args = result.stderr.trim().split("\n");
    assert.ok(args.includes("grant_type=client_credentials"));
    assert.ok(args.includes("client_id=id+value"));
    assert.ok(args.includes("client_secret=secret&value"));
    assert.equal(args.filter((arg) => arg === "--data-urlencode").length, 2);
    assert.ok(!args.includes("--user"));
    assert.equal(args.at(-1), `${endpoint.replace(/\/$/, "")}/service-account-token`);
  }
});

test("endpoint defaults to production and Management API paths start at its root", () => {
  const result = run(`
    unset KEYCARD_ENDPOINT
    source acceptance/zone.sh
    TOKEN=test-token
    curl() { printf '%s\\n' "$@"; }
    api GET /zones/test
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").at(-1), "https://api.keycard.ai/zones/test");
});

test("token requests reject empty responses and propagate HTTP failures", () => {
  for (const response of ["{}", '{"access_token":""}', "failure"]) {
    const result = run(`
      KEYCARD_CLIENT_ID=id KEYCARD_CLIENT_SECRET=secret
      curl() { ${response === "failure" ? "return 22" : `echo '${response}'`}; }
      get_token
    `);
    assert.notEqual(result.status, 0);
  }
});

test("existing providers are read-only even when their fields differ", () => {
  const result = run(`
    Z=/zones/test
    items() { echo '[{"id":"shared","identifier":"https://token.actions.githubusercontent.com","name":"Shared provider"}]'; }
    api() { echo 'unexpected mutation' >&2; return 1; }
    ensure_provider '{"identifier":"https://token.actions.githubusercontent.com","name":"GitHub Actions"}'
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "shared");
  assert.equal(result.stderr, "");
});

test("new providers, applications and resources receive the ownership marker", () => {
  for (const call of [
    `ensure_provider '{"identifier":"https://token.actions.githubusercontent.com"}'`,
    `ensure "$Z/applications" '{"identifier":"gha-keycard-auth-acceptance"}'`,
    `ensure "$Z/resources" '{"identifier":"urn:keycard:gha-keycard-auth:acceptance"}'`,
  ]) {
    const result = run(`
      Z=/zones/test
      items() { echo '[]'; }
      api() { [[ $1 == POST ]] || return 1; echo "$3" >&2; echo '{"id":"created"}'; }
      ${call}
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stderr).description,
      "Managed by keycardai/gha-keycard-auth acceptance tests (acceptance/zone.sh)");
  }
});

test("unmarked legacy acceptance objects cannot be adopted", () => {
  for (const [collection, identifier] of [
    ["applications", "gha-keycard-auth-acceptance"],
    ["resources", "urn:keycard:gha-keycard-auth:acceptance"],
  ]) {
    for (const [name, description, allowed] of [
      ["gha-keycard-auth acceptance", "", false],
      ["Another application", "", false],
      ["gha-keycard-auth acceptance", "Owned elsewhere", false],
    ]) {
      const result = run(`
        Z=/zones/test
        items() { echo '[{"id":"existing","identifier":"${identifier}","name":"${name}","description":"${description}"}]'; }
        api() { [[ $1 == PATCH && $2 == "$Z/${collection}/existing" ]] || return 1; echo patched >&2; }
        ensure "$Z/${collection}" '{"identifier":"${identifier}","name":"gha-keycard-auth acceptance"}'
      `);
      assert.equal(result.status === 0, allowed, result.stderr);
      assert.equal(result.stderr.includes("patched"), allowed);
      if (!allowed) assert.match(result.stderr, /Refusing to modify unowned object/);
    }
  }
});

test("matching the legacy name alone does not authorize adoption", () => {
  const result = run(`
    Z=/zones/test
    items() { echo '[{"id":"existing","identifier":"other","name":"gha-keycard-auth acceptance"}]'; }
    api() { echo 'unexpected mutation' >&2; return 1; }
    ensure "$Z/applications" '{"identifier":"other","name":"gha-keycard-auth acceptance"}'
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to modify unowned object/);
});

const marker = "Managed by keycardai/gha-keycard-auth acceptance tests (acceptance/zone.sh)";
const appPrefix = "gha-keycard-auth-acceptance";
const resourcePrefix = "urn:keycard:gha-keycard-auth:acceptance";

function mockZone(data = {}) {
  return `
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    Z=/zones/test KEYCARD_ZONE_ID=test TOKEN=test-token
    STATE_FILE=$work/state GITHUB_OUTPUT=$work/output
    GITHUB_RUN_ID=123 GITHUB_RUN_ATTEMPT=2
    printf '%s' '${JSON.stringify({ applications: [], resources: [], credentials: [], dependencies: [], ...data })}' > "$work/db"
    touch "$work/deletes"
    items() {
      case "$1" in
        "$Z/applications") jq -c .applications "$work/db" ;;
        "$Z/resources") jq -c .resources "$work/db" ;;
        "$Z/providers") echo '[{"id":"sts","type":"keycard-sts"},{"id":"github","identifier":"https://token.actions.githubusercontent.com"}]' ;;
        "$Z/application-credentials") jq -c .credentials "$work/db" ;;
        */application-credentials) jq -c --arg app "$(basename "$(dirname "$1")")" '[.credentials[] | select(.application_id == $app)]' "$work/db" ;;
        */dependencies) jq -c --arg app "$(basename "$(dirname "$1")")" '[.dependencies[] | select(.application_id == $app)]' "$work/db" ;;
        *) return 1 ;;
      esac
    }
    api() {
      local collection id body app
      if [[ $1 == GET && $2 == "$Z" ]]; then
        echo '{"protocols":{"oauth2":{"issuer":"https://test.keycard.cloud"}}}'
        return
      fi
      case "$1 $2" in
        "POST $Z/applications")
          collection=applications; id=app
          [[ $(jq -r .identifier <<< "$3") != "$APP_PREFIX" ]] || id=stable-app ;;
        "POST $Z/resources")
          collection=resources; id=resource
          [[ $(jq -r .identifier <<< "$3") != "$RESOURCE_PREFIX" ]] || id=stable-resource ;;
        "POST $Z/application-credentials") collection=credentials; id="credential-$(jq '.credentials | length' "$work/db")" ;;
        "PUT $Z/applications/"*/dependencies/*)
          app=$(cut -d / -f 5 <<< "$2"); id=$(basename "$2")
          jq --arg app "$app" --arg id "$id" '.dependencies += [{id:$id,application_id:$app}]' "$work/db" > "$work/next"
          mv "$work/next" "$work/db"
          return ;;
        *) echo "Unexpected mutation $1 $2" >&2; return 1 ;;
      esac
      body=$(jq -c --arg id "$id" '. + {id: $id}' <<< "$3")
      jq --arg key "$collection" --argjson body "$body" '.[$key] += [$body]' "$work/db" > "$work/next"
      mv "$work/next" "$work/db"
      echo "$body"
    }
    delete_object() {
      local collection id=$2
      printf '%s\\n' "$1" >> "$work/deletes"
      case "$1" in
        */application-credentials/*) collection=credentials ;;
        */dependencies/*) collection=dependencies ;;
        "$Z/applications/"*) collection=applications ;;
        "$Z/resources/"*) collection=resources ;;
        *) return 1 ;;
      esac
      jq --arg key "$collection" --arg id "$id" '.[$key] |= map(select(.id != $id))' "$work/db" > "$work/next"
      mv "$work/next" "$work/db"
    }
  `;
}

test("up reuses stable v1 fixtures and down deletes only per-run children and parents", () => {
  const result = run(`${mockZone()}
    up
    jq -e --arg marker "$MARKER" '
      .applications[1].identifier == "gha-keycard-auth-acceptance-123-2" and
      .resources[1].identifier == "urn:keycard:gha-keycard-auth:acceptance:123-2" and
      all(.applications[], .resources[]; .description == $marker) and
      (.credentials | length) == 3 and (.dependencies | length) == 2' "$work/db" >/dev/null
    cat "$GITHUB_OUTPUT"
    down
    down
    jq -e 'all(.[]; length == 1) and .credentials[0].version == 1' "$work/db" >/dev/null
    up
    jq -e '(.credentials | length) == 3 and (.applications | length) == 2' "$work/db" >/dev/null
    down
    cat "$work/deletes"
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /resource_identifier=urn:keycard:gha-keycard-auth:acceptance:123-2/);
  assert.match(result.stdout, /v1_resource_identifier=urn:keycard:gha-keycard-auth:acceptance\n/);
  assert.deepEqual(result.stdout.trim().split("\n").slice(-5), [
    "/zones/test/application-credentials/credential-1",
    "/zones/test/application-credentials/credential-2",
    "/zones/test/applications/app/dependencies/resource",
    "/zones/test/applications/app",
    "/zones/test/resources/resource",
  ]);
});

test("local up uses a timestamp suffix that down reads from state", () => {
  const result = run(`${mockZone()}
    unset GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
    up
    jq -er '.suffix' "$STATE_FILE"
    down
    jq -e 'all(.[]; length == 1)' "$work/db" >/dev/null
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^local-\d+-\d+$/);
});

test("down cleans partial setup after a creation response is lost", () => {
  const result = run(`${mockZone()}
    eval "$(declare -f api | sed '1s/api/original_api/')"
    api() {
      original_api "$@"
      if [[ $2 == "$Z/resources" && $(jq -r .identifier <<< "$3") == "$RESOURCE_PREFIX:"* ]]; then
        return 22
      fi
    }
    set +e
    (set -e; up)
    status=$?
    set -e
    [[ $status != 0 ]]
    down
    jq -e 'all(.[]; length == 1)' "$work/db" >/dev/null
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("up failure and down reject state from a different zone", () => {
  const result = run(`${mockZone()}
    items() { return 22; }
    up
  `);
  assert.notEqual(result.status, 0);
  const wrongZone = run(`${mockZone()}
    echo '{"zone":"other","suffix":"123-2"}' > "$STATE_FILE"
    down
  `);
  assert.notEqual(wrongZone.status, 0);
});

test("sweep keeps stable v1, unmarked, young, unrelated and undated objects and never touches Providers", () => {
  const old = new Date(Date.now() - 7200_000).toISOString();
  const young = new Date(Date.now() - 600_000).toISOString();
  const applications = [
    { id: "old-app", identifier: `${appPrefix}-old`, description: marker, created_at: old },
    { id: "legacy-app", identifier: appPrefix, description: marker, created_at: old },
    { id: "young", identifier: `${appPrefix}-young`, description: marker, created_at: young },
    { id: "unmarked", identifier: `${appPrefix}-unmarked`, created_at: old },
    { id: "unmarked-legacy", identifier: appPrefix, created_at: old },
    { id: "unrelated", identifier: "other", description: marker, created_at: old },
    { id: "near-prefix", identifier: `${appPrefix}other`, description: marker, created_at: old },
    { id: "undated", identifier: `${appPrefix}-undated`, description: marker },
    { id: "bad-date", identifier: `${appPrefix}-bad`, description: marker, created_at: "invalid" },
  ];
  const resources = applications.map((app) => ({ ...app,
    id: `resource-${app.id}`, identifier: app.identifier.replace(appPrefix, resourcePrefix).replace(`${resourcePrefix}-`, `${resourcePrefix}:`),
  }));
  const result = run(`${mockZone({ applications, resources,
    credentials: [{ id: "credential", application_id: "old-app" }],
    dependencies: [{ id: "dependency", application_id: "old-app" }],
  })}
    cleanup sweep
    cat "$work/deletes"
    cleanup sweep
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "/zones/test/application-credentials/credential",
    "/zones/test/applications/old-app/dependencies/dependency",
    "/zones/test/applications/old-app",
    "/zones/test/resources/resource-old-app",
  ]);
});

test("down selects only this run's marked fixtures", () => {
  const result = run(`${mockZone({
    applications: [
      { id: "mine", identifier: `${appPrefix}-123-2`, description: marker },
      { id: "other", identifier: `${appPrefix}-456-1`, description: marker },
    ],
    resources: [{ id: "unmarked", identifier: `${resourcePrefix}:123-2` }],
  })}
    echo '{"zone":"test","suffix":"123-2"}' > "$STATE_FILE"
    down
    cat "$work/deletes"
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "/zones/test/applications/mine");
});

test("delete tolerates 404 but propagates HTTP and transport failures", () => {
  for (const status of ["204", "404", "403", "500", "transport"]) {
    const result = run(`
      TOKEN=test-token
      curl() { ${status === "transport" ? "return 7" : `echo ${status}`}; }
      delete_object /zones/test/resources/id id identifier
    `);
    assert.equal(result.status === 0, ["204", "404"].includes(status), result.stderr);
    if (result.status === 0) assert.match(result.stderr, /Deleted id identifier/);
  }
});

test("cleanup stops before parents when child deletion fails", () => {
  const result = run(`${mockZone({
    applications: [{ id: "app", identifier: `${appPrefix}-123-2`, description: marker }],
    credentials: [{ id: "credential", application_id: "app" }],
  })}
    delete_object() { echo "$1"; return 22; }
    cleanup down 123-2
  `);
  assert.equal(result.status, 22, result.stderr);
  assert.equal(result.stdout.trim(), "/zones/test/application-credentials/credential");
});

test("v1 validation rejects duplicate or foreign credentials and ignores other issuers and v2", () => {
  const base = { type: "token", version: 1, provider_id: "github",
    subject: "repo:keycardai/gha-keycard-auth:*", application_id: "stable-app" };
  for (const [credentials, allowed, message] of [
    [[], true],
    [[base], true],
    [[{ ...base, version: null }], true],
    [[base, { ...base, provider_id: "other" }, { ...base, version: 2 }], true],
    [[base, base], false, /multiple v1 credentials/],
    [[base, { ...base, subject: "*" }], false, /multiple v1 credentials/],
    [[{ ...base, application_id: "another-app" }], false, /does not belong/],
  ]) {
    const result = run(`${mockZone({ credentials })}
      APP=stable-app
      check_v1
    `);
    assert.equal(result.status === 0, allowed, result.stderr);
    if (!allowed) assert.match(result.stderr, message);
  }
});

test("sweep propagates list failures instead of deleting from an incomplete inventory", () => {
  const result = run(`${mockZone()}
    items() { return 22; }
    cleanup sweep
  `);
  assert.equal(result.status, 22, result.stderr);
});
