import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

type Localized = { en: string; zh: string }
type CommonNode = { name: Localized; description: Localized; content_file: Localized; children?: CommonNode[] }

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const tree = JSON.parse(readFileSync(new URL("../../common-manuals/tree.json", import.meta.url), "utf8")) as { root: CommonNode }

test("the Manuals page renders the compiled-in Cybion Common Manual read-only", () => {
  const manuals = source.slice(source.indexOf("function ManualsPage("), source.indexOf("function ManualEditorForm("))
  assert.match(manuals, /<CommonBranch node=\{commonRoot\}/)
  assert.match(manuals, /content=\{commonSelected\.content\}/)
  assert.match(source, /<MarkdownEditor language=\{language\} value=\{content\} onChange=\{\(\) => \{\}\} readOnly \/>/)
  assert.equal((source.match(/\/api\/common-manuals\?lang=\$\{language\}/g) ?? []).length, 3)
  assert.equal((source.match(/commonManualTitle:/g) ?? []).length, 2)
  assert.equal((source.match(/commonManualHint:/g) ?? []).length, 2)
})

test("every common manual node ships en and zh markdown content", () => {
  assert.equal(tree.root.name.en, "Cybion Common Manual")
  assert.equal(tree.root.name.zh, "Cybion 公共手册")
  const visit = (node: CommonNode) => {
    for (const language of ["en", "zh"] as const) {
      assert.ok(node.name[language].trim().length > 0, `${language}: ${node.content_file[language]}`)
      assert.ok(node.description[language].trim().length > 0, `${language}: ${node.content_file[language]}`)
      const file = node.content_file[language]
      assert.ok(existsSync(new URL(`../../common-manuals/${file}`, import.meta.url)), file)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree.root)
})
