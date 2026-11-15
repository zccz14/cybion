import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { audioDraftScope, readAudioDrafts, writeAudioDrafts } from "../src/lib/composer-audio-drafts"
import { useComposerAudio } from "../src/hooks/use-composer-audio"

/// jsdom 没有 IndexedDB。这里给一个只实现本模块用到的那几个方法的内存版，
/// 让「写进本地草稿 → 重新打开还在」这条链真的跑一遍。
class MemoryStore {
  readonly data = new Map<string, unknown>()
  get(key: string) { return this.request(this.data.get(key)) }
  put(value: unknown, key: string) { this.data.set(key, value); return this.request(undefined) }
  delete(key: string) { this.data.delete(key); return this.request(undefined) }
  private request(result: unknown) {
    const request = { result, onsuccess: null as null | (() => void), onerror: null as null | (() => void) }
    queueMicrotask(() => request.onsuccess?.())
    return request
  }
}

const databases = new Map<string, MemoryStore>()

beforeEach(() => {
  databases.clear()
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const request: Record<string, unknown> = {
          result: {
            objectStoreNames: { contains: () => true },
            createObjectStore: () => undefined,
            close: () => undefined,
            transaction: (_name: string, _mode: string) => {
              const store = databases.get("audio") ?? new MemoryStore()
              databases.set("audio", store)
              const transaction = { objectStore: () => store, oncomplete: null as null | (() => void), onabort: null as null | (() => void) }
              queueMicrotask(() => transaction.oncomplete?.())
              return transaction
            },
          },
          onsuccess: null as null | (() => void),
          onupgradeneeded: null as null | (() => void),
        }
        queueMicrotask(() => {
          (request.onupgradeneeded as (() => void) | null)?.()
          ;(request.onsuccess as (() => void) | null)?.()
        })
        return request
      },
    },
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined })
})

const clip = (marker: string) => ({ dataUrl: `data:audio/webm;base64,${marker}`, createdAt: 1 })

describe("audio draft storage", () => {
  it("keeps unsent clips and drops them when the last one is sent", async () => {
    const scope = audioDraftScope("user-1", "thread-9")
    await writeAudioDrafts(scope, [clip("AAAA")])
    expect(await readAudioDrafts(scope)).toHaveLength(1)
    await writeAudioDrafts(scope, [])
    expect(await readAudioDrafts(scope)).toHaveLength(0)
  })

  it("separates the new-thread composer from each thread", () => {
    expect(audioDraftScope("user-1", null)).not.toBe(audioDraftScope("user-1", "thread-9"))
    expect(audioDraftScope("user-1", "thread-9")).toContain("thread-9")
  })
})

describe("useComposerAudio with a scope", () => {
  it("brings an unsent take back after the page is reopened", async () => {
    const scope = audioDraftScope("user-1", "thread-9")
    await writeAudioDrafts(scope, [clip("BBBB")])
    const { result } = renderHook(() => useComposerAudio({ scope }))
    await waitFor(() => expect(result.current.audios).toHaveLength(1))
    expect(result.current.audios[0]).toContain("BBBB")
    expect(result.current.restored).toBe(1)
  })

  it("persists a clip the moment it is attached, before any send", async () => {
    const scope = audioDraftScope("user-1", "thread-9")
    const { result } = renderHook(() => useComposerAudio({ scope }))
    await act(async () => {
      result.current.attach("data:audio/webm;base64,CCCC")
    })
    await waitFor(async () => expect(await readAudioDrafts(scope)).toHaveLength(1))
    await act(async () => {
      result.current.clear()
    })
    await waitFor(async () => expect(await readAudioDrafts(scope)).toHaveLength(0))
  })
})
