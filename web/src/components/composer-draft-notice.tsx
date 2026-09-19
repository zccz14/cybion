const copy = {
  en: { saved: "Draft saved automatically in this browser, separately for each thread.", failed: "Draft could not be saved in this browser. Copy your text before leaving or refreshing." },
  zh: { saved: "草稿自动保存在当前浏览器，各线程互不影响。", failed: "无法在此浏览器保存草稿。离开或刷新前请复制文本。" },
} as const

export function ComposerDraftNotice({ language, storageError }: { language: "en" | "zh"; storageError: boolean }) {
  return <p role="status" className={`text-xs ${storageError ? "text-destructive" : "text-muted-foreground"}`}>{storageError ? copy[language].failed : copy[language].saved}</p>
}
