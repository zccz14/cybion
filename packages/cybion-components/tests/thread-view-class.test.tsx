import { expect, test } from "vitest"

import { threadRootClass } from "../src/lib/thread-root"

test("a host class replaces the full-page minimum height", () => {
  const root = threadRootClass("min-h-0 flex-1")
  expect(root).toContain("min-h-0")
  expect(root).not.toContain("min-h-[calc(100svh-3.5rem)]")
  expect(root).toContain("flex-1")
})

test("without a host class the view keeps the page height default", () => {
  expect(threadRootClass()).toContain("min-h-[calc(100svh-3.5rem)]")
})
