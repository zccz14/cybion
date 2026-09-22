import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("personal configuration saves a Responses-compatible API without exposing the key", () => {
  assert.match(source, /apiBaseUrlDescription: "Cybion sends model requests to this URL with \/responses appended\./)
  assert.match(source, /apiKeyDescription: "Stored per user and never returned to the browser\./)
  assert.match(source, /apiBaseUrlDescription: "Cybion 会在这个地址后追加 \/responses 发送模型请求。/)
  assert.match(source, /apiKeyDescription: "按用户保存，永远不会返回到浏览器。/)
  assert.match(source, /"\/api\/integrations\/openai"/)
  assert.match(source, /api_key: apiKey/)
  assert.match(source, /type="password" autoComplete="new-password"/)
  assert.doesNotMatch(source, /openai_consumer_secret/)
})
