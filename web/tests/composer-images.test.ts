import assert from "node:assert/strict"
import test from "node:test"
import { pastedImageFiles } from "../src/lib/composer-images.ts"

function clipboardItem(kind: string, type: string, file: unknown) {
  return { kind, type, getAsFile: () => file }
}

test("paste collects every image file and ignores text, other kinds and empty slots", () => {
  const png = { name: "screenshot.png" }
  const jpeg = { name: "photo.jpg" }
  const clipboard = {
    items: [
      clipboardItem("string", "text/plain", null),
      clipboardItem("file", "image/png", png),
      clipboardItem("file", "application/pdf", { name: "report.pdf" }),
      clipboardItem("file", "image/jpeg", jpeg),
      clipboardItem("file", "image/png", null),
    ],
  } as unknown as DataTransfer
  assert.deepEqual(pastedImageFiles(clipboard), [png, jpeg])
  assert.deepEqual(pastedImageFiles(null), [])
})
