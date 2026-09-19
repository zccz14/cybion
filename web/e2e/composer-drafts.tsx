import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query"
import { HashRouter, Link, useLocation, useNavigate } from "react-router-dom"
import { useComposerDraft } from "../src/hooks/use-composer-draft"
import { ComposerDraftNotice } from "../src/components/composer-draft-notice"
import { handleChatInputKeyDown } from "../src/lib/chat-input"
import { Button } from "../src/components/ui/button"
import { Textarea } from "../src/components/ui/textarea"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
function Composer({ userId, threadId }: { userId: string; threadId: string | null }) {
  const location = useLocation()
  const navigate = useNavigate()
  const composer = useComposerDraft(userId, threadId)
  const { input, setInput, seed, clearSubmitted } = composer
  useEffect(() => {
    if (threadId !== null || typeof location.state?.initialInput !== "string") return
    const { initialInput, ...state } = location.state
    seed(initialInput)
    navigate(location.pathname, { replace: true, state })
  }, [location, navigate, seed, threadId])
  const send = useMutation({
    mutationFn: async (text: string) => {
      const response = await fetch("/draft-test/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: text.trim(), userId, threadId }) })
      if (!response.ok) throw new Error("Send failed")
      return response.json()
    },
    onSuccess: (_ack, text) => clearSubmitted(text),
  })
  return <form className="flex max-w-xl flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (input.trim() && !send.isPending) send.mutate(input, { onSuccess: (ack) => { if (threadId === null) navigate(`/threads/${ack.thread_id}`) } }) }}>
    <label htmlFor="draft">{threadId ?? "Create thread"} · {userId}</label>
    <Textarea id="draft" value={input} onChange={(event) => setInput(event.target.value)} disabled={send.isPending} onKeyDown={handleChatInputKeyDown} />
    <ComposerDraftNotice language="zh" storageError={composer.storageError} />
    {send.error && <p role="alert">{send.error.message}</p>}
    <Button disabled={!input.trim() || send.isPending}>Send</Button>
    <Button type="button" variant="outline" onClick={composer.clear}>Delete thread</Button>
  </form>
}
function Fixture() {
  const [userId, setUserId] = useState("owner-a")
  const { pathname } = useLocation()
  const threadId = pathname === "/threads" || pathname === "/threads/new" ? null : pathname.split("/").at(-1)!
  return <main className="flex flex-col gap-5 p-5">
    <nav className="flex flex-wrap gap-3"><Link to="/threads/a">Thread A</Link><Link to="/threads/b">Thread B</Link><Link to="/threads">Create</Link><Link to="/threads/new">Create alias</Link><Link to="/threads/new" state={{ initialInput: "First device instruction" }}>Worker prefill</Link></nav>
    <Button variant="outline" onClick={() => setUserId(userId === "owner-a" ? "owner-b" : "owner-a")}>Account</Button>
    <Composer key={`${userId}:${threadId}`} userId={userId} threadId={threadId} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><HashRouter><Fixture /></HashRouter></QueryClientProvider></StrictMode>)
