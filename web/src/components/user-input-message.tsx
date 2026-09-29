import { useState } from "react"
import { CopyReplyButton } from "@/components/copy-reply-button"
import { MessageGroup } from "@/components/ui/message"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { userInputView } from "@/lib/history-payload"

const copy = {
  en: { image: "Pasted image", open: "Open image" },
  zh: { image: "粘贴的图片", open: "查看图片" },
} as const

export function UserInputMessage({ language, payload }: { language: "en" | "zh"; payload: unknown }) {
  const { text, images } = userInputView(payload)
  return <MessageGroup>
    {images.length > 0 && <div className="flex flex-wrap justify-end gap-2">
      {images.map((dataUrl, index) => <UserInputImage key={index} language={language} dataUrl={dataUrl} />)}
    </div>}
    {text !== "" && <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[75ch] whitespace-pre-wrap break-words rounded-lg bg-user-message px-3 py-2 text-sm leading-6 text-user-message-foreground">{text}</div>
      <CopyReplyButton text={text} language={language} />
    </div>}
  </MessageGroup>
}

function UserInputImage({ language, dataUrl }: { language: "en" | "zh"; dataUrl: string }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" aria-label={copy[language].open} className="cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={() => setOpen(true)}>
      <img src={dataUrl} alt={copy[language].image} loading="lazy" decoding="async" className="block max-h-72 w-auto max-w-full rounded-lg border bg-muted" />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader><DialogTitle>{copy[language].image}</DialogTitle></DialogHeader>
        <img src={dataUrl} alt={copy[language].image} className="max-h-[70vh] w-full object-contain" />
      </DialogContent>
    </Dialog>
  </>
}
