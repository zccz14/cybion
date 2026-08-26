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

test("active task status uses one shared top-bar query and accessible popup navigation", () => {
  const workspace = source.match(/function Workspace[\s\S]*?function reasoningSummary/)?.[0] ?? ""
  assert.equal((workspace.match(/queryKey: \['threads', 'active'\]/g) ?? []).length, 1)
  assert.match(source, /function AppHeader\(\{ language, threads, tasksLoading, tasksError \}/)
  assert.match(source, /aria-label=\{`\$\{t\('activeTasks'\)\}: \$\{threads\.length\}`\}/)
  assert.match(source, /<DropdownMenuItem asChild key=\{thread\.id\}><Link[^>]+to=\{`\/threads\/\$\{thread\.id\}`\}/)
  assert.match(source, /activeTasksLoading/)
  assert.match(source, /activeTasksError/)
  assert.match(source, /noActiveTasks/)
  const consoleSource = source.match(/function Console[\s\S]*?function VoicePreviewPanel/)?.[0] ?? ""
  assert.doesNotMatch(consoleSource, /queryKey: \['threads', 'active'\]/)
  assert.doesNotMatch(consoleSource, /activeSubthreads\.map\(\(thread\) => <Badge/)
})

test("machines poll safe executor resource snapshots every five seconds", () => {
  const machines = source.match(/function Machines[\s\S]*?function StoredFilePreview/)?.[0] ?? ""
  assert.match(machines, /queryKey: \['peers'\][\s\S]*refetchInterval: 5000/)
  assert.match(machines, /resource_status/)
  assert.match(machines, /resource_sampled_at/)
  assert.match(machines, /peer\.resource\.cpu\.usage_percent/)
  assert.match(machines, /peer\.resource\.network\.receive_bytes_per_second/)
  assert.doesNotMatch(machines, /mount_point|sqlite|process_used_bytes/)
})
