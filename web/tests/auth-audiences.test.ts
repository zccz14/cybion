import assert from "node:assert/strict"
import test from "node:test"
import { missingAudiences } from "../src/lib/auth-audiences.ts"

function token(claims: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`
}

test("tokens that carry every configured audience have nothing missing", () => {
  assert.deepEqual(missingAudiences(token({ aud: ["a.example", "b.example"] }), ["a.example", "b.example"]), [])
  assert.deepEqual(missingAudiences(token({ aud: "a.example" }), ["a.example"]), [])
})

test("audience-stale tokens report exactly the audiences the session cannot reach", () => {
  assert.deepEqual(missingAudiences(token({ aud: ["a.example"] }), ["a.example", "normai.ntnl.io"]), ["normai.ntnl.io"])
  assert.deepEqual(missingAudiences(token({ aud: "cybion.ntnl.io" }), ["cybion.ntnl.io", "normai.ntnl.io"]), ["normai.ntnl.io"])
  assert.deepEqual(missingAudiences(token({}), ["a.example"]), ["a.example"])
})

test("tokens this layer cannot read are left to the provider's verification", () => {
  assert.deepEqual(missingAudiences("not-a-jwt", ["a.example"]), [])
  assert.deepEqual(missingAudiences("a.%%%.c", ["a.example"]), [])
})
