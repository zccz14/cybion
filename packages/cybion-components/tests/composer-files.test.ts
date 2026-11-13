import { describe, expect, it } from "vitest"

import {
  composeComposerInput, attachmentBlock, composerFileChars, isTextPickedFile, readComposerFile,
  splitPickedFiles, type ComposerFile,
} from "../src/lib/composer-files"

function picked(name: string, type = "", content = "hello") {
  return new File([content], name, { type })
}

const notes: ComposerFile = { name: "notes.md", bytes: 2048, text: "# 记录\n- 一条", truncated: false }

describe("what the attachment button can take", () => {
  it("splits a pick into images, audio, text and the rest by type and extension", () => {
    const routed = splitPickedFiles([
      picked("shot.png", "image/png"),
      picked("recording.webm", "audio/webm"),
      picked("main.rs", "", "fn main() {}"),
      picked("data.json", "application/json"),
      picked("logo.svg", "image/svg+xml"),
      picked("report.pdf", "application/pdf"),
      picked("archive.zip", ""),
    ])
    expect(routed.images.map((file) => file.name)).toEqual(["shot.png"])
    expect(routed.audios.map((file) => file.name)).toEqual(["recording.webm"])
    // SVG is markup, so it travels as text instead of being re-encoded into a bitmap.
    expect(routed.texts.map((file) => file.name)).toEqual(["main.rs", "data.json", "logo.svg"])
    expect(routed.unsupported).toEqual(["report.pdf", "archive.zip"])
  })

  it("reads a declared non-text type as unsupported even when the extension looks like text", () => {
    expect(isTextPickedFile(picked("notes.txt", "application/pdf"))).toBe(false)
    expect(isTextPickedFile(picked("notes.txt"))).toBe(true)
    expect(isTextPickedFile(picked("NOTES", "text/plain"))).toBe(true)
  })
})

describe("reading a text attachment", () => {
  it("keeps the content and the size on disk", async () => {
    const read = await readComposerFile(picked("app.log", "", "line one\nline two"), 10_000)
    expect(read).toMatchObject({ name: "app.log", text: "line one\nline two", truncated: false })
    expect(read?.bytes).toBeGreaterThan(0)
  })

  it("cuts to the room left in the message and says so", async () => {
    const read = await readComposerFile(picked("big.csv", "", "x".repeat(500)), 120)
    expect(read?.text).toHaveLength(120)
    expect(read?.truncated).toBe(true)
  })

  it("never exceeds one attachment's own ceiling", async () => {
    const read = await readComposerFile(picked("huge.txt", "", "y".repeat(40_000)), 60_000)
    expect(read?.text).toHaveLength(30_000)
    expect(read?.truncated).toBe(true)
  })

  it("takes nothing when there is no room at all", async () => {
    expect(await readComposerFile(picked("late.md", "", "text"), 0)).toBeNull()
  })
})

describe("what the model receives", () => {
  it("names the file, its size and the cut in the language of the console", () => {
    expect(attachmentBlock(notes, "zh")).toBe("附件：notes.md（2.0 KB）\n```markdown\n# 记录\n- 一条\n```")
    expect(attachmentBlock({ ...notes, truncated: true }, "en")).toBe("Attachment: notes.md (2.0 KB, first 9 characters)\n```markdown\n# 记录\n- 一条\n```")
  })

  it("uses a fence longer than any backtick run inside the file", () => {
    const block = attachmentBlock({ name: "readme.md", bytes: 10, text: "```sh\nmake\n```", truncated: false }, "en")
    expect(block).toContain("\n````markdown\n```sh\nmake\n```\n````")
  })

  it("appends every attachment after the typed text", () => {
    expect(composeComposerInput("看看这个", [notes], "zh")).toBe("看看这个\n\n附件：notes.md（2.0 KB）\n```markdown\n# 记录\n- 一条\n```")
    expect(composeComposerInput("  看看这个 \n", [], "zh")).toBe("看看这个")
  })

  it("sends an attachment-only message without a leading blank line", () => {
    expect(composeComposerInput("   ", [notes], "en").startsWith("Attachment: notes.md")).toBe(true)
  })

  it("counts the characters that fill the message budget", () => {
    expect(composerFileChars([notes, { ...notes, text: "abc" }])).toBe(notes.text.length + 3)
  })
})
