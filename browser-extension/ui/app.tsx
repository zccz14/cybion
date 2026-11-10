import { useCallback, useEffect, useState } from "react"
import { CybionThreadProvider, CybionThreadView } from "@zccz14/cybion-components"

import { BASE_URL, ERROR_KEY, PENDING_KEY, createThread, getToken, listThreads, type ThreadSummary } from "./session"

function relativeTime(stamp: number) {
  const at = stamp > 1e12 ? stamp : stamp * 1000
  const minutes = Math.round((Date.now() - at) / 60000)
  if (!Number.isFinite(minutes) || minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export function App() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [showList, setShowList] = useState(true)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshList = useCallback(async () => {
    try {
      const page = await listThreads()
      setThreads(page.items)
      setError(null)
    } catch (cause) {
      setError(describe(cause))
    }
  }, [])

  const openThread = useCallback((id: string) => {
    setThreadId(id)
    setShowList(false)
  }, [])

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get(PENDING_KEY)
      const pending = stored?.[PENDING_KEY] as { id?: string } | undefined
      if (pending?.id) {
        await chrome.storage.local.remove(PENDING_KEY)
        openThread(pending.id)
        return
      }
      await refreshList()
    })()
  }, [openThread, refreshList])

  useEffect(() => {
    const listener = (changes: Record<string, { newValue?: unknown }>) => {
      const pending = changes?.[PENDING_KEY]?.newValue as { id?: string } | undefined
      if (pending?.id) {
        void chrome.storage.local.remove(PENDING_KEY)
        openThread(pending.id)
      }
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [openThread])

  useEffect(() => {
    void (async () => {
      const stored = await chrome.storage.local.get(ERROR_KEY)
      const last = stored?.[ERROR_KEY] as string | undefined
      if (last) {
        setError(last)
        await chrome.storage.local.remove(ERROR_KEY)
      }
    })()
  }, [])

  const startNew = async () => {
    setBusy(true)
    try {
      const created = await createThread()
      openThread(created.id)
      setError(null)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cybion-app">
      <header className="cybion-header">
        <span className="cybion-brand">Cybion</span>
        <span className="cybion-spacer" />
        <button className="cybion-ghost" onClick={() => void startNew()} disabled={busy}>新对话</button>
        <button className="cybion-ghost" onClick={() => { setShowList((open) => !open); if (!showList) void refreshList() }}>
          {showList ? "收起" : "线程"}
        </button>
      </header>

      {error ? (
        <div className="cybion-error">
          <span>{error}</span>
          <button className="cybion-link" onClick={() => void chrome.tabs.create({ url: BASE_URL })}>打开 Cybion</button>
        </div>
      ) : null}

      {showList ? (
        <div className="cybion-list">
          {threads.length === 0 ? (
            <p className="cybion-empty">还没有线程。在任意网页按 ⌘⇧K 截一张图，就会开一个。</p>
          ) : (
            threads.map((thread) => (
              <button
                key={thread.id}
                className={thread.id === threadId ? "cybion-item on" : "cybion-item"}
                onClick={() => openThread(thread.id)}
              >
                <span className="cybion-item-title">{thread.title || "未命名线程"}</span>
                <span className="cybion-item-meta">{relativeTime(thread.updated_at)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}

      {threadId ? (
        <div className="cybion-thread">
          <CybionThreadProvider baseUrl={BASE_URL} getToken={() => getToken()} language="zh" identity="browser-extension">
            <CybionThreadView threadId={threadId} className="min-h-0" />
          </CybionThreadProvider>
        </div>
      ) : null}
    </div>
  )
}
