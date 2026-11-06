const copy = {
  en: { failed: "Draft could not be saved in this browser. Copy your text before leaving or refreshing." },
  zh: { failed: "无法在此浏览器保存草稿。离开或刷新前请复制文本。" },
} as const

export function ComposerDraftNotice({ language, storageError }: { language: "en" | "zh"; storageError: boolean }) {
  if (!storageError) return null
  return <p role="status" className="text-xs text-destructive">{copy[language].failed}</p>
}
