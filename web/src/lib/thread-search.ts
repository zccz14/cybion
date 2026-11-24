// Every view is one category of the same list. `shared` reads the recipient side of
// Thread sharing instead of this account's own Threads, so sharing has no list of its
// own: it is one more way to look at the one list.
export const THREAD_LIST_VIEWS = ["all", "mine", "api", "running", "failed", "blocked", "archived", "shared"] as const

export type ThreadListView = (typeof THREAD_LIST_VIEWS)[number]

export type ThreadListFilters = { view: ThreadListView; q: string; hidden: boolean }

/** Views that read Threads other people shared, not Threads this account owns. */
export function isSharedThreadListView(view: ThreadListView) {
  return view === "shared"
}

// The list opens on My Threads (`origin=web`); All stays one chip away.
export const defaultThreadListFilters: ThreadListFilters = { view: "mine", q: "", hidden: false }

// The widest selection: every origin, no search. The empty state resets here.
export const allThreadListFilters: ThreadListFilters = { view: "all", q: "", hidden: false }

// The filter selection lives in the page URL (`?view=`/`?q=`/`?hidden=`) so a thread
// list link is shareable, a reload keeps the selection, and back/forward step through
// filter changes. Only non-default values are written: `view` stays out of the URL for
// the default My Threads view, and `q` stores the raw search text while the server
// request still trims it.
export function parseThreadListFilters(params: URLSearchParams): ThreadListFilters {
  const view = params.get("view")
  return {
    view: view !== null && isThreadListView(view) ? view : defaultThreadListFilters.view,
    q: params.get("q") ?? "",
    // Hiding is a local choice inside the shared category, so it is only read there;
    // the same URL with another category selected means the same other category.
    hidden: params.get("hidden") === "1" && view === "shared",
  }
}

function isThreadListView(value: string): value is ThreadListView {
  return (THREAD_LIST_VIEWS as readonly string[]).includes(value)
}

export function serializeThreadListFilters(filters: ThreadListFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.view !== defaultThreadListFilters.view) params.set("view", filters.view)
  if (filters.q.trim() !== "") params.set("q", filters.q)
  if (filters.view === "shared" && filters.hidden) params.set("hidden", "1")
  return params
}

// Each view is one single-select preset over the orthogonal server parameters;
// search text combines with the selected view. The archived preset is the one
// scope that reads the other side of `archived_at`: every other preset lists
// the active Threads.
const viewParams = {
  all: [],
  mine: [["origin", "web"]],
  api: [["origin", "api"]],
  running: [["status", "running"]],
  failed: [["status", "failed"]],
  blocked: [["blocked", "true"]],
  archived: [["archived", "true"]],
  // The shared category has no `/api/threads` parameters: it reads another endpoint,
  // and `sharedThreadsUrl` below is the only builder that names it.
  shared: [],
} satisfies Record<ThreadListView, [string, string][]>

export function threadListSearchParams(filters: ThreadListFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of viewParams[filters.view]) params.set(key, value)
  const query = filters.q.trim()
  if (query !== "") params.set("q", query)
  return params
}

export function threadListUrl(filters: ThreadListFilters, cursor?: string | null): string {
  const params = threadListSearchParams(filters)
  if (cursor) params.set("cursor", cursor)
  const query = params.toString()
  return query === "" ? "/api/threads" : `/api/threads?${query}`
}

// The recipient side of sharing keyset-pages by sharing time. The one local option it
// takes is which half of the recipient's index to walk: the shares in the list, or the
// ones this account put aside.
export function sharedThreadsUrl(hidden: boolean, cursor?: string | null): string {
  const params = new URLSearchParams({ hidden: String(hidden) })
  if (cursor) params.set("cursor", cursor)
  return `/api/shared-threads?${params.toString()}`
}

// The empty state offers "Show all" exactly when the selection is narrower
// than every Thread, so the button can widen the list.
export function hasThreadListFilters(filters: ThreadListFilters): boolean {
  return filters.view !== "all" || filters.q.trim() !== "" || filters.hidden
}

// Two sources can send rows with the same id: a Thread shared by two owners keeps its
// own id in both, so the caller names its key instead of the list assuming uniqueness.
export function mergeThreadPages<T>(pages: T[][], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const items: T[] = []
  for (const page of pages) {
    for (const item of page) {
      const key = keyOf(item)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
  }
  return items
}
