import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { ComposerAttach } from "../src/components/composer-attach"
import { ComposerAttachments } from "../src/components/composer-attachments"
import { ComposerFileNotice, ComposerLengthNotice } from "../src/components/composer-file-notice"

afterEach(cleanup)

test("[+] opens the file picker and hands the picked files back whole", () => {
  const onFiles = vi.fn()
  const { container } = render(<ComposerAttach language="zh" disabled={false} onFiles={onFiles} />)
  const picker = container.querySelector("input[type=file]") as HTMLInputElement
  expect(picker.multiple).toBe(true)
  expect(picker.className).toContain("hidden")
  const click = vi.spyOn(picker, "click").mockImplementation(() => undefined)
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }))
  expect(click).toHaveBeenCalledTimes(1)
  const file = new File(["# notes"], "notes.md", { type: "text/markdown" })
  fireEvent.change(picker, { target: { files: [file] } })
  expect(onFiles).toHaveBeenCalledWith([file])
  // The field is cleared so picking the same file twice still fires a change.
  expect(picker.value).toBe("")
})

test("the attachment button is disabled while the composer is busy", () => {
  render(<ComposerAttach language="en" disabled onFiles={() => undefined} />)
  expect((screen.getByRole("button", { name: "Add an attachment" }) as HTMLButtonElement).disabled).toBe(true)
})

test("a text attachment shows its name, size and truncation, and can be removed", () => {
  const remove = vi.fn()
  const { container } = render(<ComposerAttachments
    language="zh"
    images={[]}
    files={[
      { name: "report.csv", bytes: 4096, text: "a,b", truncated: false },
      { name: "app.log", bytes: 900, text: "line", truncated: true },
    ]}
    onRemove={() => undefined}
    onRemoveFile={remove}
  />)
  expect(container.textContent).toContain("report.csv")
  expect(container.textContent).toContain("4.0 KB")
  expect(container.textContent).toContain("900 B · 已截断")
  fireEvent.click(screen.getByRole("button", { name: "移除附件: report.csv" }))
  expect(remove).toHaveBeenCalledWith(0)
})

test("refused files are named with the reason instead of disappearing", () => {
  const { container } = render(<ComposerFileNotice language="zh" skipped={[
    { name: "report.pdf", reason: "type" },
    { name: "dump.zip", reason: "type" },
    { name: "huge.log", reason: "size" },
  ]} />)
  const lines = Array.from(container.querySelectorAll("li"), (line) => line.textContent)
  expect(lines).toEqual([
    "未添加： report.pdf、dump.zip（不是图片、音频或文本文件）",
    "未添加： huge.log（超过 2 MB）",
  ])
})

test("nothing is said when every file was attached", () => {
  const { container } = render(<ComposerFileNotice language="en" skipped={[]} />)
  expect(container.innerHTML).toBe("")
})

test("an input past the Controller's limit is explained before sending", () => {
  const { container } = render(<ComposerLengthNotice language="en" chars={120000} limit={100000} />)
  expect(container.textContent).toContain("reach 120000 characters; the limit is 100000")
})
