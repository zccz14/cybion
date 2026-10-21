// Pure tree helpers for the unified Manuals page: the Cybion Common Manual
// and the user's local Manuals render as top-level branches of one tree,
// ordered common, then local. Local siblings keep the fractional sort keys the
// drag interaction writes, the same ordering model the CTX document tree uses.

export type CommonLikeNode = {
  id: string
  name: string
  children: CommonLikeNode[]
}

export type LocalLikeManual = {
  id: string
  name: string
  parent_id: string | null
  sort_key: string
  trashed_at?: number | null
}

export type ManualDropZone = "before" | "inside" | "after"

export type ManualPlacement = { parentId: string | null; afterId: string | null }

/**
 * Sibling order: the fractional sort key first, falling back to name then id
 * for rows that predate the keys.
 */
function sortKeyOrder<T extends LocalLikeManual>(left: T, right: T): number {
  if (left.sort_key !== right.sort_key) return left.sort_key < right.sort_key ? -1 : 1
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
}

/**
 * Index the local manuals by parent for rendering and drag placement. Every
 * manual id is present as a key; rows whose parent is not another local
 * manual (a stray id or a common node) belong to the `null` (root) group.
 * Every group is sorted by `sortKeyOrder`.
 */
export function manualTreeIndex<T extends LocalLikeManual>(manuals: T[]): Map<string | null, T[]> {
  const index = new Map<string | null, T[]>()
  index.set(null, [])
  for (const manual of manuals) index.set(manual.id, [])
  for (const manual of manuals) {
    const parent = manual.parent_id !== null && index.has(manual.parent_id) ? manual.parent_id : null
    index.get(parent)!.push(manual)
  }
  for (const siblings of index.values()) siblings.sort(sortKeyOrder)
  return index
}

function parentKeyOf<T extends LocalLikeManual>(index: Map<string | null, T[]>, manual: T): string | null {
  return manual.parent_id !== null && index.has(manual.parent_id) ? manual.parent_id : null
}

/** Ids of every manual under `id`, excluding `id`, in depth-first order. */
export function collectSubtreeIds<T extends LocalLikeManual>(index: Map<string | null, T[]>, id: string): string[] {
  return (index.get(id) ?? []).flatMap((child) => [child.id, ...collectSubtreeIds(index, child.id)])
}

/**
 * Where the manual currently sits: the placement a drop would need to write
 * to leave it untouched.
 */
export function manualCurrentPlacement<T extends LocalLikeManual>(index: Map<string | null, T[]>, manual: T): ManualPlacement {
  const parentId = parentKeyOf(index, manual)
  const siblings = index.get(parentId) ?? []
  const position = siblings.findIndex((sibling) => sibling.id === manual.id)
  const previous = siblings[position - 1]
  return { parentId, afterId: previous ? previous.id : null }
}

/** Resolve a drop zone over `over` into the parent and anchor a move writes. */
export function manualPlacementFor<T extends LocalLikeManual>(
  index: Map<string | null, T[]>,
  moving: T,
  over: T,
  zone: ManualDropZone,
): ManualPlacement | null {
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
 * Ancestor ids of a local manual inside the given list, top-most first, so a
 * restored selection can expand its whole parent chain. Ids outside the local
 * list (stray parents) end the chain, matching how the tree renders roots.
 */
export function manualAncestorIds<T extends LocalLikeManual>(manuals: T[], id: string): string[] {
  const byId = new Map(manuals.map((manual) => [manual.id, manual]))
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

/** Ancestor ids of a common-manual node, top-most first. */
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
export function visibleManuals<T extends LocalLikeManual>(manuals: T[]): T[] {
  const byId = new Map(manuals.map((manual) => [manual.id, manual]))
  const hidden = new Map<string, boolean>()
  const isHidden = (manual: T): boolean => {
    const cached = hidden.get(manual.id)
    if (cached !== undefined) return cached
    const parent = manual.parent_id === null ? undefined : byId.get(manual.parent_id)
    const value = manual.trashed_at != null || (parent !== undefined && isHidden(parent))
    hidden.set(manual.id, value)
    return value
  }
  return manuals.filter((manual) => !isHidden(manual))
}

/**
 * The rows the trash section lists, newest first: trashed manuals without a
 * trashed ancestor. A marked node inside another trashed subtree joins this
 * list again only after its ancestor is restored.
 */
export function trashedRoots<T extends LocalLikeManual>(manuals: T[]): T[] {
  const byId = new Map(manuals.map((manual) => [manual.id, manual]))
  const markedAncestor = new Map<string, boolean>()
  const hasMarkedAncestor = (manual: T): boolean => {
    const cached = markedAncestor.get(manual.id)
    if (cached !== undefined) return cached
    const parent = manual.parent_id === null ? undefined : byId.get(manual.parent_id)
    const value = parent !== undefined && (parent.trashed_at != null || hasMarkedAncestor(parent))
    markedAncestor.set(manual.id, value)
    return value
  }
  return manuals
    .filter((manual) => manual.trashed_at != null && !hasMarkedAncestor(manual))
    .sort((left, right) => (right.trashed_at ?? 0) - (left.trashed_at ?? 0) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}
