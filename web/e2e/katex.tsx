import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { Markdown } from "../src/components/markdown"
import "../src/styles.css"

const inline = "## 质能方程 $E=mc^2$\n\n其中 $c$ 是光速，$\\alpha + \\beta$ 是两个系数。"
const display = "高斯积分的结果：\n\n$$\n\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$\n\n推导见上面的公式。"
const wide = "$$\nf(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos\\frac{n\\pi x}{L} + b_n \\sin\\frac{n\\pi x}{L} \\right) = \\frac{\\Gamma(\\alpha+\\beta)}{\\Gamma(\\alpha)\\Gamma(\\beta)} x^{\\alpha-1} (1-x)^{\\beta-1}\n$$"
const broken = "被截断的公式 $\\frac{1}{$ 仍然要作为文本出现，后面的句子照常可读。"
const escaped = "预算 \\$5 与 \\$10 两个价位用反斜杠转义，不会被当成公式。"

function Message({ slot, children }: { slot: string; children: ReactNode }) {
  return <article data-message={slot} className="prose prose-sm max-w-[75ch] break-words dark:prose-neutral dark:prose-invert prose-headings:font-semibold prose-p:my-2 prose-p:first:mt-0 prose-p:last:mb-0 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:text-foreground">{children}</article>
}

function Fixture() {
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get("theme") === "dark")
  useEffect(() => { document.documentElement.classList.toggle("dark", dark) }, [dark])
  return <main className="flex min-h-svh flex-col gap-6 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setDark(!dark)}>Theme</button>
    </header>
    <Message slot="inline"><Markdown>{inline}</Markdown></Message>
    <Message slot="display"><Markdown>{display}</Markdown></Message>
    <Message slot="wide"><Markdown>{wide}</Markdown></Message>
    <Message slot="broken"><Markdown>{broken}</Markdown></Message>
    <Message slot="escaped"><Markdown>{escaped}</Markdown></Message>
  </main>
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
