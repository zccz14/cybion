import assert from "node:assert/strict"
import test from "node:test"

import { matchesThreadQuery } from "../src/lib/thread-search.ts"

const thread = { title: "修复 Worker 配对与导航" }

test("empty queries match every thread", () => {
  assert.equal(matchesThreadQuery(thread, ""), true)
  assert.equal(matchesThreadQuery(thread, "   "), true)
})

test("thread titles match case-insensitively", () => {
  assert.equal(matchesThreadQuery(thread, "worker"), true)
  assert.equal(matchesThreadQuery(thread, "WORKER"), true)
})

test("thread titles match partial text", () => {
  assert.equal(matchesThreadQuery(thread, "配对"), true)
  assert.equal(matchesThreadQuery(thread, "导航"), true)
})

test("non-matching queries are excluded", () => {
  assert.equal(matchesThreadQuery(thread, "不存在的关键词"), false)
  assert.equal(matchesThreadQuery(thread, "navigation"), false)
})
