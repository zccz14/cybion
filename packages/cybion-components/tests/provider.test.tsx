import { createElement } from "react"
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { QueryClient, useQueryClient } from "@tanstack/react-query"
import { CybionThreadProvider, useCybion } from "../src/provider"

afterEach(cleanup)

test("inline token callbacks, locale and link changes keep one transport and the host query cache", async () => {
  let context!: ReturnType<typeof useCybion>
  let cache!: QueryClient
  const host = new QueryClient()
  const tokens: string[] = []
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    tokens.push(new Headers(init?.headers).get("Authorization")!)
    return new Response("{}", { headers: { "Content-Type": "application/json" } })
  }
  function Probe() { context = useCybion(); cache = useQueryClient(); return null }
  const view = (token: string, language: "zh" | "en") => createElement(CybionThreadProvider, {
    baseUrl: "https://cybion.test", identity: "user", sessionId: "session", getToken: () => token,
    queryClient: host, fetch, language, link: ({ children }) => children, children: createElement(Probe),
  })
  const mounted = render(view("first", "zh"))
  const first = context.client
  await first.thread("one")
  mounted.rerender(view("second", "en"))
  expect(context.client).toBe(first)
  expect(cache).toBe(host)
  expect(context.language).toBe("en")
  await context.client.thread("one")
  expect(tokens).toEqual(["Bearer first", "Bearer second"])
})

test("standalone provider keeps a query cache across ordinary host renders", () => {
  let cache!: QueryClient
  function Probe() { cache = useQueryClient(); return null }
  const view = () => createElement(CybionThreadProvider, {
    baseUrl: "https://cybion.test", getToken: () => "token", children: createElement(Probe),
  })
  const mounted = render(view())
  const first = cache
  first.setQueryData(["history-older", "thread", "owner"], [{ records: [], hasOlder: false }])
  mounted.rerender(view())
  expect(cache).toBe(first)
  expect(cache.getQueryData(["history-older", "thread", "owner"])).toEqual([{ records: [], hasOlder: false }])
})
