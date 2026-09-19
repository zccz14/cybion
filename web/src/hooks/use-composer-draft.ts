import { useCallback, useEffect, useRef, useState } from "react"
import { composerDraftKey, removeSubmittedDraft } from "@/lib/composer-drafts"

type Draft = { input: string; storageError: boolean }
const draftEvent = "cybion:composer-draft"
function notifyDraft(key: string, input: string) {
  window.dispatchEvent(new CustomEvent(draftEvent, { detail: { key, input } }))
}

function readDraft(key: string): Draft {
  try {
    return { input: localStorage.getItem(key) ?? "", storageError: false }
  } catch {
    // RECOVERY: storage can be unavailable; keep an editable in-memory draft and
    // expose the persistence failure instead of blocking the composer.
    return { input: "", storageError: true }
  }
}

export function useComposerDraft(userId: string, threadId: string | null) {
  // INVARIANT: the workspace is keyed by verified user ID and the conversation by
  // route, so a late submission retains its original immutable draft key.
  const key = composerDraftKey(userId, threadId)
  const [draft, setDraft] = useState(() => readDraft(key))
  const currentInput = useRef(draft.input)
  const setInput = useCallback((input: string) => {
    currentInput.current = input
    let storageError = false
    try {
      if (input === "") localStorage.removeItem(key)
      else localStorage.setItem(key, input)
      notifyDraft(key, input)
    } catch {
      // RECOVERY: preserve typed text in memory and show that refresh is unsafe.
      storageError = true
    }
    setDraft({ input, storageError })
  }, [key])
  const seed = useCallback((input: string) => {
    if (currentInput.current === "") setInput(input)
  }, [setInput])
  const clearSubmitted = useCallback((submitted: string) => {
    let storageError = false
    let removed = false
    try {
      removed = removeSubmittedDraft(localStorage, key, submitted)
      if (removed) notifyDraft(key, "")
    } catch {
      // RECOVERY: a successful send still clears matching in-memory text, but the
      // warning makes a failed persistent cleanup visible to the user.
      storageError = true
    }
    if (currentInput.current === submitted) {
      currentInput.current = ""
      setDraft((current) => ({ input: "", storageError: storageError || (!removed && current.storageError) }))
    } else if (storageError) {
      setDraft((current) => ({ ...current, storageError: true }))
    }
  }, [key])
  useEffect(() => {
    const accept = (input: string) => {
      currentInput.current = input
      setDraft({ input, storageError: false })
    }
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) accept(event.newValue ?? "")
    }
    const localChanged = (event: Event) => {
      const { key: changedKey, input } = (event as CustomEvent<{ key: string; input: string }>).detail
      if (changedKey === key) accept(input)
    }
    window.addEventListener("storage", changed)
    window.addEventListener(draftEvent, localChanged)
    return () => {
      window.removeEventListener("storage", changed)
      window.removeEventListener(draftEvent, localChanged)
    }
  }, [key])
  return { ...draft, setInput, seed, clearSubmitted, clear: () => setInput("") }
}
