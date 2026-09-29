import { CopyReplyButton } from "@/components/copy-reply-button"
import { Markdown } from "@/components/markdown"

export function AssistantMessage({ language, text, time }: { language: "en" | "zh"; text: string; time: string }) {
  return <div data-slot="assistant-message" className="flex min-w-0 flex-col gap-1.5">
    <div data-slot="assistant-content" className="max-w-[75ch] break-words">
      <div className="prose prose-sm max-w-none break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">
        <Markdown>{text}</Markdown>
      </div>
    </div>
    <div data-slot="assistant-footer" className="flex flex-wrap items-center gap-2 px-1">
      <CopyReplyButton text={text} language={language} />
      <time data-slot="assistant-time" className="text-xs text-muted-foreground">{time}</time>
    </div>
  </div>
}
