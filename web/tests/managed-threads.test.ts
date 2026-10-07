import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

test("hosted UI requests one Auth Mini token for every downstream service", () => {
  assert.match(source, /authMiniBaseUrl="https:\/\/auth\.ntnl\.io"/)
  assert.match(source, /new Set\(\["cybion\.ntnl\.io", "linkit\.ntnl\.io", "openai\.ntnl\.io", "ctx\.ntnl\.io", "normai\.ntnl\.io", window\.location\.hostname\]\)/)
  assert.match(source, /audiences=\{AUTH_AUDIENCES\}/)
  assert.doesNotMatch(source, /audience="cybion\.ntnl\.io"/)
  assert.match(source, /autoRedirectToLogin/)
})

test("threads are the only conversation hierarchy", () => {
  assert.match(source, /HashRouter/)
  assert.match(source, /path="\/threads"/)
  assert.match(source, /path="\/threads\/:threadId"/)
  assert.match(source, /\/api\/threads/)
  assert.doesNotMatch(source, /subthread/i)
  assert.doesNotMatch(source, /main_thread/i)
  assert.doesNotMatch(source, /GoalState/)
})

test("new thread preparation waits for the first message before creating a thread", () => {
  assert.match(source, /path="\/threads" element=\{<ThreadsHomePage/)
  assert.match(source, /path="\/threads\/new" element=\{<NewThreadPage/)
  assert.match(source, /function NewThreadPage\(/)
  assert.match(source, /\/api\/threads\/start/)
  assert.match(source, /newThreadPrompt/)
})

test("CTX documents join threads through a user-scoped API key", () => {
  assert.match(source, /ctxIntegrationTitle/)
  assert.match(source, /\/api\/integrations\/ctx/)
  assert.match(source, /https:\/\/ctx\.ntnl\.io\/#\/documents\//)
})

test("contexts are managed through a progressive disclosure tree", () => {
  assert.match(source, /path="\/contexts" element=\{<ContextsPage/)
  assert.match(source, /\/api\/contexts/)
  assert.match(source, /<ul role="tree"/)
  assert.match(source, /parent_id/)
  assert.match(source, /contextContent/)
})

test("every thread renders through the shared chat primitives", () => {
  assert.match(source, /<MessageScrollerProvider autoScroll defaultScrollPosition="end">/)
  assert.match(source, /<MessageScrollerViewport>/)
  assert.match(source, /<MessageScrollerContent/)
  assert.match(source, /<MessageScrollerButton behavior="auto"/)
  assert.match(source, /<Message align="end">/)
  assert.match(source, /record\.kind === "input"/)
  assert.doesNotMatch(source, /record\.(request_input_id|role|content|visible)/)
  assert.doesNotMatch(source, /<MessageAvatar/)
  assert.doesNotMatch(source, /<MessageHeader/)
})

test("history renders reasoning summaries", () => {
  assert.match(source, /recordReasoning: "推理 \(Reasoning\)"/)
  assert.match(source, /function isReasoningRecord\(record: HistoryRecord\)/)
  assert.match(source, /function reasoningSummary\(record: HistoryRecord\)/)
})

test("thread settings live in the composer popover while native tools are always injected", () => {
  const popover = readFileSync(new URL("../src/components/thread-settings-popover.tsx", import.meta.url), "utf8")
  assert.match(source, /import \{ ThreadSettingsPopover, modelGroups, modelSelection, parseModelSelection \} from "@\/components\/thread-settings-popover"/)
  assert.equal(source.match(/<ThreadSettingsPopover /g)?.length, 2)
  assert.match(popover, /REASONING_EFFORTS = \["low", "medium", "high", "xhigh", "max"\]/)
  assert.match(popover, /ZapIcon/)
  assert.match(popover, /<Switch aria-label=\{t\.fastMode\}/)
  assert.doesNotMatch(source, /id="new-thread-web-search"/)
  assert.doesNotMatch(source, /id="default-thread-web-search"/)
  assert.doesNotMatch(source, /settings\.mutate\(\{ web_search/)
  assert.doesNotMatch(source, /\.web_search\b/)
  assert.doesNotMatch(source, /\.image_generation\b/)
})

test("the tools page renders the shared tool catalog", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../tools.json", import.meta.url), "utf8"))
  assert.match(source, /import toolCatalog from "\.\.\/\.\.\/tools\.json"/)
  assert.match(source, /toolCatalog\.context\.map/)
  assert.match(source, /toolCatalog\.worker\.map/)
  assert.match(source, /Object\.keys\(toolCatalog\.native\)/)
  const names = [
    ...catalog.context.map((tool: { name: string }) => tool.name),
    ...catalog.worker.map((tool: { name: string }) => tool.name),
    ...Object.keys(catalog.native),
  ]
  for (const name of names) {
    const label = source.match(new RegExp(`${name}: "(tool[A-Za-z]+)"`))
    assert.ok(label, `missing tool label for ${name}`)
    const occurrences = source.match(new RegExp(`${label[1]}:`, "g")) ?? []
    assert.ok(occurrences.length >= 2, `${label[1]} needs English and Chinese copy`)
  }
  const mapped = [...source.matchAll(/\n  (\w+): "tool[A-Za-z]+",/g)].map((match) => match[1])
  for (const name of mapped) {
    assert.ok(names.includes(name), `stale tool label for ${name}`)
  }
})

test("Custom Tools render from the shared catalog without per-tool web edits", () => {
  const catalog = JSON.parse(readFileSync(new URL("../../tools.json", import.meta.url), "utf8"))
  const connectors = catalog.custom_tools as Record<string, { tools: { name: string }[] }>
  const names = Object.values(connectors).flatMap((connector) => connector.tools.map((tool) => tool.name))
  assert.ok(names.length >= 1)
  assert.match(source, /toolCatalog\.custom_tools/)
  assert.match(source, /toolCustomTools/)
  assert.match(source, /tool\.title \?\?/)
  for (const name of names) {
    assert.equal(
      source.match(new RegExp(`${name}: "tool[A-Za-z]+"`)),
      null,
      `custom tool ${name} must not need a hardcoded label`,
    )
  }
})

test("the management surfaces expose integration keys and SQLite-free Worker pairing", () => {
  assert.match(source, /\/api\/api-keys/)
  assert.match(source, /\/api\/workers/)
  const connections = readFileSync(new URL("../src/components/worker-connections.tsx", import.meta.url), "utf8")
  for (const key of ["controller_url", "user_id", "machine_id", "access_token"]) assert.ok(connections.includes(key))
  assert.doesNotMatch(source, /tenant_id|\/turn|run_id|turn_index/)
})

test("the Worker page uses the controller release manifest and guided connections", () => {
  assert.match(source, /WorkerConnections/)
  assert.doesNotMatch(source, /CYBION_WORKER_RELEASE/)
})

test("the hosted shell keeps the outer navigation and Linkit account surface", () => {
  for (const group of ["navWork", "navAudit", "navAdministration", "navConfiguration"]) {
    assert.match(source, new RegExp(`${group}:`))
  }
  for (const route of ["/reasoning-audit", "/history", "/system", "/configuration"]) {
    assert.match(source, new RegExp(`to: \"${route}\"`))
  }
  assert.match(source, /<LinkitProvider/)
  assert.match(source, /import \{ AppLayout, type AppNavGroup \} from "@zccz14\/ux"/)
  assert.doesNotMatch(source, /<LinkitMyInfo/)
})

test("the shadcn tooltip context and layered error boundaries protect the shell", () => {
  assert.match(source, /import \{ TooltipProvider \} from "@\/components\/ui\/tooltip"/)
  assert.match(source, /<TooltipProvider delayDuration=\{0\}>/)
  assert.match(source, /import \{ ErrorBoundary, ErrorBoundaryFallback \} from "@\/components\/error-boundary"/)
  assert.match(source, /resetKeys=\{\[location\.pathname\]\}/)
  assert.match(source, /<ErrorBoundary fallback=/)
})

test("narrow screens render a dedicated searchable thread list instead of the sidebar switcher", () => {
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  const hooks = readFileSync(new URL("../src/hooks/use-mobile.ts", import.meta.url), "utf8")
  assert.match(source, /function ThreadsHomePage\(/)
  assert.match(source, /function ThreadListPage\(/)
  assert.match(source, /import \{ ArchivedThreadGroup, ThreadList \} from "@\/components\/thread-list"/)
  assert.equal(source.match(/\{desktop && <aside/g)?.length, 2)
  assert.match(source, /aria-label=\{t\("backToThreads"\)\}/)
  assert.match(hooks, /export function useIsDesktopLayout\(/)
  assert.match(list, /ThreadListControls/)
  assert.match(list, /onCreate/)
})

test("archived threads leave the default list and restore from the collapsed group", () => {
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  assert.match(source, /threadListUrl\(allThreadListFilters, pageParam, true\)/)
  assert.match(source, /archived_at !== null/)
  assert.match(source, /archived: false/)
  assert.match(source, /<ArchivedThreadGroup /)
  assert.match(list, /export function ArchivedThreadGroup/)
  assert.match(list, /archivedThreads: "已归档"/)
  assert.match(list, /restoreThread: "恢复"/)
})

test("integration-created threads keep their origin chip and external reference", () => {
  const status = readFileSync(new URL("../src/components/thread-status.tsx", import.meta.url), "utf8")
  assert.match(source, /created_by: "web" \| "api"/)
  assert.match(source, /apiOriginHint/)
  assert.match(source, /created_by === "api"/)
  assert.match(status, /created_by === "api"/)
  assert.match(status, /external_ref/)
})

test("thread lists share one server-side filter control bar", () => {
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  const controls = readFileSync(new URL("../src/components/thread-list-controls.tsx", import.meta.url), "utf8")
  const search = readFileSync(new URL("../src/lib/thread-search.ts", import.meta.url), "utf8")
  assert.match(source, /import \{ ThreadListControls, ThreadListEmptyState, ThreadListMore, type ThreadListPagination \} from "@\/components\/thread-list-controls"/)
  assert.match(source, /const \[searchParams, setSearchParams\] = useSearchParams\(\)/)
  assert.match(source, /const threadListFilters = useMemo\(\(\) => parseThreadListFilters\(searchParams\), \[searchParams\]\)/)
  assert.match(source, /setSearchParams\(serializeThreadListFilters\(filters\)\)/)
  assert.doesNotMatch(source, /useState<ThreadListFilters>/)
  assert.match(source, /placeholderData: keepPreviousData/)
  assert.match(source, /threadListUrl\(threadListFilters\)/)
  assert.match(list, /ThreadListControls/)
  assert.match(controls, /aria-pressed=\{filters\.view === view\}/)
  assert.match(controls, /setTimeout\(\(\) => onFiltersChange/)
  assert.doesNotMatch(search, /matchesThreadQuery/)
  assert.match(search, /viewParams/)
  assert.match(search, /origin/)
  assert.match(search, /status/)
})

test("thread lists paginate with keyset cursors and scroll loading", () => {
  const list = readFileSync(new URL("../src/components/thread-list.tsx", import.meta.url), "utf8")
  const controls = readFileSync(new URL("../src/components/thread-list-controls.tsx", import.meta.url), "utf8")
  const search = readFileSync(new URL("../src/lib/thread-search.ts", import.meta.url), "utf8")
  assert.match(source, /useInfiniteQuery/)
  assert.match(source, /getNextPageParam: \(lastPage\) => lastPage\.next_cursor/)
  assert.match(source, /mergeThreadPages\(threads\.data\?\.pages/)
  assert.match(source, /threadsPagination/)
  assert.match(list, /ThreadListMore/)
  assert.match(controls, /IntersectionObserver/)
  assert.match(search, /mergeThreadPages/)
  assert.match(search, /cursor/)
})

test("thread list filters live in the URL so views stay shareable and steppable", () => {
  const search = readFileSync(new URL("../src/lib/thread-search.ts", import.meta.url), "utf8")
  const status = readFileSync(new URL("../src/components/thread-status.tsx", import.meta.url), "utf8")
  assert.match(search, /export const THREAD_LIST_VIEWS/)
  assert.match(search, /defaultThreadListFilters: ThreadListFilters = \{ view: "mine", q: "" \}/)
  assert.match(search, /export function parseThreadListFilters\(params: URLSearchParams\)/)
  assert.match(search, /export function serializeThreadListFilters\(filters: ThreadListFilters\)/)
  assert.match(source, /onReset=\{\(\) => onFiltersChange\(allThreadListFilters\)\}/)
  assert.ok((source.match(/search: location\.search/g) ?? []).length >= 5, "threads navigation carries the list filters")
  assert.match(status, /useLocation\(\)/)
  assert.match(status, /search: location\.search/)
})
