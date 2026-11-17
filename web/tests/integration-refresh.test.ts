import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { readPackageSource } from "./package-source.ts"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const popover = readPackageSource("components/thread-settings-popover.tsx")
// The fields are shared with the account defaults form, so the pickers live here now.
const fields = readPackageSource("components/thread-settings-fields.tsx")
const button = readPackageSource("components/thread-settings-button.tsx")

test("personal configuration manages multiple Responses-compatible upstreams without exposing keys", () => {
  assert.match(source, /apiBaseUrlDescription: "Cybion sends model requests to this URL with \/responses appended\./)
  assert.match(source, /apiKeyDescription: "Stored per user and never returned to the browser\./)
  assert.match(source, /apiBaseUrlDescription: "Cybion 会在这个地址后追加 \/responses 发送模型请求。/)
  assert.match(source, /apiKeyDescription: "按用户保存，永远不会返回到浏览器。/)
  assert.match(source, /"\/api\/integrations\/upstreams"/)
  assert.match(source, /<UpstreamsManager sdk=\{sdk\} \/>/)
  assert.match(source, /api_key: apiKey/)
  assert.match(source, /type="password" autoComplete="new-password"/)
  assert.match(source, /function AddUpstreamForm/)
  assert.match(source, /window\.confirm\(t\("upstreamDeleteConfirm"\)\)/)
  assert.doesNotMatch(source, /openai_consumer_secret/)
})

test("each upstream owns its model catalog and the model pickers group by upstream", () => {
  const view = readPackageSource("thread-view.tsx")
  assert.match(source, /"\/api\/integrations\/upstreams\/models"/)
  assert.match(source, /function useUpstreamModels/)
  // The grouping moved into the shared fields component; the card hands it the
  // polled catalog and the picker groups by upstream there.
  assert.match(source, /catalogs=\{models\.data\?\.upstreams\}/)
  assert.match(fields, /modelGroups\(catalogs, upstreamId, model\)/)
  // The new-Thread composer picks from the polled account catalog, and so does the
  // account defaults form, which now renders the same shared fields.
  assert.equal(source.match(/catalogs=\{models\.data\?\.upstreams\}/g)?.length, 2)
  // The conversation's panel is the drop-in button: it fetches its own catalogs
  // through the provider, so the thread view passes none of them.
  assert.doesNotMatch(view, /catalogs=\{/)
  assert.match(view, /<ThreadSettingsButton threadId=\{threadId\} value=\{current\}/)
  assert.match(source, /upstreamId=\{value\.upstream_id\}/)
  assert.match(fields, /modelSelection\(upstreamId, model\)/)
  assert.match(button, /onModelChange=\{\(upstream_id, model\) => settings\.mutate\(\{ upstream_id, model \}\)\}/)
  assert.match(source, /availableModels: "Available models"/)
  assert.match(source, /availableModels: "可用模型"/)
  assert.match(fields, /<SelectGroup key=\{group\.id\}>/)
  assert.match(fields, /\{group\.name && <SelectLabel>\{group\.name\}<\/SelectLabel>\}/)
  assert.doesNotMatch(source, /THREAD_MODELS/)
})
