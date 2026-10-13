import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

type Localized = { en: string; zh: string }
type CommonNode = { name: Localized; description: Localized; content_file: Localized; children?: CommonNode[] }

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const tree = JSON.parse(readFileSync(new URL("../../common-contexts/tree.json", import.meta.url), "utf8")) as { root: CommonNode }

test("the Contexts page renders the compiled-in Cybion Common Context read-only", () => {
  const contexts = source.slice(source.indexOf("function ContextsPage("), source.indexOf("function ContextEditorForm("))
  assert.match(contexts, /<CommonBranch node=\{commonRoot\}/)
  assert.match(contexts, /content=\{commonSelected\.content\}/)
  assert.match(source, /<MarkdownEditor language=\{language\} value=\{content\} onChange=\{\(\) => \{\}\} readOnly \/>/)
  assert.equal((source.match(/\/api\/common-contexts\?lang=\$\{language\}/g) ?? []).length, 3)
  assert.equal((source.match(/commonContextTitle:/g) ?? []).length, 2)
  assert.equal((source.match(/commonContextHint:/g) ?? []).length, 2)
})

test("every common context node ships en and zh markdown content", () => {
  assert.equal(tree.root.name.en, "Cybion Common Context")
  assert.equal(tree.root.name.zh, "Cybion 公共上下文")
  const visit = (node: CommonNode) => {
    for (const language of ["en", "zh"] as const) {
      assert.ok(node.name[language].trim().length > 0, `${language}: ${node.content_file[language]}`)
      assert.ok(node.description[language].trim().length > 0, `${language}: ${node.content_file[language]}`)
      const file = node.content_file[language]
      assert.ok(existsSync(new URL(`../../common-contexts/${file}`, import.meta.url)), file)
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree.root)
})
