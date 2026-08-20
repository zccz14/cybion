import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("insights is discoverable and exposes the required token and history metrics", () => {
  assert.match(source, /'\/insights'/)
  assert.match(source, /function InsightsPage/)
  assert.match(source, /insightsCacheRate/)
  assert.match(source, /insightsHistoryRecords/)
  assert.match(source, /range: '7d'/)
})

test("insights retains model, request type, and thread filters", () => {
  assert.match(source, /insightsThread/)
  assert.match(source, /insightsModel/)
  assert.match(source, /insightsKind/)
  assert.match(source, /\/api\/insights\?\$\{params\}/)
})
