import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { audioDurationLabel } from "../src/lib/composer-audio.ts"
import { createTestServer } from "./vite-server.ts"

test("voice bars label their length and leave an unknown one open", () => {
  assert.equal(audioDurationLabel(null), "—")
  assert.equal(audioDurationLabel(Number.POSITIVE_INFINITY), "—")
  assert.equal(audioDurationLabel(0), "0:00")
  assert.equal(audioDurationLabel(3.4), "0:03")
  assert.equal(audioDurationLabel(75), "1:15")
})

test("a sent voice message renders as one playable bar instead of text", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" })
  try {
    const { UserInputMessage } = await server.ssrLoadModule("/src/components/user-input-message.tsx")
    const voice = "data:audio/webm;base64,CCCC"
    const text = (payload: unknown) => renderToStaticMarkup(createElement(UserInputMessage, { language: "zh", payload, footer: "#1 · 12:00:00" }))
    const audioOnly = text({ role: "user", content: [{ type: "input_audio", audio_url: voice }] })
    assert.ok(audioOnly.includes('data-slot="audio-message"'))
    assert.ok(audioOnly.includes('aria-label="播放语音"'))
    assert.ok(audioOnly.includes('aria-pressed="false"'))
    assert.ok(audioOnly.includes(voice))
    assert.ok(!audioOnly.includes("—".repeat(5)))
    // A text-only input never grows a voice bar.
    assert.ok(!text({ role: "user", content: "只有文字" }).includes('data-slot="audio-message"'))
    // Stored history only carries the object reference: the bar renders right
    // away, disabled until the bytes arrive, and remembers what to fetch.
    const reference = "b".repeat(64)
    const stored = text({ role: "user", content: [{ type: "input_audio", audio_ref: reference, media_type: "audio/webm" }] })
    assert.ok(stored.includes('data-audio-ref="' + reference + '"'))
    assert.match(stored, /<button[^>]*disabled/)
    assert.ok(stored.includes('aria-label="播放语音"'))
    // The first-pass transcript shows up as a subtitle under the bar, so the
    // words are readable without pressing play.
    const referenceWithNote = "d".repeat(64)
    const subtitled = text({
      role: "user",
      content: [{
        type: "input_audio",
        audio_ref: referenceWithNote,
        media_type: "audio/webm",
        provisional_note: `[audio attachment ref=${referenceWithNote} type=audio/webm] provisional transcript (qwen-audio-3.0-asr-flash):\n记得把发布也跟上\nCall normai_audio_transcription with this ref and prompt/keywords to re-extract terms the first pass missed.`,
      }],
    })
    assert.ok(subtitled.includes('data-slot="audio-transcript"'))
    assert.ok(subtitled.includes("记得把发布也跟上"))
    assert.ok(subtitled.includes("qwen-audio-3.0-asr-flash"))
    assert.ok(subtitled.indexOf('data-slot="audio-message"') < subtitled.indexOf("记得把发布也跟上"))
    // No transcript, no subtitle.
    assert.ok(!audioOnly.includes('data-slot="audio-transcript"'))
  } finally {
    await server.close()
  }
})
