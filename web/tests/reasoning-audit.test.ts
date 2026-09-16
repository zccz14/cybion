import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { auditCacheRate, openaiAuditUrl } from "../src/lib/reasoning-audit.ts"

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

test("OpenAI-LB audit links point to the matching request and encode the path segment", () => {
  const id = "0c3c123f-bd24-497e-938d-9d03550d8dd0"
  assert.equal(openaiAuditUrl(id), `https://openai.ntnl.io/#/audit/${id}`)
  assert.equal(openaiAuditUrl("request/with ?#%"), "https://openai.ntnl.io/#/audit/request%2Fwith%20%3F%23%25")
})

test("reasoning audit exposes the cache-rate column and safe external request links", () => {
  assert.match(auditPage, /<th[^>]*title=\{t\("auditCacheRateDescription"\)\}[^>]*>\{t\("statsCacheRate"\)\}<\/th>/)
  assert.match(auditPage, /auditCacheRate\(item\.input_tokens, item\.cached_tokens, language\)/)
  assert.match(auditPage, /item\.openai_lb_request_id \? <a href=\{openaiAuditUrl\(item\.openai_lb_request_id\)\} target="_blank" rel="noopener noreferrer"/)
  assert.match(auditPage, /<code[^>]*>\{item\.openai_lb_request_id\}<\/code>/)
  assert.match(auditPage, /<\/a> : <span[^>]*>—<\/span>/)
})
