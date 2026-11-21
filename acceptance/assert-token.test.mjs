import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const issuer = "https://zone.example.com";
const resource = "urn:example:resource";
const script = fileURLToPath(new URL("./assert-token.mjs", import.meta.url));

function check(token) {
  const result = spawnSync(process.execPath, [script], {
    env: {
      ACCEPTANCE_TOKEN: token,
      EXPECTED_ISSUER: issuer,
      EXPECTED_RESOURCE: resource,
    },
    encoding: "utf8",
  });
  if (token) assert.ok(!result.stderr.includes(token));
  return result.status;
}

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

test("accepts string and array resource audiences", () => {
  for (const aud of [resource, [resource, "other"]]) {
    assert.equal(check(jwt({ iss: issuer, aud })), 0);
  }
});

test("rejects an empty token", () => {
  assert.notEqual(check(""), 0);
});

test("rejects malformed tokens", () => {
  assert.notEqual(check("not-a-jwt"), 0);
  assert.notEqual(check("header.invalid.signature"), 0);
});

test("rejects the wrong issuer", () => {
  assert.notEqual(check(jwt({ iss: "https://wrong.example.com", aud: resource })), 0);
});

test("rejects the wrong audience", () => {
  assert.notEqual(check(jwt({ iss: issuer, aud: "wrong" })), 0);
});
