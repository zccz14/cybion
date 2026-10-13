// Pure tree helpers for the unified Contexts page: the Cybion Common Context
// and the user's local Contexts render as top-level branches of one tree,
// ordered common, then local.

export type CommonLikeNode = {
  id: string
  name: string
  children: CommonLikeNode[]
}

export type LocalLikeContext = {
  id: string
  name: string
  parent_id: string | null
}

/** Group local contexts by parent id; values sorted by name then id. */
export function groupLocalContexts<T extends LocalLikeContext>(contexts: T[]): Map<string | null, T[]> {
  const grouped = new Map<string | null, T[]>()
  for (const context of contexts) grouped.set(context.parent_id, [...(grouped.get(context.parent_id) ?? []), context])
  for (const values of grouped.values()) values.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return grouped
}

/**
 * Local contexts whose parent is not another local context (a stray id or a
 * common node) are roots of the local branch: the tree never invents parents
 * outside this list.
 */
export function localRootContexts<T extends LocalLikeContext>(contexts: T[]): T[] {
  const ids = new Set(contexts.map((context) => context.id))
  return contexts
    .filter((context) => context.parent_id === null || !ids.has(context.parent_id))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

/** Flatten a recursive tree into depth-first order. */
export function flattenTree<T extends CommonLikeNode>(root: T): T[] {
  const flattened: T[] = []
  const visit = (node: T) => {
    flattened.push(node)
    for (const child of node.children as T[]) visit(child)
  }
  visit(root)
  return flattened
}
