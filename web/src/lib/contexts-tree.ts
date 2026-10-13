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
