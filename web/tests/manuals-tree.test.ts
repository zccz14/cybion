import assert from "node:assert/strict"
import test from "node:test"

import { collectSubtreeIds, commonAncestorIds, manualAncestorIds, manualCurrentPlacement, manualPlacementFor, manualTreeIndex, flattenTree, trashedRoots, visibleManuals } from "../src/lib/manuals-tree.ts"

const manuals = [
  { id: "b", name: "Beta", parent_id: null, sort_key: "a2" },
  { id: "a", name: "Alpha", parent_id: null, sort_key: "a1" },
  { id: "a-child", name: "Child", parent_id: "a", sort_key: "a1" },
  { id: "nested-child", name: "Grandchild", parent_id: "a-child", sort_key: "a1" },
  { id: "stray", name: "Stray", parent_id: "not-a-local-manual", sort_key: "a3" },
]

test("siblings follow their sort keys and stray parents join the root group", () => {
  const index = manualTreeIndex(manuals)
  assert.deepEqual(index.get(null)?.map((manual) => manual.id), ["a", "b", "stray"])
  assert.deepEqual(index.get("a")?.map((manual) => manual.id), ["a-child"])
  assert.deepEqual(index.get("a-child")?.map((manual) => manual.id), ["nested-child"])
  assert.deepEqual(index.get("not-a-local-manual") ?? [], [])
  assert.deepEqual(index.get("stray") ?? [], [])
})

test("rows without sort keys fall back to name then id", () => {
  const index = manualTreeIndex([
    { id: "z", name: "Zulu", parent_id: null, sort_key: "" },
    { id: "late", name: "Alpha", parent_id: null, sort_key: "" },
    { id: "early", name: "Alpha", parent_id: null, sort_key: "" },
  ])
  assert.deepEqual(index.get(null)?.map((manual) => manual.id), ["early", "late", "z"])
})

test("a subtree collects depth-first without the node itself", () => {
  const index = manualTreeIndex(manuals)
  assert.deepEqual(collectSubtreeIds(index, "a"), ["a-child", "nested-child"])
  assert.deepEqual(collectSubtreeIds(index, "nested-child"), [])
})

test("the current placement reads the previous sibling as its anchor", () => {
  const index = manualTreeIndex(manuals)
  assert.deepEqual(manualCurrentPlacement(index, manuals[0]), { parentId: null, afterId: "a" })
  assert.deepEqual(manualCurrentPlacement(index, manuals[1]), { parentId: null, afterId: null })
  assert.deepEqual(manualCurrentPlacement(index, manuals[4]), { parentId: null, afterId: "b" })
})

test("drop zones resolve into the parent and anchor a move writes", () => {
  const index = manualTreeIndex(manuals)
  const [beta, alpha] = manuals
  // inside appends after the target's last child
  assert.deepEqual(manualPlacementFor(index, beta, alpha, "inside"), { parentId: "a", afterId: "a-child" })
  // inside a childless target starts the group
  assert.deepEqual(manualPlacementFor(index, beta, manuals[3], "inside"), { parentId: "nested-child", afterId: null })
  // inside never anchors on the moving node itself
  assert.deepEqual(manualPlacementFor(index, manuals[2], alpha, "inside"), { parentId: "a", afterId: null })
  // after anchors on the target itself
  assert.deepEqual(manualPlacementFor(index, beta, alpha, "after"), { parentId: null, afterId: "a" })
  // before anchors on the sibling that precedes the target once the moving
  // node leaves the sequence (so re-dropping in place degrades to a no-op)
  assert.deepEqual(manualPlacementFor(index, beta, manuals[4], "before"), { parentId: null, afterId: "a" })
  // dropping a node after itself is rejected
  assert.equal(manualPlacementFor(index, beta, beta, "after"), null)
})

test("ancestor chains expand a restored selection from the top down", () => {
  assert.deepEqual(manualAncestorIds(manuals, "nested-child"), ["a", "a-child"])
  assert.deepEqual(manualAncestorIds(manuals, "a-child"), ["a"])
  assert.deepEqual(manualAncestorIds(manuals, "a"), [])
  // stray parents end the chain just like the root grouping does
  assert.deepEqual(manualAncestorIds(manuals, "stray"), [])
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

test("trashed manuals and their subtrees leave the visible tree", () => {
  const list = [
    { id: "kept", name: "Kept", parent_id: null, sort_key: "a1" },
    { id: "marked", name: "Marked", parent_id: null, sort_key: "a2", trashed_at: 10 },
    { id: "marked-child", name: "Child", parent_id: "marked", sort_key: "a1" },
    { id: "marked-deep", name: "Deep", parent_id: "marked-child", sort_key: "a1" },
    { id: "kept-child", name: "Kept child", parent_id: "kept", sort_key: "a1" },
  ]
  assert.deepEqual(visibleManuals(list).map((manual) => manual.id), ["kept", "kept-child"])
})

test("the trash lists trashed roots newest first and re-exposes nested rows", () => {
  const list = [
    { id: "kept", name: "Kept", parent_id: null, sort_key: "a1" },
    { id: "older", name: "Older", parent_id: null, sort_key: "a2", trashed_at: 10 },
    { id: "newer", name: "Newer", parent_id: "kept", sort_key: "a1", trashed_at: 20 },
    { id: "inside", name: "Inside", parent_id: "older", sort_key: "a1", trashed_at: 30 },
    { id: "stray-child", name: "Stray", parent_id: "older", sort_key: "a2" },
  ]
  // A trashed node inside another trashed subtree waits for its ancestor.
  assert.deepEqual(trashedRoots(list).map((manual) => manual.id), ["newer", "older"])
  // Restoring the ancestor exposes the nested row again, still trashed.
  const restored = list.map((manual) =>
    manual.id === "older" ? { ...manual, trashed_at: undefined } : manual)
  assert.deepEqual(trashedRoots(restored).map((manual) => manual.id), ["inside", "newer"])
})
