import { StrictMode, useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HashRouter, Routes, Route, useLocation } from "react-router-dom"
import { WorkerConnections } from "../src/components/worker-connections"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "../src/styles.css"
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json" } })
  if (!response.ok) throw new Error((await response.json()).error)
  return response.status === 204 ? undefined as T : response.json()
}
function Draft() { const location=useLocation();return <pre data-testid="draft">{location.state?.initialInput}</pre> }
function Fixture() {
  const [language,setLanguage]=useState<"zh"|"en">("zh")
  return <><button onClick={()=>setLanguage(language==="zh"?"en":"zh")}>Language</button><Routes><Route path="/threads/new" element={<Draft/>}/><Route path="*" element={<WorkerConnections language={language} request={request} sessionId="test-user"/>}/></Routes></>
}
createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={client}><TooltipProvider><HashRouter><Fixture/></HashRouter></TooltipProvider></QueryClientProvider></StrictMode>)
