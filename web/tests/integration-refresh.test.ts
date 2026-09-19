import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("integration refresh explains credential repair and reports only confirmed success in both languages", () => {
  assert.match(source, /refreshIntegrationsHelp: "Verify the OpenAI-LB Consumer and token\./)
  assert.match(source, /refreshIntegrationsHelp: "校验 OpenAI-LB 消费者与 Token。/)
  assert.match(source, /re-enables a disabled one/)
  assert.match(source, /重新启用被禁用的消费者/)
  assert.match(source, /integrationsVerified: "OpenAI-LB Consumer and token verified\."/)
  assert.match(source, /integrationsVerified: "OpenAI-LB 消费者与 Token 已校验。"/)
  assert.match(source, /refresh\.isSuccess && <p role="status"[^>]*>\{t\("integrationsVerified"\)\}/)
  assert.match(source, /refresh\.error && <p[^>]*>\{errorMessage\(refresh\.error\)\}/)
  assert.match(source, /disabled=\{refresh\.isPending\} onClick=\{\(\) => refresh\.mutate\(\)\}/)
  assert.match(source, /"\/api\/integrations\/refresh", \{ method: "POST" \}/)
})
