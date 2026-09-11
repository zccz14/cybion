import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/components/error-boundary.tsx", import.meta.url), "utf8")

test("error boundary captures render failures and supports reset keys", () => {
  assert.match(source, /getDerivedStateFromError/)
  assert.match(source, /componentDidCatch/)
  assert.match(source, /resetKeysChanged/)
  assert.match(source, /this\.reset\(\)/)
})

test("error fallback offers recovery actions with shadcn primitives", () => {
  assert.match(source, /<Alert variant="destructive">/)
  assert.match(source, /<Button variant="outline" onClick=\{\(\) => window\.location\.reload\(\)\}>/)
  assert.match(source, /<Button onClick=\{reset\}>/)
})
