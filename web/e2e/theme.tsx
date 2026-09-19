import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router-dom"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { MoonIcon, SendIcon, SparklesIcon, SunIcon, TerminalSquareIcon } from "lucide-react"
import { Button } from "../src/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../src/components/ui/card"
import { Input } from "../src/components/ui/input"
import { Label } from "../src/components/ui/label"
import { Textarea } from "../src/components/ui/textarea"
import { Switch } from "../src/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/ui/select"
import { Sidebar, SidebarContent, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from "../src/components/ui/sidebar"
import { Message, MessageContent, MessageFooter, MessageGroup } from "../src/components/ui/message"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { ThreadLink, ThreadStatusBadge } from "../src/components/thread-status"
import type { ThreadDisplayStatus } from "../src/lib/thread-status"
import { emptyThreadUsage } from "../src/lib/thread-usage"
import "../src/styles.css"
import "linkit-react-components/styles.css"

const statuses: ThreadDisplayStatus[] = ["running", "completed", "failed", "stopped", "ready", "compacting"]
const markdown = "### 黑灰主题\n\n正文、**强调**、[链接](#details)和 `inline code` 保持清晰。\n\n> 引用使用中性的文字与边框。\n\n- 更新主题色\n- 保留状态语义\n\n```sh\nprintf 'Cybion\\n'\n```\n\n| 状态 | 含义 |\n| --- | --- |\n| 已完成 | 最近一次执行已结束 |"
function ThemeFixture() {
  const [dark, setDark] = useState(true)
  useEffect(() => { document.documentElement.classList.toggle("dark", dark) }, [dark])
  return <SidebarProvider>
    <Sidebar>
      <SidebarHeader><span className="px-2 py-1 text-lg font-semibold">Cybion</span></SidebarHeader>
      <SidebarContent><SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive><TerminalSquareIcon />Threads</SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarContent>
    </Sidebar>
    <SidebarInset>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger aria-label="Navigation" />
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">中性黑灰 · Neutral dark</h1>
        <Button variant="ghost" size="icon-sm" aria-label="Switch theme" onClick={() => setDark(!dark)}>{dark ? <SunIcon /> : <MoonIcon />}</Button>
      </header>
      <main className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <aside className="border-b bg-sidebar/40 p-3 lg:w-64 lg:shrink-0 lg:border-r lg:border-b-0" data-testid="thread-sidebar">
          <nav className="flex flex-col gap-1" aria-label="Threads">{statuses.map((status) => <ThreadLink key={status} thread={{ id: status, title: `Thread · ${status}`, display_status: status, usage: emptyThreadUsage }} language="zh" />)}</nav>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col gap-5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center gap-3"><h2 className="mr-auto font-semibold">重新设计暗黑模式配色</h2><ThreadStatusBadge status="running" language="zh" /></div>
          <Message align="end"><MessageContent><MessageGroup>
            <div data-testid="user-message" className="max-w-[75ch] whitespace-pre-wrap break-words rounded-lg bg-user-message px-3 py-2 text-sm leading-6 text-user-message-foreground">我希望使用黑色和深灰，而不是深蓝。请保持消息区域的阅读体验。</div>
          </MessageGroup><MessageFooter>18:30 · You</MessageFooter></MessageContent></Message>
          <div data-testid="reasoning" className="relative flex items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 dark:border-border dark:bg-card">
            <SparklesIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <div><p className="text-sm font-medium text-primary">推理 (Reasoning)</p><div className="prose prose-sm mt-2 max-w-none break-words dark:prose-neutral dark:prose-invert"><ReactMarkdown>检查背景、悬停、弹层和文字的中性色层级。</ReactMarkdown></div></div>
          </div>
          <div data-testid="assistant-message" className="rounded-2xl rounded-tl-md bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/10">
            <div data-testid="markdown" className="prose prose-sm max-w-none break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground"><ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown></div>
          </div>
          <Card><CardHeader><CardTitle>Thread settings</CardTitle><CardDescription data-testid="muted-text">次要信息应在深灰表面上清晰可读。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2"><Label htmlFor="thread-name">Thread name</Label><Input id="thread-name" defaultValue="Neutral theme" /></div>
            <div className="flex flex-wrap items-center gap-3"><Select defaultValue="balanced"><SelectTrigger aria-label="Reasoning effort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select><Label htmlFor="fast">Fast mode</Label><Switch id="fast" defaultChecked /><Button variant="outline">Secondary action</Button></div>
          </CardContent></Card>
          <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
            <Label htmlFor="message">Message</Label><Textarea id="message" placeholder="发送下一条指令…" />
            <div className="flex justify-end"><Button data-testid="send"><SendIcon />Send</Button></div>
          </form>
        </section>
      </main>
    </SidebarInset>
  </SidebarProvider>
}
createRoot(document.getElementById("root")!).render(<StrictMode><TooltipProvider><HashRouter><ThemeFixture /></HashRouter></TooltipProvider></StrictMode>)
