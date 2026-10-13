import assert from "node:assert/strict"
import test from "node:test"

import { flattenTree, groupLocalContexts, localRootContexts } from "../src/lib/contexts-tree.ts"

const contexts = [
  { id: "b", name: "Beta", parent_id: null },
  { id: "a", name: "Alpha", parent_id: null },
  { id: "a-child", name: "Child", parent_id: "a" },
  { id: "nested-child", name: "Grandchild", parent_id: "a-child" },
  { id: "stray", name: "Stray", parent_id: "not-a-local-context" },
]

test("local contexts nest under their parent and sort by name then id", () => {
  const grouped = groupLocalContexts(contexts)
  assert.deepEqual(grouped.get(null)?.map((context) => context.id), ["a", "b"])
  assert.deepEqual(grouped.get("a")?.map((context) => context.id), ["a-child"])
  assert.deepEqual(grouped.get("a-child")?.map((context) => context.id), ["nested-child"])
  assert.deepEqual(grouped.get("not-a-local-context")?.map((context) => context.id), ["stray"])
})

test("local contexts parented outside the local list stay roots of the local branch", () => {
  assert.deepEqual(localRootContexts(contexts).map((context) => context.id), ["a", "b", "stray"])
})

test("flattening a recursive tree yields depth-first order", () => {
  const tree = {
    id: "root",
    name: "Root",
    children: [
      { id: "one", name: "One", children: [{ id: "one-one", name: "One One", children: [] }] },
      { id: "two", name: "Two", children: [] },
    ],
  }
  assert.deepEqual(flattenTree(tree).map((node) => node.id), ["root", "one", "one-one", "two"])
})
