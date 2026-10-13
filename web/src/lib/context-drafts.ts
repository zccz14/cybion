// Draft state and auto-save rules for the Contexts editor: the page keeps one
// context-shaped draft per open node, and these pure helpers decide when a
// draft counts as unsaved work that auto-save should flush.

export type ContextDraft = {
  id: string | null
  name: string
  description: string
  content: string
  parent_id: string | null
}

type ContextSource = {
  id: string
  name: string
  description: string
  content: string
  parent_id: string | null
}

export function contextDraft(context?: ContextSource): ContextDraft {
  return {
    id: context?.id ?? null,
    name: context?.name ?? "",
    description: context?.description ?? "",
    content: context?.content ?? "",
    parent_id: context?.parent_id ?? null,
  }
}

export function draftsMatch(left: ContextDraft, right: ContextDraft) {
  return left.id === right.id &&
    left.name === right.name &&
    left.description === right.description &&
    left.content === right.content &&
    left.parent_id === right.parent_id
}

// Creating a context stays an explicit action, and an unnamed or already
// saved draft has nothing to flush; one in-flight save per context keeps
// writes for the same record in order.
export function shouldAutosave(draft: ContextDraft | null, saved: ContextDraft | null, pending: boolean) {
  return draft !== null &&
    draft.id !== null &&
    draft.name.trim() !== "" &&
    !pending &&
    (saved === null || !draftsMatch(draft, saved))
}
