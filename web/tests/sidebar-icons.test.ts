import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import * as icons from "lucide-react"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const navigation = source.slice(source.indexOf("  const workNav = ["), source.indexOf("  const workspaceNav:"))
const entries = [...navigation.matchAll(/\{ to: "([^"]+)", label: [^\n]+, icon: (\w+) \}/g)]
  .map(([, route, icon]) => [route, icon])

// The reviewed set keeps the existing route order, including admin-only items.
const approved = [
  ["/threads", "MessagesSquareIcon"],
  ["/shared-threads", "Share2Icon"],
  ["/contexts", "FolderTreeIcon"],
  ["/workers", "MonitorIcon"],
  ["/machines", "PowerIcon"],
  ["/insights", "ChartColumnIcon"],
  ["/reasoning-audit", "FileSearchIcon"],
  ["/worker-audit", "LogsIcon"],
  ["/history", "DatabaseIcon"],
  ["/admin/users", "UsersIcon"],
  ["/system", "CpuIcon"],
  ["/admin/configuration", "SettingsIcon"],
  ["/configuration", "Settings2Icon"],
  ["/api", "KeyRoundIcon"],
  ["/tools", "WrenchIcon"],
]

test("sidebar routes use the approved semantic icons in their existing order", () => {
  assert.deepEqual(entries, approved)
})

test("all 15 sidebar destinations render distinct monochrome outlines, including Lucide aliases", () => {
  assert.equal(entries.length, 15)
  const shapes = entries.map(([route, name]) => {
    const Icon = icons[name as keyof typeof icons] as icons.LucideIcon
    const svg = renderToStaticMarkup(createElement(Icon))
    assert.match(svg, /stroke="currentColor"/, route)
    assert.match(svg, /stroke-width="2"/, route)
    assert.match(svg, /fill="none"/, route)
    return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")
  })
  assert.equal(new Set(shapes).size, entries.length, "different icon names must not hide duplicate SVG shapes")
})
