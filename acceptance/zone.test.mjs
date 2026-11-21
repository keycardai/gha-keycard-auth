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
      items() { echo '[{"id":"existing","identifier":"test","name":"${name}"}]'; }
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
