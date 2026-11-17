import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * The README is the only place a host learns what this package offers, so it has
 * to name every export: a component that ships without a line here is effectively
 * undocumented. Both directions are checked — nothing exported is missing from the
 * list, and nothing listed has been renamed away.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const indexPath = "../src/index.ts"
const logicPath = "../src/logic.ts"
const readme = read("../README.md")
const index = read(indexPath)

/// Every name `index.ts` exports, aliases resolved to the name the host imports.
function exportedNames(source: string) {
  const names = new Set<string>()
  // `export { a, b as c } from "..."` and `export type { ... } from "..."`, both
  // single-line and wrapped across lines.
  for (const match of source.matchAll(/export (?:type )?\{([\s\S]*?)\} from/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

/// The modules `logic.ts` re-exports wholesale; each must be named in the list.
function logicModules(source: string) {
  return [...source.matchAll(/export \* from "\.\/(.+?)"/g)].map(([, path]) => path)
}

describe("the README lists every component the package exports", () => {
  const exported = exportedNames(index)

  it("parses the entry point instead of trusting a hand-written list", () => {
    // A guard on the guard: the parse must see the whole surface, not a corner.
    expect(exported.length).toBeGreaterThan(100)
    expect(exported).toContain("CybionThreadView")
    expect(exported).toContain("ThreadSettingsFields")
    // An alias is documented under the name a host actually imports.
    expect(exported).toContain("BudgetStopNoticeView")
    expect(exported).not.toContain("BudgetStopNotice as BudgetStopNoticeView")
  })

  it("names every export in a code span, so a reader can copy it", () => {
    const missing = exported.filter((name) => !readme.includes(`\`${name}\``))
    expect(missing, `README is missing: ${missing.join(", ")}`).toEqual([])
  })

  it("does not document names the package no longer exports", () => {
    // Only the inventory tables are checked, so prose (README wording, host
    // filenames) cannot fail this rule.
    const tables = readme.split("\n").filter((line) => line.startsWith("| `"))
    const documented = new Set<string>()
    for (const line of tables) {
      for (const match of line.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) documented.add(match[1])
    }
    const known = new Set([
      ...exported,
      // Props and payload types the components take, and the plain values the
      // tables mention (mode names, field names, function arguments).
      "mode", "override", "defaults", "threadId", "value", "onChange", "renderRecord",
      "onTitleChange", "onThreadChange", "headerActions", "olderPages", "readOnly",
      "onRaise", "minimal", "language", "sessionId", "identity", "t", "link",
      "baseUrl", "getToken", "status", "name", "key", "upstream", "model", "cn",
      "formatMoney", "parseMoneyInput", "sanitizeMoneyInput", "composerDraftKey",
      "splitPickedFiles", "composeComposerInput", "maxInputChars", "handleChatInputKeyDown",
      "composerAction", "copyFor", "fillCopy", "fillCopy", "values", "ready", "running", "blocked",
    ])
    const stale = [...documented].filter((name) => !known.has(name))
    expect(stale, `README documents names that are not exported: ${stale.join(", ")}`).toEqual([])
  })

  it("names every module the logic entry point re-exports", () => {
    const modules = logicModules(read(logicPath))
    expect(modules.length).toBeGreaterThan(20)
    const missing = modules.filter((path) => !readme.includes(path.split("/").pop()!))
    expect(missing, `README is missing logic modules: ${missing.join(", ")}`).toEqual([])
  })

  it("points at the subpath entry instead of implying one bundle", () => {
    expect(readme).toContain("`@zccz14/cybion-components/logic`")
    expect(readme).toContain("`@zccz14/cybion-components/styles.css`")
  })
})
