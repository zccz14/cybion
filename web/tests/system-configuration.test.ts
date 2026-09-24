import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const system = readFileSync(new URL("../src/components/system-configuration.tsx", import.meta.url), "utf8")
const personal = main.slice(main.indexOf("function ConfigurationPage("), main.indexOf("function ApiKeysPage("))

test("personal configuration contains only personal controls, even for administrators", () => {
  assert.match(personal, /function ConfigurationPage\(\{ sdk \}/)
  assert.doesNotMatch(personal, /isAdmin|ExperimentalFeatures|RequestHeaders|user_agent|originator|saveHeaders|SystemConfiguration/)
  for (const feature of ["ThreadDefaultsCard", "UpstreamsCard", "/api/integrations/upstreams", 'to="/api"', 'to="/workers"']) assert.ok(personal.includes(feature))
  assert.match(main, /path="\/configuration" element=\{<ConfigurationPage sdk=\{sdk\} \/>/)
  assert.match(main, /path="\/settings" element=\{<ConfigurationPage sdk=\{sdk\} \/>/)
})

test("system configuration has a dedicated route, bilingual title, and admin navigation entry", () => {
  assert.match(main, /path="\/admin\/configuration" element=\{<SystemConfigurationPage sdk=\{sdk\} \/>/)
  assert.match(main, /pathname\.startsWith\("\/admin\/configuration"\)\) return t\("systemConfiguration"\)/)
  assert.match(main, /const administrationNav = isAdmin\s+\? \[[\s\S]*?to: "\/admin\/configuration"[\s\S]*?\]\s+: \[\]/)
  assert.match(main, /systemConfiguration: "系统配置"/)
  assert.match(main, /systemConfiguration: "System configuration"/)
  assert.match(main, /configuration: "个人配置"/)
  assert.match(main, /configuration: "Personal settings"/)
  assert.match(main, /<SystemConfiguration key=\{sessionId\}/)
})

test("Workers belongs to Work and there is no empty System navigation group", () => {
  const work = main.match(/const workNav = \[([\s\S]*?)\n  \]/)![1]
  assert.deepEqual([...work.matchAll(/to: "([^\"]+)"/g)].map((match) => match[1]), ["/threads", "/contexts", "/workers"])
  assert.doesNotMatch(main, /navSystem|systemNav/)
  assert.match(main, /id: "work", label: t\("navWork"\), items: workNav/)
  assert.match(main, /to: "\/system", label: t\("systemResources"\)/)
})

test("system editors mount only after verified administrator access and scope caches to the session", () => {
  const boundary = system.slice(system.indexOf("export function SystemConfiguration("), system.indexOf("function ExperimentalFeaturesCard("))
  const mount = boundary.indexOf("<ExperimentalFeaturesCard")
  for (const gate of ["access.isPending", "access.error", "access.data?.is_admin !== true"]) assert.ok(boundary.indexOf(gate) < mount)
  assert.match(main, /queryKey: \["me", sdk\.session\.getState\(\)\.sessionId\]/)
  assert.match(system, /queryKey: \["me", sessionId\]/)
  assert.match(system, /\["system-configuration", sessionId, "experimental-features"\]/)
  assert.match(system, /\["system-configuration", sessionId, "request-headers"\]/)
  assert.match(system, /const value = draft \?\? headers\.data/)
  assert.match(system, /save\.mutate\(\{ user_agent: value\.user_agent, originator: value\.originator \}\)/)
  assert.doesNotMatch(system, /useEffect|queryKey: \["integrations"\]/)
  for (const key of ["thread_id_header", "session_id_header", "codex_turn_state_header", "user_agent", "originator"]) assert.ok(system.includes(key))
})
