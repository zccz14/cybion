// Pure tree helpers for the unified Contexts page: the Cybion Common Context
// and the user's local Contexts render as top-level branches of one tree,
// ordered common, then local. Local siblings keep the fractional sort keys the
// drag interaction writes, the same ordering model the CTX document tree uses.

export type CommonLikeNode = {
  id: string
  name: string
  children: CommonLikeNode[]
}

export type LocalLikeContext = {
  id: string
  name: string
  parent_id: string | null
  sort_key: string
  trashed_at?: number | null
}

export type ContextDropZone = "before" | "inside" | "after"

export type ContextPlacement = { parentId: string | null; afterId: string | null }

/**
 * Sibling order: the fractional sort key first, falling back to name then id
 * for rows that predate the keys.
 */
function sortKeyOrder<T extends LocalLikeContext>(left: T, right: T): number {
  if (left.sort_key !== right.sort_key) return left.sort_key < right.sort_key ? -1 : 1
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

/**
 * Index the local contexts by parent for rendering and drag placement. Every
 * context id is present as a key; rows whose parent is not another local
 * context (a stray id or a common node) belong to the `null` (root) group.
 * Every group is sorted by `sortKeyOrder`.
 */
export function contextTreeIndex<T extends LocalLikeContext>(contexts: T[]): Map<string | null, T[]> {
  const index = new Map<string | null, T[]>()
  index.set(null, [])
  for (const context of contexts) index.set(context.id, [])
  for (const context of contexts) {
    const parent = context.parent_id !== null && index.has(context.parent_id) ? context.parent_id : null
    index.get(parent)!.push(context)
  }
  for (const siblings of index.values()) siblings.sort(sortKeyOrder)
  return index
}

function parentKeyOf<T extends LocalLikeContext>(index: Map<string | null, T[]>, context: T): string | null {
  return context.parent_id !== null && index.has(context.parent_id) ? context.parent_id : null
}

/** Ids of every context under `id`, excluding `id`, in depth-first order. */
export function collectSubtreeIds<T extends LocalLikeContext>(index: Map<string | null, T[]>, id: string): string[] {
  return (index.get(id) ?? []).flatMap((child) => [child.id, ...collectSubtreeIds(index, child.id)])
}

/**
 * Where the context currently sits: the placement a drop would need to write
 * to leave it untouched.
 */
export function contextCurrentPlacement<T extends LocalLikeContext>(index: Map<string | null, T[]>, context: T): ContextPlacement {
  const parentId = parentKeyOf(index, context)
  const siblings = index.get(parentId) ?? []
  const position = siblings.findIndex((sibling) => sibling.id === context.id)
  const previous = siblings[position - 1]
  return { parentId, afterId: previous ? previous.id : null }
}

/** Resolve a drop zone over `over` into the parent and anchor a move writes. */
export function contextPlacementFor<T extends LocalLikeContext>(
  index: Map<string | null, T[]>,
  moving: T,
  over: T,
  zone: ContextDropZone,
): ContextPlacement | null {
  if (zone === "inside") {
    const children = (index.get(over.id) ?? []).filter((child) => child.id !== moving.id)
    const last = children[children.length - 1]
    return { parentId: over.id, afterId: last ? last.id : null }
  }
  const parentId = parentKeyOf(index, over)
  if (zone === "after") {
    if (over.id === moving.id) return null
    return { parentId, afterId: over.id }
  }
  const siblings = index.get(parentId) ?? []
  const position = siblings.findIndex((sibling) => sibling.id === over.id)
  const previous = siblings
    .slice(0, position)
    .filter((sibling) => sibling.id !== moving.id)
    .pop()
  return { parentId, afterId: previous ? previous.id : null }
}

/**
 * Ancestor ids of a local context inside the given list, top-most first, so a
 * restored selection can expand its whole parent chain. Ids outside the local
 * list (stray parents) end the chain, matching how the tree renders roots.
 */
export function contextAncestorIds<T extends LocalLikeContext>(contexts: T[], id: string): string[] {
  const byId = new Map(contexts.map((context) => [context.id, context]))
  const ancestors: string[] = []
  const seen = new Set<string>([id])
  let current = byId.get(id)
  while (current && current.parent_id !== null && !seen.has(current.parent_id)) {
    const parent = byId.get(current.parent_id)
    if (!parent) break
    seen.add(parent.id)
    ancestors.unshift(parent.id)
    current = parent
  }
  return ancestors
}

/** Ancestor ids of a common-context node, top-most first. */
export function commonAncestorIds(root: CommonLikeNode, id: string): string[] {
  const visit = (node: CommonLikeNode, trail: string[]): string[] | null => {
    if (node.id === id) return trail
    for (const child of node.children) {
      const found = visit(child, [...trail, node.id])
      if (found) return found
    }
    return null
  }
  return visit(root, []) ?? []
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

/**
 * The rows a trash-free tree shows: a row stays visible while its own trash
 * marker is unset and every ancestor stays untrashed, so trashing a subtree
 * root takes the whole subtree out of the normal tree at once.
 */
export function visibleContexts<T extends LocalLikeContext>(contexts: T[]): T[] {
  const byId = new Map(contexts.map((context) => [context.id, context]))
  const hidden = new Map<string, boolean>()
  const isHidden = (context: T): boolean => {
    const cached = hidden.get(context.id)
    if (cached !== undefined) return cached
    const parent = context.parent_id === null ? undefined : byId.get(context.parent_id)
    const value = context.trashed_at != null || (parent !== undefined && isHidden(parent))
    hidden.set(context.id, value)
    return value
  }
  return contexts.filter((context) => !isHidden(context))
}

/**
 * The rows the trash section lists, newest first: trashed contexts without a
 * trashed ancestor. A marked node inside another trashed subtree joins this
 * list again only after its ancestor is restored.
 */
export function trashedRoots<T extends LocalLikeContext>(contexts: T[]): T[] {
  const byId = new Map(contexts.map((context) => [context.id, context]))
  const markedAncestor = new Map<string, boolean>()
  const hasMarkedAncestor = (context: T): boolean => {
    const cached = markedAncestor.get(context.id)
    if (cached !== undefined) return cached
    const parent = context.parent_id === null ? undefined : byId.get(context.parent_id)
    const value = parent !== undefined && (parent.trashed_at != null || hasMarkedAncestor(parent))
    markedAncestor.set(context.id, value)
    return value
  }
  return contexts
    .filter((context) => context.trashed_at != null && !hasMarkedAncestor(context))
    .sort((left, right) => (right.trashed_at ?? 0) - (left.trashed_at ?? 0) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}
