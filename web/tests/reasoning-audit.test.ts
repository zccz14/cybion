import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { auditCacheRate, gatewayAuditUrl } from "../src/lib/reasoning-audit.ts"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const auditPage = source.slice(source.indexOf("function ReasoningAuditPage("), source.indexOf("function WorkerAuditPage("))

test("audit cache rate uses cached input over total input with one decimal of precision", () => {
  for (const language of ["en", "zh"]) {
    assert.equal(auditCacheRate(1000, 750, language), "75%")
    assert.equal(auditCacheRate(3, 1, language), "33.3%")
    assert.equal(auditCacheRate(1000, 0, language), "0%")
    assert.equal(auditCacheRate(1000, 1000, language), "100%")
  }
})

test("unreported usage and zero input do not invent a cache rate", () => {
  for (const [input, cached] of [[null, null], [null, 0], [1000, null], [0, 0], [0, null], [0, 10]] as const) {
    assert.equal(auditCacheRate(input, cached, "en"), "—")
  }
})

test("audit links point at the console of the gateway that served the call", () => {
  const id = "0c3c123f-bd24-497e-938d-9d03550d8dd0"
  assert.equal(gatewayAuditUrl("https://normai.ntnl.io/v1", id), `https://normai.ntnl.io/#/audit/${id}`)
  assert.equal(gatewayAuditUrl("https://openai.ntnl.io/v1", "request/with ?#%"), "https://openai.ntnl.io/#/audit/request%2Fwith%20%3F%23%25")
  assert.equal(gatewayAuditUrl("", id), null, "a row that names no upstream gets no link")
  assert.equal(gatewayAuditUrl("not a url", id), null)
})

test("reasoning audit exposes the cache-rate column and safe external request links", () => {
  assert.match(auditPage, /<th[^>]*title=\{t\("auditCacheRateDescription"\)\}[^>]*>\{t\("statsCacheRate"\)\}<\/th>/)
  assert.match(auditPage, /auditCacheRate\(item\.input_tokens, item\.cached_tokens, language\)/)
  assert.match(auditPage, /<RequestIdCell requestId=\{item\.request_id\} upstreamBaseUrl=\{item\.upstream_base_url\} label=\{t\("auditOpenLink"\)\} \/>/)
  assert.match(source, /<code className="break-all text-xs">\{requestId\}<\/code>/)
  assert.match(source, /href=\{url\} target="_blank" rel="noopener noreferrer" title=\{label\}/)
  assert.match(auditPage, /\} \/> : <span[^>]*>—<\/span>/)
})
