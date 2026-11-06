import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"

import "../src/styles.css"
import { AssistantMessage } from "@zccz14/cybion-components"

const reply = "## 部署状态\n\n- 检查通过\n- 服务健康"

function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  return <main className="flex min-h-svh flex-col gap-4 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button>
    </header>
    <AssistantMessage language={language} text={reply} time="12:34:56" />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
