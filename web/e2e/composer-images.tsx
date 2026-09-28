import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query"
import { useComposerDraft } from "../src/hooks/use-composer-draft"
import { useComposerImages } from "../src/hooks/use-composer-images"
import { ComposerAttachments } from "../src/components/composer-attachments"
import { handleChatInputKeyDown } from "../src/lib/chat-input"
import { Button } from "../src/components/ui/button"
import { Textarea } from "../src/components/ui/textarea"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

function Composer() {
  const composer = useComposerDraft("paste-user", null)
  const { input, setInput, clearSubmitted } = composer
  const attachments = useComposerImages()
  const send = useMutation({
    mutationFn: async (value: { input: string; images: string[] }) => {
      const response = await fetch("/composer-images/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value.input.trim(), images: value.images }) })
      if (!response.ok) throw new Error("Send failed")
      return response.json()
    },
    onSuccess: (_ack, value) => {
      clearSubmitted(value.input)
      attachments.clear()
    },
  })
  const sendable = input.trim() !== "" || attachments.images.length > 0
  return <form className="flex max-w-xl flex-col gap-3 p-5" onSubmit={(event) => { event.preventDefault(); if (sendable && !send.isPending) send.mutate({ input, images: attachments.images }) }}>
    <label htmlFor="paste">Composer</label>
    <Textarea id="paste" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleChatInputKeyDown} onPaste={attachments.paste} disabled={send.isPending} />
    <ComposerAttachments language="zh" images={attachments.images} onRemove={attachments.remove} />
    {send.error && <p role="alert">{send.error.message}</p>}
    <Button disabled={!sendable || send.isPending}>Send</Button>
  </form>
}

function Fixture() {
  return <Composer />
}

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><Fixture /></QueryClientProvider></StrictMode>)
