import { Markdown } from "@zccz14/ux"

import { CopyReplyButton } from "@/components/copy-reply-button"

/*
 * `streaming` says this reply is still arriving. The preview the conversation renders before a
 * record is durable carries a synthetic id, and while it grows `Markdown` reveals the difference at
 * the cadence the poller has been delivering it — the renderer types, the interface stays polling.
 */
export function AssistantMessage({ language, streaming = false, text, time }: { language: "en" | "zh"; streaming?: boolean; text: string; time: string }) {
  return <div data-slot="assistant-message" className="flex min-w-0 flex-col gap-1.5">
    <div data-slot="assistant-content" className="max-w-[75ch] break-words text-sm">
      <Markdown content={text} reveal={streaming} />
    </div>
    <div data-slot="assistant-footer" className="flex flex-wrap items-center gap-2 px-1">
      <CopyReplyButton text={text} language={language} />
      <time data-slot="assistant-time" className="text-xs text-muted-foreground">{time}</time>
    </div>
  </div>
}
