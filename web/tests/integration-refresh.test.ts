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
  const schema = readPackageSource("lib/thread-settings.ts")
  // The account's catalogs are read through the provider by the one settings
  // control, so no surface outside the package fetches or groups them any more.
  assert.match(source, /"\/api\/integrations\/upstreams"/)
  assert.match(readPackageSource("hooks/use-thread-settings-data.ts"), /`\/api\/integrations\/upstreams\/models\$\{kind \? `\?kind=\$\{kind\}` : ""\}`/)
  assert.match(fields, /modelGroups\(models\.data\?\.upstreams, value\.upstream_id, value\.model\)/)
  assert.match(readPackageSource("lib/model-catalog.ts"), /export function modelSelection\(upstreamId: string \| null, model: string\)/)
  assert.doesNotMatch(source, /catalogs=\{/)
  // The conversation's panel is the drop-in button: it fetches its own catalogs
  // through the provider, so the thread view passes none of them.
  assert.doesNotMatch(view, /catalogs=\{/)
  // The button takes the owner's whole Thread, which a reader of somebody else's Thread
  // does not have: only an owned row offers settings at all.
  assert.match(view, /\{ownedThread && <ThreadSettingsButton threadId=\{threadId\} value=\{ownedThread\}/)
  assert.match(button, /threadSettingsPatch\(next, saved\)/)
  assert.match(fields, /<SelectGroup key=\{group\.id\}>/)
  assert.match(source, /availableModels: "Available models"/)
  assert.match(source, /availableModels: "可用模型"/)
  assert.doesNotMatch(source, /THREAD_MODELS/)
})
