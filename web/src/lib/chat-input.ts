import type { KeyboardEvent } from "react"

export function handleChatInputKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
  // COMPATIBILITY (Cybion web): IME confirmation can end composition before keydown.
  // Remove the keyCode check once supported browsers reliably mark that keydown
  // as composing; verify with real IME confirmation and the boundary regression test.
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
  event.preventDefault()
  if (!event.repeat) event.currentTarget.form?.requestSubmit()
}

// One action slot: Send for a non-empty draft, otherwise Continue on an idle
// thread and Stop on a running one.
export function composerAction(input: string, running: boolean) {
  if (input.trim()) return "send"
  return running ? "stop" : "continue"
}
