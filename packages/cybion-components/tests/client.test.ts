import { describe, expect, it, vi } from "vitest"

import { CybionThreadClient, CybionApiError } from "../src/api"

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe("CybionThreadClient", () => {
  it("addresses the configured origin and sends the Auth Mini JWT", async () => {
    const fetch = vi.fn(async () => json({ id: "t1", title: "hello" }))
    const client = new CybionThreadClient({ baseUrl: "https://cybion.example/", getToken: () => "jwt-1", fetch })
    await expect(client.thread("t1")).resolves.toMatchObject({ id: "t1" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://cybion.example/api/threads/t1")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-1")
  })

  it("retries once with a fresh token when the first request is unauthorized", async () => {
    const tokens = ["expired", "fresh"]
    const fetch = vi.fn(async () => (fetch.mock.calls.length === 1 ? json({ error: "expired" }, 401) : json({ id: "t1" })))
    const client = new CybionThreadClient({ baseUrl: "https://cybion.example", getToken: () => tokens.shift() ?? "fresh", fetch })
    await expect(client.thread("t1")).resolves.toMatchObject({ id: "t1" })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("surfaces the server's error message and status", async () => {
    const fetch = vi.fn(async () => json({ error: "thread not found" }, 404))
    const client = new CybionThreadClient({ baseUrl: "https://cybion.example", getToken: () => "jwt", fetch })
    await expect(client.thread("missing")).rejects.toMatchObject({ message: "thread not found", status: 404 })
    await expect(client.thread("missing")).rejects.toBeInstanceOf(CybionApiError)
  })

  it("loads one page of history and carries the server's older-records flag into the view", async () => {
    // The wire field is `has_older`; the view asks `hasOlder` to decide whether
    // the load-earlier control exists at all.
    const fetch = vi.fn(async () => json({ records: [{ id: 7 }], has_older: true }))
    const client = new CybionThreadClient({ baseUrl: "https://cybion.example", getToken: () => "jwt", fetch })
    await expect(client.historyWindow("t1", 9)).resolves.toEqual({ records: [{ id: 7 }], hasOlder: true })
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://cybion.example/api/threads/t1/history/window?before=9")
  })

  it("asks for history newer than the newest loaded record", async () => {
    const fetch = vi.fn(async () => json([]))
    const client = new CybionThreadClient({ baseUrl: "https://cybion.example", getToken: () => "jwt", fetch })
    await client.history("t1", 42)
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://cybion.example/api/threads/t1/history?after=42")
  })
})
