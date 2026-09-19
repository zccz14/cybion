export function composerDraftKey(userId: string, threadId: string | null) {
  const scope = threadId === null ? "new" : `thread:${encodeURIComponent(threadId)}`
  return `cybion.composer-draft:${encodeURIComponent(userId)}:${scope}`
}

export function removeSubmittedDraft(storage: Pick<Storage, "getItem" | "removeItem">, key: string, submitted: string) {
  if (storage.getItem(key) !== submitted) return false
  storage.removeItem(key)
  return true
}
