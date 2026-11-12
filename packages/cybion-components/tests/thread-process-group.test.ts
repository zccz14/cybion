import assert from "node:assert/strict"
import { it as test } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { ThreadProcessGroup } from "../src/components/thread-process-group"
import { formatThreadProcessDuration } from "../src/lib/thread-history"

const languages = ["zh", "en"] as const

test("process groups are native closed disclosures with bilingual counts, elapsed time and original children", () => {
  for (const language of languages) {
    const html = renderToStaticMarkup(createElement(ThreadProcessGroup, {
      language, count: 8, startedAt: 1_000, finishedAt: 1_135, running: false, children: createElement("pre", null, "Original <payload>"),
    }))
    assert.match(html, /^<details[^>]*data-slot="thread-process-group"/)
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|=|>)/)
    assert.match(html, /<summary/)
    assert.match(html, /aria-hidden="true"/)
    assert.ok(html.includes(language === "zh" ? "过程消息" : "Process messages"))
    assert.ok(html.includes(language === "zh" ? "8 条" : "8 messages"))
    assert.ok(html.includes(language === "zh" ? "运行了 00 小时 02 分钟 15 秒" : "Ran for 00h 02m 15s"))
    assert.ok(html.includes("<pre>Original &lt;payload&gt;</pre>"))
  }
  const singleton = renderToStaticMarkup(createElement(ThreadProcessGroup, { language: "en", count: 1, startedAt: 10, finishedAt: 10, running: false, children: null }))
  assert.match(singleton, />1 message</)
  assert.ok(singleton.includes("Ran for 00h 00m 00s"))
})

test("a running group renders the span up to the clock and says the run is still writing", () => {
  const startedAt = Math.floor(Date.now() / 1000) - 100
  for (const language of languages) {
    const before = Math.floor(Date.now() / 1000)
    const html = renderToStaticMarkup(createElement(ThreadProcessGroup, { language, count: 2, startedAt, finishedAt: startedAt + 5, running: true, children: null }))
    const after = Math.floor(Date.now() / 1000)
    // The label reads the span to the current second, which lands on either side of the render.
    assert.ok([before, after].some((now) => html.includes(formatThreadProcessDuration(now - startedAt, language))))
    assert.ok(html.includes(language === "zh" ? "本次执行仍在往这一组里写记录" : "this run is still writing into it"))
  }
})
