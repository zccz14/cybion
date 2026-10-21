import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { compactTokenCount, emptyThreadUsage, threadCacheRate, threadCost } from "../src/lib/thread-usage.ts"

test("token counts compact large cumulative values without hiding zero", () => {
  for (const [input, expected] of [[0, "0"], [123, "123"], [125000, "125K"], [1234567, "1.2M"], [3000000000, "3B"], [1000000000000, "1T"]] as const) assert.equal(compactTokenCount(input), expected)
})

test("aggregate cache rates distinguish unknown, zero, and known weighted ratios in both languages", () => {
  for (const language of ["en", "zh"] as const) {
    assert.equal(threadCacheRate(null, language), "—")
    assert.equal(threadCacheRate(0, language), "0%")
    assert.equal(threadCacheRate(1, language), "100%")
    assert.equal(threadCacheRate(1085 / 1390, language), "78.1%")
  }
  assert.equal(emptyThreadUsage.total_tokens, 0)
  assert.equal(emptyThreadUsage.cache_hit_rate, null)
})

test("list and detail use server cumulative usage, not a sum of streaming previews", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const link = readFileSync(new URL("../src/components/thread-status.tsx", import.meta.url), "utf8")
  assert.match(main, /usage: ThreadUsage/)
  assert.match(main, /<ThreadUsagePanel usage=\{current.usage\} language=\{language\}/)
  assert.match(link, /<ThreadUsageSummary usage=\{thread.usage\}/)
  assert.match(link, /<ThreadUsageDetails usage=\{thread.usage\}/)
  assert.doesNotMatch(link, /fetch\(|useQuery/)
})

test("thread cost formats a reported amount and stays unknown otherwise", () => {
  const usage = { ...emptyThreadUsage }
  assert.equal(threadCost(usage, "en"), null, "no reported call means no amount")
  assert.equal(threadCost({ ...usage, cost_usd_nanos: 0, cost_settled_requests: 1 }, "en"), "$0.000000")
  assert.equal(threadCost({ ...usage, cost_usd_nanos: 1234, cost_settled_requests: 2 }, "en"), "$0.000001")
  assert.equal(threadCost({ ...usage, cost_usd_nanos: 12345678, cost_settled_requests: 2 }, "en"), "$0.0123")
  assert.equal(threadCost({ ...usage, cost_usd_nanos: 1234567890, cost_settled_requests: 9 }, "zh"), "$1.2346")
})
