import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const popover = readFileSync(new URL("../src/components/thread-settings-popover.tsx", import.meta.url), "utf8")

test("personal configuration manages multiple Responses-compatible upstreams without exposing keys", () => {
  assert.match(source, /apiBaseUrlDescription: "Cybion sends model requests to this URL with \/responses appended\./)
  assert.match(source, /apiKeyDescription: "Stored per user and never returned to the browser\./)
  assert.match(source, /apiBaseUrlDescription: "Cybion 会在这个地址后追加 \/responses 发送模型请求。/)
  assert.match(source, /apiKeyDescription: "按用户保存，永远不会返回到浏览器。/)
  assert.match(source, /"\/api\/integrations\/upstreams"/)
  assert.match(source, /api_key: apiKey/)
  assert.match(source, /type="password" autoComplete="new-password"/)
  assert.match(source, /function AddUpstreamForm/)
  assert.match(source, /window\.confirm\(t\("upstreamDeleteConfirm"\)\)/)
  assert.doesNotMatch(source, /openai_consumer_secret/)
})

test("each upstream owns its model catalog and the model pickers group by upstream", () => {
  assert.match(source, /"\/api\/integrations\/upstreams\/models"/)
  assert.match(source, /function useUpstreamModels/)
  assert.match(source, /modelGroups\(models\.data\?\.upstreams, value\.upstream_id, value\.model\)/)
  assert.equal(source.match(/catalogs=\{models\.data\?\.upstreams\}/g)?.length, 2)
  assert.match(source, /upstreamId=\{value\.upstream_id\}/)
  assert.match(source, /upstreamId=\{current\.upstream_id\}/)
  assert.match(source, /onModelChange=\{\(upstream_id, model\) => settings\.mutate\(\{ upstream_id, model \}\)\}/)
  assert.match(source, /availableModels: "Available models"/)
  assert.match(source, /availableModels: "可用模型"/)
  assert.match(popover, /<SelectGroup key=\{group\.id\}>/)
  assert.match(popover, /\{group\.name && <SelectLabel>\{group\.name\}<\/SelectLabel>\}/)
  assert.doesNotMatch(source, /THREAD_MODELS/)
})
