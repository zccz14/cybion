import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("NormAI is the automatic default upstream with a managed consumer credential", () => {
  assert.match(source, /new Set\(\["cybion\.ntnl\.io", "linkit\.ntnl\.io", "openai\.ntnl\.io", "ctx\.ntnl\.io", "normai\.ntnl\.io", window\.location\.hostname\]\)/)
  assert.match(source, /"\/api\/integrations\/normai"/)
  assert.match(source, /"\/api\/integrations\/normai\/rotate"/)
  assert.match(source, /function NormaiAutoConnect/)
  assert.match(source, /function isNormaiUpstream/)
  assert.match(source, /hostname === NORMAI_HOST/)
  assert.match(source, /!isNormaiUpstream\(upstream\)/)
})

test("the NormAI card links to provider configuration and confirms reissue", () => {
  assert.match(source, /normaiTitle: "NormAI upstream"/)
  assert.match(source, /normaiTitle: "NormAI 上游"/)
  assert.match(source, /normaiDescription: "模型推理经由 NormAI 完成；上游提供商与计费都在 NormAI 配置/)
  assert.match(source, /normaiOpenProviders: "Configure providers on NormAI"/)
  assert.match(source, /normaiOpenProviders: "在 NormAI 配置上游提供商"/)
  assert.match(source, /https:\/\/normai\.ntnl\.io\/#\/providers/)
  assert.match(source, /window\.confirm\(t\("normaiReissueConfirm"\)\)/)
  assert.match(source, /<NormaiUpstreamCard key=\{session\?\.sessionId\} sdk=\{sdk\} \/>/)
})
