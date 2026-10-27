import { createRoot } from "react-dom/client"
import { BashCommand } from "../src/components/bash-command"
import "../src/styles.css"

const now = Math.floor(Date.now() / 1000)
const call = (delaySeconds: number | null, timeoutSeconds: number | null) => ({ callId: "call-1", workerId: "worker-1", summary: "检查工作区", command: "pwd", delaySeconds, timeoutSeconds })
const workers = [{ id: "worker-1", label: "MacMini" }]

function Card({ name, call: schedule, startedAt, inFlight }: { name: string; call: ReturnType<typeof call>; startedAt: number; inFlight: boolean }) {
  return <section data-card={name} className="border-b p-3">
    <BashCommand language="zh" call={schedule} workers={workers} time="12:34:56" startedAt={startedAt} inFlight={inFlight}>{null}</BashCommand>
  </section>
}

function Fixture() {
  return <main className="flex min-h-svh flex-col bg-background text-foreground">
    <Card name="delayed" call={call(40, 300)} startedAt={now} inFlight />
    <Card name="running" call={call(null, 7200)} startedAt={now - 3600} inFlight />
    <Card name="expired" call={call(null, null)} startedAt={now - 3600} inFlight />
    <Card name="settled" call={call(40, 300)} startedAt={now} inFlight={false} />
  </main>
}
createRoot(document.getElementById("root")!).render(<Fixture />)
