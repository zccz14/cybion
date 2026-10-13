import assert from "node:assert/strict"
import test from "node:test"

import { collectSubtreeIds, commonAncestorIds, contextAncestorIds, contextCurrentPlacement, contextPlacementFor, contextTreeIndex, flattenTree } from "../src/lib/contexts-tree.ts"

const contexts = [
  { id: "b", name: "Beta", parent_id: null, sort_key: "a2" },
  { id: "a", name: "Alpha", parent_id: null, sort_key: "a1" },
  { id: "a-child", name: "Child", parent_id: "a", sort_key: "a1" },
  { id: "nested-child", name: "Grandchild", parent_id: "a-child", sort_key: "a1" },
  { id: "stray", name: "Stray", parent_id: "not-a-local-context", sort_key: "a3" },
]

test("siblings follow their sort keys and stray parents join the root group", () => {
  const index = contextTreeIndex(contexts)
  assert.deepEqual(index.get(null)?.map((context) => context.id), ["a", "b", "stray"])
  assert.deepEqual(index.get("a")?.map((context) => context.id), ["a-child"])
  assert.deepEqual(index.get("a-child")?.map((context) => context.id), ["nested-child"])
  assert.deepEqual(index.get("not-a-local-context") ?? [], [])
  assert.deepEqual(index.get("stray") ?? [], [])
})

test("rows without sort keys fall back to name then id", () => {
  const index = contextTreeIndex([
    { id: "z", name: "Zulu", parent_id: null, sort_key: "" },
    { id: "late", name: "Alpha", parent_id: null, sort_key: "" },
    { id: "early", name: "Alpha", parent_id: null, sort_key: "" },
  ])
  assert.deepEqual(index.get(null)?.map((context) => context.id), ["early", "late", "z"])
})

test("a subtree collects depth-first without the node itself", () => {
  const index = contextTreeIndex(contexts)
  assert.deepEqual(collectSubtreeIds(index, "a"), ["a-child", "nested-child"])
  assert.deepEqual(collectSubtreeIds(index, "nested-child"), [])
})

test("the current placement reads the previous sibling as its anchor", () => {
  const index = contextTreeIndex(contexts)
  assert.deepEqual(contextCurrentPlacement(index, contexts[0]), { parentId: null, afterId: "a" })
  assert.deepEqual(contextCurrentPlacement(index, contexts[1]), { parentId: null, afterId: null })
  assert.deepEqual(contextCurrentPlacement(index, contexts[4]), { parentId: null, afterId: "b" })
})

test("drop zones resolve into the parent and anchor a move writes", () => {
  const index = contextTreeIndex(contexts)
  const [beta, alpha] = contexts
  // inside appends after the target's last child
  assert.deepEqual(contextPlacementFor(index, beta, alpha, "inside"), { parentId: "a", afterId: "a-child" })
  // inside a childless target starts the group
  assert.deepEqual(contextPlacementFor(index, beta, contexts[3], "inside"), { parentId: "nested-child", afterId: null })
  // inside never anchors on the moving node itself
  assert.deepEqual(contextPlacementFor(index, contexts[2], alpha, "inside"), { parentId: "a", afterId: null })
  // after anchors on the target itself
  assert.deepEqual(contextPlacementFor(index, beta, alpha, "after"), { parentId: null, afterId: "a" })
  // before anchors on the sibling that precedes the target once the moving
  // node leaves the sequence (so re-dropping in place degrades to a no-op)
  assert.deepEqual(contextPlacementFor(index, beta, contexts[4], "before"), { parentId: null, afterId: "a" })
  // dropping a node after itself is rejected
  assert.equal(contextPlacementFor(index, beta, beta, "after"), null)
})

test("ancestor chains expand a restored selection from the top down", () => {
  assert.deepEqual(contextAncestorIds(contexts, "nested-child"), ["a", "a-child"])
  assert.deepEqual(contextAncestorIds(contexts, "a-child"), ["a"])
  assert.deepEqual(contextAncestorIds(contexts, "a"), [])
  // stray parents end the chain just like the root grouping does
  assert.deepEqual(contextAncestorIds(contexts, "stray"), [])
})

test("common ancestor chains stop at the node itself", () => {
  const tree = {
    id: "root",
    name: "Root",
    children: [
      { id: "one", name: "One", children: [{ id: "one-one", name: "One One", children: [] }] },
      { id: "two", name: "Two", children: [] },
    ],
  }
  assert.deepEqual(commonAncestorIds(tree, "one-one"), ["root", "one"])
  assert.deepEqual(commonAncestorIds(tree, "two"), ["root"])
  assert.deepEqual(commonAncestorIds(tree, "root"), [])
  assert.deepEqual(commonAncestorIds(tree, "missing"), [])
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
