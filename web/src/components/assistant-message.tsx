import { Markdown } from "@zccz14/ux"

import { CopyReplyButton } from "@/components/copy-reply-button"

export function AssistantMessage({ language, text, time }: { language: "en" | "zh"; text: string; time: string }) {
  return <div data-slot="assistant-message" className="flex min-w-0 flex-col gap-1.5">
    <div data-slot="assistant-content" className="max-w-[75ch] break-words text-sm">
      <Markdown content={text} />
    </div>
    <div data-slot="assistant-footer" className="flex flex-wrap items-center gap-2 px-1">
      <CopyReplyButton text={text} language={language} />
      <time data-slot="assistant-time" className="text-xs text-muted-foreground">{time}</time>
    </div>
  </div>
}
