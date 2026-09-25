import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { composerAction, handleChatInputKeyDown } from "../src/lib/chat-input.ts"

type ChatKeyEvent = Parameters<typeof handleChatInputKeyDown>[0]

function press(overrides: Partial<ChatKeyEvent> = {}) {
  let prevented = 0
  let submitted = 0
  const event = {
    key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault: () => { prevented += 1 },
    currentTarget: { form: { requestSubmit: () => { submitted += 1 } } },
    ...overrides,
  } as ChatKeyEvent
  handleChatInputKeyDown(event)
  return { prevented, submitted }
}

test("plain Enter submits through the form once without inserting a newline", () => {
  assert.deepEqual(press(), { prevented: 1, submitted: 1 })
})

test("Shift+Enter stays a newline and modified Enter no longer sends", () => {
  for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
    assert.deepEqual(press({ [modifier]: true }), { prevented: 0, submitted: 0 })
  }
})

test("other keys keep their normal input behavior", () => {
  for (const key of ["a", "Escape", "Tab"]) {
    assert.deepEqual(press({ key }), { prevented: 0, submitted: 0 })
  }
})

test("IME confirmation including the composition-end boundary never sends", () => {
  for (const [isComposing, keyCode] of [[true, 13], [true, 229], [false, 229]] as const) {
    assert.deepEqual(press({ nativeEvent: { isComposing, keyCode } as KeyboardEvent }), { prevented: 0, submitted: 0 })
  }
})

test("holding Enter does not submit again or insert a newline", () => {
  assert.deepEqual(press({ repeat: true }), { prevented: 1, submitted: 0 })
})

test("the composer action slot merges send, continue, and stop", () => {
  assert.equal(composerAction("hello", false), "send")
  assert.equal(composerAction("hello", true), "send")
  assert.equal(composerAction("", false), "continue")
  assert.equal(composerAction("", true), "stop")
  assert.equal(composerAction("   ", false), "continue")
  assert.equal(composerAction("   ", true), "stop")
})

test("both composers use the shared handler and drop shortcut hint copy", () => {
  const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
  for (const id of ["new-thread-input", "thread-input"]) {
    const composer = source.split("\n").find((line) => line.includes(`<Textarea id="${id}"`))
    assert.ok(composer?.includes("onKeyDown={handleChatInputKeyDown}"))
  }
  assert.doesNotMatch(source, /sendShortcut|startThreadShortcut/)
  assert.doesNotMatch(source, /Shift \+ Enter|⌘ \/ Ctrl \+ Enter/)
})
