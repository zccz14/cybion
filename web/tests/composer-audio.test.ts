import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { createTestServer } from "./vite-server.ts"

const vite = { server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" } as const

test("the composer keeps one microphone button and turns it into send and cancel while recording", async () => {
  const server = await createTestServer(vite)
  try {
    const { ComposerAudio } = await server.ssrLoadModule("/src/components/composer-audio.tsx")
    const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(ComposerAudio, {
      language: "zh",
      recording: false,
      disabled: false,
      onStart: async () => true,
      onSend: () => undefined,
      onCancel: () => undefined,
      ...props,
    }))
    const idle = render({})
    assert.ok(idle.includes('aria-label="录制语音"'))
    // The control is an icon button: it carries no visible label of its own.
    assert.ok(!idle.includes(">录制音频<"))
    assert.ok(!idle.includes("添加音频"))
    assert.ok(!idle.includes('type="file"'))
    const recording = render({ recording: true })
    assert.ok(recording.includes('aria-label="发送语音"'))
    assert.ok(recording.includes('aria-label="取消录音"'))
    assert.ok(!recording.includes('aria-label="录制语音"'))
  } finally {
    await server.close()
  }
})

test("audio waiting to be sent stays with the pasted images, not in the toolbar", async () => {
  const server = await createTestServer(vite)
  try {
    const { ComposerAttachments } = await server.ssrLoadModule("/src/components/composer-attachments.tsx")
    const markup = renderToStaticMarkup(createElement(ComposerAttachments, {
      language: "zh",
      images: [],
      audios: ["data:audio/webm;base64," + "A".repeat(4096)],
      onRemove: () => undefined,
      onRemoveAudio: () => undefined,
    }))
    assert.ok(markup.includes("音频 · 3 KB"))
    assert.ok(markup.includes('aria-label="移除音频"'))
    assert.equal(renderToStaticMarkup(createElement(ComposerAttachments, { language: "zh", images: [], audios: [], onRemove: () => undefined })), "")
  } finally {
    await server.close()
  }
})
