import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HashRouter } from "react-router-dom"
import { DailyReports } from "../src/components/daily-reports"
import { Button } from "../src/components/ui/button"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const [session, setSession] = useState("owner")
  const [date, setDate] = useState("2026-09-26")
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-Fixture-Session": session } })
    if (!response.ok) throw new Error((await response.json()).error)
    return response.json()
  }
  return <main className="mx-auto flex min-w-0 max-w-6xl flex-col gap-4 p-4">
    <header className="flex flex-wrap gap-2"><Button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</Button><Button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</Button><Button onClick={() => setSession("other")}>Other user</Button><Button onClick={() => setDate("2026-09-25")}>Other day</Button></header>
    <DailyReports key={`${session}:${date}`} date={date} language={language} sessionId={session} request={request} />
  </main>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><HashRouter><Fixture /></HashRouter></QueryClientProvider></StrictMode>)
