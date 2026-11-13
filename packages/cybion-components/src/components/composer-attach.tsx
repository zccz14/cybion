import { useRef } from "react"
import { PlusIcon } from "lucide-react"

import { Button } from "../ui/button"

const copy = {
  en: { attach: "Add an attachment", hint: "Pick images, audio, or text files" },
  zh: { attach: "添加附件", hint: "可以选择图片、音频或文本文件" },
} as const

/// 输入框左下的附件入口：一个 [+] 按钮打开文件选择器，选中的文件交给 composer
/// 按类型分流（图片、语音、文本）。这里不做取舍，只把一次选择原样交出去——分流的
/// 规则住在 `splitPickedFiles`，两个 composer 用的是同一份。
export function ComposerAttach({
  language,
  disabled,
  onFiles,
}: {
  language: "en" | "zh"
  disabled: boolean
  onFiles: (files: File[]) => void
}) {
  const t = copy[language]
  const picker = useRef<HTMLInputElement>(null)
  return <>
    <input
      ref={picker}
      type="file"
      multiple
      className="hidden"
      aria-hidden="true"
      tabIndex={-1}
      onChange={(event) => {
        const picked = Array.from(event.target.files ?? [])
        // 归零后同一个文件可以再选一次，用户不会遇到“点了没反应”。
        event.target.value = ""
        if (picked.length > 0) onFiles(picked)
      }}
    />
    <Button type="button" size="icon" variant="outline" aria-label={t.attach} title={`${t.attach} · ${t.hint}`} disabled={disabled} onClick={() => picker.current?.click()}>
      <PlusIcon />
    </Button>
  </>
}
