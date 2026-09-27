import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { CopyReplyButton } from "../src/components/copy-reply-button"
import "../src/styles.css"

const reply = "## 部署状态\n\n- 检查通过\n- 服务健康"

function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("zh")
  return <main className="flex min-h-svh flex-col gap-4 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <div className="flex max-w-[75ch] flex-col gap-1.5">
      <div className="rounded-2xl rounded-tl-md bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/10">
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{reply}</p>
      </div>
      <CopyReplyButton text={reply} language={language} />
    </div>
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
