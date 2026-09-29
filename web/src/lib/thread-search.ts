export type ThreadListView = "all" | "mine" | "api" | "running" | "failed"

export type ThreadListFilters = { view: ThreadListView; q: string }

export const defaultThreadListFilters: ThreadListFilters = { view: "all", q: "" }

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

export function threadListUrl(filters: ThreadListFilters): string {
  const query = threadListSearchParams(filters).toString()
  return query === "" ? "/api/threads" : `/api/threads?${query}`
}

export function hasThreadListFilters(filters: ThreadListFilters): boolean {
  return filters.view !== "all" || filters.q.trim() !== ""
}
