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

更多细节见 [文档](https://example.com/docs)。

## Worker 清单

| Worker | worker_id | 归属 | 状态 | 系统 | 架构 | 版本 | 内存 | 磁盘 | 最后在线 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MacMini | 4d38279c-24cc-494d-bd31-30b46030b395 | 031a393d-8a0a-4ca0-8cb1-313e0d71dfa9 | online | macOS 26.1 | arm64 | 0.6.13 | 19MB | 3.4GB | 2026-02-19T08:41:07Z | 主力开发设备，常驻 |
| Linux US | 63502b08-9c22-47ee-b136-e358184f3c92 | 3e8708ac-af4d-4162-aa60-34d63c9e5d5b | offline | Ubuntu 24.04 | x86_64 | 0.6.12 | 12MB | 811MB | 2026-02-18T23:10:55Z | 美国家庭宽带 |

最后一行是表格最宽的部分。`

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
