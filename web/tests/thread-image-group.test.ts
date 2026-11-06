import assert from "node:assert/strict"
import test from "node:test"
import { readPackageSource } from "./package-source.ts"

test("the app thread view renders generated images inline", () => {
  const source = readPackageSource("components/history-message.tsx")
  assert.match(source, /const imageSource = generatedImageSource\(record\.payload\)/)
  assert.match(source, /<img src=\{imageSource\} alt=\{t\("generatedImage"\)\}/)
})
