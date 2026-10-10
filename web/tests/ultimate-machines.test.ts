import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { createTestServer } from "./vite-server.ts"
import { formatInterval, machineDraftValid, machinePayload, machineStatus, type Machine } from "../src/lib/ultimate-machines.ts"

const base: Machine = {
  id: "m1",
  name: "磁盘检查",
  worker_id: "w1",
  worker_label: "Linux US",
  command: "test -f /tmp/ok",
  intent: null,
  interval_seconds: 600,
  thread_id: "t1",
  thread_title: "终极机器 · 磁盘检查",
  enabled: true,
  last_run_at: 1,
  last_exit: 0,
  created_at: 0,
}

test("machine status reflects enablement and the latest result", () => {
  assert.equal(machineStatus({ ...base, enabled: false, last_run_at: 1, last_exit: 0 }), "paused")
  assert.equal(machineStatus({ ...base, last_run_at: null }), "waiting")
  assert.equal(machineStatus({ ...base, last_exit: 0 }), "ok")
  assert.equal(machineStatus({ ...base, last_exit: 3 }), "failed")
  assert.equal(machineStatus({ ...base, last_exit: -1 }), "failed")
  assert.equal(machineStatus({ ...base, last_exit: null }), "failed")
})

test("interval formatting scales to days, hours, minutes and seconds", () => {
  assert.equal(formatInterval("zh", 10), "10 秒")
  assert.equal(formatInterval("zh", 600), "10 分钟")
  assert.equal(formatInterval("zh", 7200), "2 小时")
  assert.equal(formatInterval("zh", 86400), "1 天")
  assert.equal(formatInterval("en", 600), "10 min")
  assert.equal(formatInterval("zh", 90), "90 秒")
})

test("draft validation follows the server bounds", () => {
  const draft = { name: "磁盘检查", workerId: "w1", command: "test -f /tmp/ok", intent: "", interval: "600" }
  assert.equal(machineDraftValid(draft), true)
  assert.equal(machineDraftValid({ ...draft, name: "   " }), false)
  assert.equal(machineDraftValid({ ...draft, workerId: "" }), false)
  assert.equal(machineDraftValid({ ...draft, command: " " }), false)
  assert.equal(machineDraftValid({ ...draft, interval: "9" }), false)
  assert.equal(machineDraftValid({ ...draft, interval: "10" }), true)
  assert.equal(machineDraftValid({ ...draft, interval: "2592000" }), true)
  assert.equal(machineDraftValid({ ...draft, interval: "2592001" }), false)
  assert.equal(machineDraftValid({ ...draft, interval: "" }), false)
  assert.equal(machineDraftValid({ ...draft, interval: "abc" }), false)
})

test("payload trims name and intent and forwards an empty intent to clear it", () => {
  assert.deepEqual(machinePayload({ name: " 磁盘检查 ", workerId: "w1", command: "df -Pk /", intent: " 确保根分区低于 90% ", interval: "900" }), {
    name: "磁盘检查",
    worker_id: "w1",
    command: "df -Pk /",
    intent: "确保根分区低于 90%",
    interval_seconds: 900,
  })
  assert.equal(machinePayload({ name: "a", workerId: "w1", command: "c", intent: "   ", interval: "10" }).intent, "")
})

const component = readFileSync(new URL("../src/components/ultimate-machines.tsx", import.meta.url), "utf8")
const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const help = readFileSync(new URL("../src/components/ultimate-machine-help.tsx", import.meta.url), "utf8")
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")

test("create and edit dialogs share one field group and one payload builder", () => {
  assert.ok(component.includes('idPrefix="machine-create"'))
  assert.ok(component.includes('idPrefix="machine-edit"'))
  assert.ok(component.includes("${idPrefix}-intent"))
  assert.equal(component.match(/JSON\.stringify\(machinePayload\(input\)\)/g)?.length, 2)
  assert.ok(component.includes('method: "PATCH"'))
  assert.ok(component.includes('update.mutate(editDraft)'))
})

test("the help button sits beside the page title, not inside the machine card", () => {
  assert.ok(main.includes("actions={<UltimateMachineHelp language={language} />}"))
  assert.ok(!component.includes("UltimateMachineHelp"))
})

test("the help dialog explains the Shannon origin and loops the self-off machine", () => {
  assert.ok(help.includes("CircleHelpIcon"))
  assert.ok(help.includes("Claude Shannon"))
  assert.ok(help.includes("香农"))
  assert.ok(help.includes("明斯基"))
  assert.ok(help.includes("Arthur C. Clarke"))
  for (const name of ["um-lid", "um-lever", "um-led", "um-rod", "um-fist", "um-swing"]) {
    assert.ok(help.includes(name), name)
    assert.ok(styles.includes(`.um-scene .${name} {`), name)
    assert.ok(styles.includes(`@keyframes ${name} `), name)
  }
  assert.ok(styles.includes("animation: um-swing 7s ease-in-out infinite"))
  assert.ok(styles.includes("prefers-reduced-motion"))
})

test("real machine list renders edit, run and thread links from live data", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const { UltimateMachines } = await server.ssrLoadModule("/src/components/ultimate-machines.tsx")
    client.setQueryData(["machines", "session-machines"], [{ ...base, intent: "确保根分区低于 90%" }])
    client.setQueryData(["workers", "session-machines"], [{ id: "w1", label: "Linux US", created_at: 1, status: "online", access: "owner" }])
    const render = (language: "en" | "zh") =>
      renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client },
          createElement(MemoryRouter, {}, createElement(UltimateMachines, { sessionId: "session-machines", language, request: () => { throw new Error("Unexpected request during render") } })),
        ),
      )
    const html = render("en")
    assert.ok(html.includes(">Edit<"))
    assert.match(html, /New machine/)
    assert.match(html, /Run now/)
    assert.match(html, /Linux US/)
    assert.match(html, /href="\/threads\/t1"/)
    const zh = render("zh")
    assert.ok(zh.includes(">编辑<"))
    assert.match(zh, /新建机器/)
    assert.match(zh, /立即运行/)
  } finally {
    client.clear()
    await server.close()
  }
})
