import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query"
import { composeComposerInput, maxInputChars, useComposerFiles } from "@zccz14/cybion-components/logic"
import { ComposerAttach } from "@zccz14/cybion-components"
import { ComposerAttachments } from "@zccz14/cybion-components"
import { ComposerFileNotice, ComposerLengthNotice } from "@zccz14/cybion-components"
import { useComposerDraft } from "@zccz14/cybion-components/logic"
import { handleChatInputKeyDown } from "@zccz14/cybion-components/logic"
import { Button } from "../src/components/ui/button"
import { Textarea } from "../src/components/ui/textarea"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })

/// 新线程页的输入框：附件按钮 + 芯片 + 发送时拼装，和真实 composer 同一条路径。
function Composer() {
  const composer = useComposerDraft("attach-user", null)
  const { input, setInput, clearSubmitted } = composer
  const files = useComposerFiles()
  const composed = composeComposerInput(input, files.files, "zh")
  const oversize = composed.length > maxInputChars
  const send = useMutation({
    mutationFn: async (value: { draft: string; input: string }) => {
      const response = await fetch("/composer-files/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value.input }) })
      if (!response.ok) throw new Error("Send failed")
      return response.json()
    },
    onSuccess: (_ack, value) => {
      clearSubmitted(value.draft)
      files.clear()
    },
  })
  const sendable = composed !== "" && !oversize
  return <form id="composer" className="flex max-w-xl flex-col gap-3 p-5" onSubmit={(event) => { event.preventDefault(); if (sendable && !send.isPending) send.mutate({ draft: input, input: composed }) }}>
    <label htmlFor="attach">Composer</label>
    <Textarea id="attach" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={handleChatInputKeyDown} disabled={send.isPending} />
    <ComposerAttachments language="zh" images={[]} files={files.files} onRemove={() => undefined} onRemoveFile={files.remove} />
    <ComposerFileNotice language="zh" skipped={files.skipped} />
    {oversize && <ComposerLengthNotice language="zh" chars={composed.length} limit={maxInputChars} />}
    <div className="flex items-center gap-2">
      <ComposerAttach language="zh" disabled={send.isPending} onFiles={(picked) => void files.add(picked)} />
      <Button disabled={!sendable || send.isPending}>Send</Button>
    </div>
  </form>
}

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><Composer /></QueryClientProvider></StrictMode>)
