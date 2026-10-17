import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HashRouter } from "react-router-dom"
import { UltimateMachines } from "../src/components/ultimate-machines"
import "../src/styles.css"

const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error((await response.json()).error)
  return response.status === 204 ? undefined as T : response.json()
}

function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("zh")
  return (
    <div className="mx-auto max-w-5xl p-4">
      <button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button>
      <QueryClientProvider client={client}>
        <HashRouter>
          <UltimateMachines language={language} sessionId="machine-page" request={request} />
        </HashRouter>
      </QueryClientProvider>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
