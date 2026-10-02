import { StrictMode, useCallback, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HashRouter, Route, Routes, useParams } from "react-router-dom"
import { SharedThreadPage, SharedThreadsPage } from "../src/components/shared-threads"
import { ThreadSharingButton } from "../src/components/thread-sharing"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { UserInputMessage } from "../src/components/user-input-message"
import { Markdown } from "../src/components/markdown"
import { ScreenshotOutput } from "../src/components/screenshot-output"
import { historyPayloadText, screenshotImageSource } from "../src/lib/history-payload"
import type { HistoryRecord } from "../src/lib/thread-history"
import type { SharingRequest } from "../src/lib/thread-sharing"
import "../src/styles.css"
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
Object.assign(window, { sharingFixtureCache: () => client.getQueryCache().getAll().map((q) => ({ key: q.queryKey, data: q.state.data })) })
function Reader({ language, sessionId, userId, request }: { language: "en" | "zh"; sessionId: string; userId: string; request: SharingRequest }) {
  const { ownerId = "", threadId = "" } = useParams()
  const record = (r: HistoryRecord) => {
    if (r.kind === "input") return <UserInputMessage language={language} payload={r.payload} />
    const shot = r.screenshot ? screenshotImageSource(r.payload) : null
    if (shot) return <ScreenshotOutput language={language} source={shot} />
    return <div data-record-id={r.id}><Markdown>{historyPayloadText(r.payload)}</Markdown></div>
  }
  return <SharedThreadPage language={language} sessionId={sessionId} userId={userId} request={request} ownerId={ownerId} threadId={threadId} renderRecord={record} />
}
function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("en")
  const [sessionId, setSession] = useState("session-1")
  const userId = sessionId === "session-1" ? "user-1" : "user-2"
  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-Fixture-Session": sessionId } })
    if (!response.ok) throw Object.assign(new Error((await response.json()).error), { status: response.status })
    return response.status === 204 ? undefined as T : response.json()
  }, [sessionId])
  return <><header className="flex h-14 items-center gap-4 border-b"><button onClick={() => setLanguage(language === "en" ? "zh" : "en")}>Language</button><button onClick={() => setSession(sessionId === "session-1" ? "session-2" : "session-1")}>Switch account</button><button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button></header><Routes>
    <Route path="/owner" element={<div className="p-4"><ThreadSharingButton language={language} sessionId={sessionId} userId={userId} threadId="00000000-0000-4000-8000-000000000001" request={request} /></div>} />
    <Route path="/shared-threads" element={<SharedThreadsPage language={language} sessionId={sessionId} userId={userId} request={request} />} />
    <Route path="/shared-threads/:ownerId/:threadId" element={<Reader language={language} sessionId={sessionId} userId={userId} request={request} />} />
  </Routes></>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><TooltipProvider><HashRouter><Fixture /></HashRouter></TooltipProvider></QueryClientProvider></StrictMode>)
