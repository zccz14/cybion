import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { Markdown } from "@zccz14/ux"
import "../src/styles.css"

const inline = "## 质能方程 $E=mc^2$\n\n其中 $c$ 是光速，$\\alpha + \\beta$ 是两个系数。"
const display = "高斯积分的结果：\n\n$$\n\\int_{-\\infty}^{+\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}\n$$\n\n推导见上面的公式。"
const wide = "$$\nf(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos\\frac{n\\pi x}{L} + b_n \\sin\\frac{n\\pi x}{L} \\right) = \\frac{\\Gamma(\\alpha+\\beta)}{\\Gamma(\\alpha)\\Gamma(\\beta)} x^{\\alpha-1} (1-x)^{\\beta-1}\n$$"
const broken = "被截断的公式 $\\frac{1}{$ 仍然要作为文本出现，后面的句子照常可读。"
const escaped = "预算 \\$5 与 \\$10 两个价位用反斜杠转义，不会被当成公式。"
// 模型最常写的形态：展示公式用 \\[...\\]，行内公式用 \\(...\\)。
const backslash = "可以先检验状态依赖的概率收缩：\n\n\\[ p=\\sigma\\left(\\frac{\\operatorname{logit}(\\mu)}{T(s)}\\right) \\]\n\n其中 \\(T(s)\\) 是温度系数，\\(\\mu\\) 是均值。"

function Message({ slot, children }: { slot: string; children: ReactNode }) {
  return <article data-message={slot} className="max-w-[75ch] break-words text-sm">{children}</article>
}

function Fixture() {
  const [dark, setDark] = useState(() => new URLSearchParams(window.location.search).get("theme") === "dark")
  useEffect(() => { document.documentElement.classList.toggle("dark", dark) }, [dark])
  return <main className="flex min-h-svh flex-col gap-6 bg-background p-6 text-foreground">
    <header className="flex flex-wrap gap-3 text-sm">
      <button onClick={() => setDark(!dark)}>Theme</button>
    </header>
    <Message slot="inline"><Markdown content={inline} /></Message>
    <Message slot="display"><Markdown content={display} /></Message>
    <Message slot="wide"><Markdown content={wide} /></Message>
    <Message slot="broken"><Markdown content={broken} /></Message>
    <Message slot="escaped"><Markdown content={escaped} /></Message>
    <Message slot="backslash"><Markdown content={backslash} /></Message>
  </main>
}

createRoot(document.getElementById("root")!).render(<StrictMode><Fixture /></StrictMode>)
