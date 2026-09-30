import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { screenshotImageSource } from "../src/lib/history-payload.ts"

const png = `iVBORw0KGgo${"A".repeat(64)}`
const toolOutput = (result: unknown) => ({ type: "function_call_output", call_id: "call-1", output: JSON.stringify(result) })

test("ledger-marked screenshot outputs become openable PNG data URLs", () => {
  assert.equal(screenshotImageSource(toolOutput({ data: png })), `data:image/png;base64,${png}`)
})

test("failed, malformed or non-PNG screenshot results keep the ordinary tool output", () => {
  for (const payload of [
    toolOutput({ error: "screenshot failed: no display" }),
    toolOutput({ data: "bm90IGEgcG5n" }),
    toolOutput({ data: "" }),
    toolOutput({}),
    { type: "function_call_output", call_id: "call-1", output: "screenshot failed: no display" },
    { type: "function_call_output", output: 42 },
    null,
    undefined,
    "text",
  ]) {
    assert.equal(screenshotImageSource(payload), null, `unexpected image for ${JSON.stringify(payload)}`)
  }
})

test("thread view renders marked screenshots through the shared image dialog", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(source, /const screenshot = record\.screenshot \? screenshotImageSource\(record\.payload\) : null/)
  assert.match(source, /<ScreenshotOutput language=\{language\} source=\{screenshot\} \/>/)
  assert.match(source, /previous\.record\.screenshot === next\.record\.screenshot/)
})
