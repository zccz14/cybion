import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { viewedImageSource } from "../src/lib/history-payload.ts"

const image = `data:image/png;base64,${"A".repeat(8)}`
const toolOutput = (output: unknown) => ({ type: "function_call_output", call_id: "call-1", output })

test("view_image outputs expose their input_image part as an openable data URL", () => {
  assert.equal(viewedImageSource(toolOutput([{ type: "input_image", image_url: image }])), image)
})

test("failed or malformed view_image outputs keep the ordinary tool output", () => {
  for (const payload of [
    toolOutput([]),
    toolOutput([{ type: "output_text", text: "no image" }]),
    toolOutput([{ type: "input_image" }]),
    toolOutput([{ type: "input_image", image_url: "" }]),
    toolOutput("view_image cannot read /tmp/missing.png"),
    { type: "function_call_output", output: 42 },
    null,
    undefined,
    "text",
  ]) {
    assert.equal(viewedImageSource(payload), null, `unexpected image for ${JSON.stringify(payload)}`)
  }
})

test("thread view renders viewed images through the shared image dialog", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  assert.match(source, /const viewed = viewedImageSource\(record\.payload\)/)
  assert.match(source, /<ViewedOutput language=\{language\} source=\{viewed\} \/>/)
})
