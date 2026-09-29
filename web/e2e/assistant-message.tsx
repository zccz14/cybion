import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { AssistantMessage } from "../src/components/assistant-message"
import "../src/styles.css"

const reply = `## 部署状态

- **检查通过**：服务健康。
- 命令：\`git status\`

| 项目 | 状态 |
| --- | --- |
| 部署 | 通过 |

\`\`\`bash
git status
\`\`\`

更多细节见 [文档](https://example.com/docs)。`

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
