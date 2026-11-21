import assert from "node:assert/strict";

const token = process.env.ACCEPTANCE_TOKEN;
assert.ok(token, "Expected a non-empty exported token");
const parts = token.split(".");
assert.equal(parts.length, 3, "Expected a JWT");
let claims;
try {
  claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
} catch {
  throw new Error("Expected a JSON JWT payload");
}
assert.ok(process.env.EXPECTED_ISSUER, "Expected a zone issuer");
assert.ok(process.env.EXPECTED_RESOURCE, "Expected a resource identifier");
assert.ok(claims?.iss === process.env.EXPECTED_ISSUER, "Unexpected token issuer");
const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
assert.ok(audiences.includes(process.env.EXPECTED_RESOURCE), "Missing resource audience");
