import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

type CommonNode = { name: string; content_file: string; children?: CommonNode[] }

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const tree = JSON.parse(readFileSync(new URL("../../common-contexts/tree.json", import.meta.url), "utf8")) as { root: CommonNode }

test("the Contexts page renders the compiled-in Cybion Common Context read-only", () => {
  assert.match(source, /<CommonContextCard sdk=\{sdk\} \/>/)
  assert.match(source, /"\/api\/common-contexts"/)
  assert.equal((source.match(/commonContextTitle:/g) ?? []).length, 2)
  assert.equal((source.match(/commonContextHint:/g) ?? []).length, 2)
})

test("every common context node ships its markdown content", () => {
  assert.equal(tree.root.name, "Cybion Common Context")
  const visit = (node: CommonNode) => {
    assert.ok(existsSync(new URL(`../../common-contexts/${node.content_file}`, import.meta.url)), node.content_file)
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree.root)
})
