import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HashRouter, Routes, Route } from "react-router-dom"
import { WorkerConnections } from "../src/components/worker-connections"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "linkit-react-components"
import "../src/styles.css"
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
async function request<T>(sessionId: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", "X-Fixture-Session": sessionId } })
  if (!response.ok) throw new Error((await response.json()).error)
  return response.status === 204 ? undefined as T : response.json()
}
function Fixture() {
  const [language, setLanguage] = useState<"zh" | "en">("zh")
  const sessionId = "test-session"
  const sessionRequest = <T,>(path: string, init?: RequestInit) => request<T>(sessionId, path, init)
  return <><button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button><button onClick={() => document.documentElement.classList.toggle("dark")}>Theme</button><Routes><Route path="*" element={<WorkerConnections language={language} request={sessionRequest} sessionId={sessionId} userId="stable-owner" />} /></Routes></>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><TooltipProvider><HashRouter><Fixture /></HashRouter></TooltipProvider></QueryClientProvider></StrictMode>)
