import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { composeComposerInput, splitPickedFiles } from "@zccz14/cybion-components/logic"
import { readPackageSource } from "./package-source.ts"

test("one pick is split into images, audio, text files and the rest", () => {
  const routed = splitPickedFiles([
    new File(["png"], "shot.png", { type: "image/png" }),
    new File(["wav"], "clip.wav", { type: "audio/wav" }),
    new File(["fn main() {}"], "main.rs", { type: "" }),
    new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
  ])
  assert.deepEqual(routed.images.map((file) => file.name), ["shot.png"])
  assert.deepEqual(routed.audios.map((file) => file.name), ["clip.wav"])
  assert.deepEqual(routed.texts.map((file) => file.name), ["main.rs"])
  assert.deepEqual(routed.unsupported, ["report.pdf"])
})

test("an attachment travels as a fenced block after the typed text", () => {
  const input = composeComposerInput("看看这个", [{ name: "notes.md", bytes: 2048, text: "hi", truncated: false }], "zh")
  assert.equal(input, "看看这个\n\n附件：notes.md（2.0 KB）\n```markdown\nhi\n```")
  assert.equal(composeComposerInput("看看这个", [], "zh"), "看看这个")
})

test("both composers send the composed input and clear the draft they really typed", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  const view = readPackageSource("thread-view.tsx")
  for (const source of [main, view]) {
    // The [+] entry point is wired in both, through the same router.
    assert.match(source, /<ComposerAttach language=\{language\}[^>]*onFiles=\{attach\}/)
    assert.match(source, /useComposerAttach\(\{ images: attachments, audio, files \}\)/)
    // Attachments ride inside the message text...
    assert.match(source, /composeComposerInput\(input, files\.files, language\)/)
    assert.match(source, /input: composed/)
    // ...so the draft that clears is the typed text, not the composed one.
    assert.match(source, /clearSubmitted\((payload|submitted)\.draft\)/)
    // Refused files and an oversized message are both visible before sending.
    assert.match(source, /<ComposerFileNotice language=\{language\} skipped=\{files\.skipped\} \/>/)
    assert.match(source, /<ComposerLengthNotice language=\{language\} chars=\{composed\.length\} limit=\{maxInputChars\} \/>/)
  }
})
