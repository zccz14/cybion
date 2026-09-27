import { useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

const copy = {
  en: {
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed. Select and copy the text manually.",
  },
  zh: {
    copy: "复制",
    copied: "已复制",
    copyFailed: "复制失败，请手动选择并复制内容。",
  },
}

export function CopyReplyButton({ text, language }: { text: string; language: "en" | "zh" }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const labels = copy[language]
  const writeToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus("copied")
      window.setTimeout(() => setStatus("idle"), 1500)
    } catch {
      setStatus("failed")
    }
  }
  return <div className="flex flex-wrap items-center gap-2 px-1">
    <Button type="button" size="icon-xs" variant="ghost" className="text-muted-foreground" aria-label={labels.copy} title={labels.copy} onClick={() => void writeToClipboard()}>
      {status === "copied" ? <CheckIcon /> : <CopyIcon />}
    </Button>
    <p role="status" className="text-xs text-muted-foreground">{status === "copied" ? labels.copied : status === "failed" ? labels.copyFailed : ""}</p>
  </div>
}
