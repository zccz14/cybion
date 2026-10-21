// Draft state and auto-save rules for the Manuals editor: the page keeps one
// manual-shaped draft per open node, and these pure helpers decide when a
// draft counts as unsaved work that auto-save should flush.

export type ManualDraft = {
  id: string | null
  name: string
  description: string
  content: string
  parent_id: string | null
}

type ManualSource = {
  id: string
  name: string
  description: string
  content: string
  parent_id: string | null
}

export function manualDraft(manual?: ManualSource): ManualDraft {
  return {
    id: manual?.id ?? null,
    name: manual?.name ?? "",
    description: manual?.description ?? "",
    content: manual?.content ?? "",
    parent_id: manual?.parent_id ?? null,
  }
}

export function draftsMatch(left: ManualDraft, right: ManualDraft) {
  return left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.content === right.content &&
    left.parent_id === right.parent_id
}

// Creating a manual stays an explicit action, and an unnamed or already
// saved draft has nothing to flush; one in-flight save per manual keeps
// writes for the same record in order.
export function shouldAutosave(draft: ManualDraft | null, saved: ManualDraft | null, pending: boolean) {
  return draft !== null &&
    draft.id !== null &&
    draft.name.trim() !== "" &&
    !pending &&
    (saved === null || !draftsMatch(draft, saved))
}
