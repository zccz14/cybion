import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { LinkitNotifications } from "../src/components/linkit-notifications"
import "../src/styles.css"
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw new Error((await response.json()).error)
  return response.json()
}
function Fixture() {
  const [language, setLanguage] = useState<"en" | "zh">("zh")
  return <div className="mx-auto max-w-3xl space-y-4 p-4"><button onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>Language</button><LinkitNotifications request={request} language={language} sessionId="notification-owner" /></div>
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>)
