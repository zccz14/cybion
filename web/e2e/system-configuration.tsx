import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SystemConfiguration } from "../src/components/system-configuration"
import { Button } from "../src/components/ui/button"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [sessionId, setSessionId] = useState(new URLSearchParams(location.search).get("session") ?? "admin")
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-Fixture-Session": sessionId } })
    if (!response.ok) throw new Error((await response.json()).error)
    return response.json()
  }
  return <main className="mx-auto flex max-w-5xl flex-col gap-6 p-4 md:p-6">
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</Button>
      <Button variant="outline" onClick={() => setSessionId("user")}>Ordinary user</Button>
      <Button variant="outline" onClick={() => setSessionId("admin")}>Administrator</Button>
      <Button variant="outline" onClick={() => document.documentElement.classList.toggle("dark")}>Theme</Button>
      <Button variant="outline" onClick={() => void client.invalidateQueries({ queryKey: ["system-configuration"] })}>Refetch</Button>
    </div>
    <div><h1 className="text-2xl font-semibold">{language === "zh" ? "系统配置" : "System configuration"}</h1><p className="mt-1 text-sm text-muted-foreground">{language === "zh" ? "仅管理员可修改，影响所有用户的上游请求。" : "Administrator-only global settings for all users' upstream requests."}</p></div>
    <SystemConfiguration key={sessionId} language={language} sessionId={sessionId} request={request} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><Fixture /></QueryClientProvider></StrictMode>)
