export const THREAD_LIST_VIEWS = ["all", "mine", "api", "running", "failed"] as const

export type ThreadListView = (typeof THREAD_LIST_VIEWS)[number]

export type ThreadListFilters = { view: ThreadListView; q: string }

// The list opens on My Threads (`origin=web`); All stays one chip away.
export const defaultThreadListFilters: ThreadListFilters = { view: "mine", q: "" }

// The widest selection: every origin, no search. The empty state resets here.
export const allThreadListFilters: ThreadListFilters = { view: "all", q: "" }

// The filter selection lives in the page URL (`?view=`/`?q=`) so a thread
// list link is shareable, a reload keeps the selection, and back/forward
// step through filter changes. Only non-default values are written: `view`
// stays out of the URL for the default My Threads view, and `q` stores the
// raw search text while the server request still trims it.
export function parseThreadListFilters(params: URLSearchParams): ThreadListFilters {
  const view = params.get("view")
  return {
    view: view !== null && isThreadListView(view) ? view : defaultThreadListFilters.view,
    q: params.get("q") ?? "",
  }
}

function isThreadListView(value: string): value is ThreadListView {
  return (THREAD_LIST_VIEWS as readonly string[]).includes(value)
}

export function serializeThreadListFilters(filters: ThreadListFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.view !== defaultThreadListFilters.view) params.set("view", filters.view)
  if (filters.q.trim() !== "") params.set("q", filters.q)
  return params
}

// Each view is one single-select preset over the orthogonal server parameters;
// search text combines with the selected view.
const viewParams = {
  all: [],
  mine: [["origin", "web"]],
  api: [["origin", "api"]],
  running: [["status", "running"]],
  failed: [["status", "failed"]],
} satisfies Record<ThreadListView, [string, string][]>

export function threadListSearchParams(filters: ThreadListFilters): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of viewParams[filters.view]) params.set(key, value)
  const query = filters.q.trim()
  if (query !== "") params.set("q", query)
  return params
}

export function threadListUrl(filters: ThreadListFilters, cursor?: string | null, archived = false): string {
  const params = threadListSearchParams(filters)
  if (archived) params.set("archived", "true")
  if (cursor) params.set("cursor", cursor)
  const query = params.toString()
  return query === "" ? "/api/threads" : `/api/threads?${query}`
}

// The empty state offers "Show all" exactly when the selection is narrower
// than every Thread, so the button can widen the list.
export function hasThreadListFilters(filters: ThreadListFilters): boolean {
  return filters.view !== "all" || filters.q.trim() !== ""
}

export function mergeThreadPages<T extends { id: string }>(pages: T[][]): T[] {
  const seen = new Set<string>()
  const items: T[] = []
  for (const page of pages) {
    for (const item of page) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }
  return items
}
