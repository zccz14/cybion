import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { compactTokenCount, emptyThreadUsage, threadCacheRate } from "../src/lib/thread-usage.ts"

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
