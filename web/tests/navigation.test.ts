import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("controller navigation keeps all audit surfaces together", () => {
  const audit = source.match(/const auditNav = \[(.*?)\]\n  const systemNav/s)?.[1] ?? ""
  for (const route of [
    "/insights",
    "/history-records",
    "/reasoning-audit",
    "/commands",
    "/file-objects",
    "/gallery",
  ]) {
    assert.match(audit, new RegExp(`to: '${route}'`))
  }
  assert.equal((audit.match(/to: '/g) ?? []).length, 6)
})

test("navigation separates work, audit, system, and configuration", () => {
  for (const group of ["navWork", "navAudit", "navSystem", "navConfiguration"]) {
    assert.match(source, new RegExp(`${group}:`))
  }
  assert.match(source, /id: 'work'/)
  assert.match(source, /id: 'audit'/)
  assert.match(source, /id: 'system'/)
  assert.match(source, /id: 'configuration'/)
})

test("audit navigation preserves its routes and active NavLink behavior", () => {
  assert.match(source, /<NavLink to=\{to\}/)
  assert.match(source, /onClick=\{\(\) => setOpenMobile\(false\)\}/)
  assert.match(source, /const auditNav = \[/)
})
