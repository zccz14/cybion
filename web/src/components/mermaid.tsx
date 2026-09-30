import { useEffect, useRef, useState } from "react"

const MERMAID_FONT = '"Geist Variable", sans-serif'

let diagramSequence = 0

async function renderDiagram(source: string): Promise<string | null> {
  try {
    const { default: mermaid } = await import("mermaid")
    // 主题在 import 完成后读取：并发或延迟执行的渲染（包括已被更新请求取代的旧任务）
    // 必须以执行时刻的主题渲染，否则初始深色加载或主题切换时可能留下错误配色的图表。
    const dark = document.documentElement.classList.contains("dark")
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      themeVariables: { fontFamily: MERMAID_FONT, fontSize: "14px" },
    })
    const { svg } = await mermaid.render(`cybion-mermaid-${++diagramSequence}`, source)
    return svg
  } catch {
    // RECOVERY: 加载或解析失败（例如流式生成中途的不完整图表）时回退为原始代码块展示。
    return null
  }
}

export function Mermaid({ source }: { source: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  const renderToken = useRef(0)

  useEffect(() => {
    const render = async () => {
      const token = ++renderToken.current
      const next = await renderDiagram(source)
      if (renderToken.current === token) setSvg(next)
    }
    void render()
    const observer = new MutationObserver(() => void render())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => {
      renderToken.current += 1
      observer.disconnect()
    }
  }, [source])

  if (svg === null) {
    return (
      <pre data-mermaid="source" className="overflow-x-auto">
        <code className="language-mermaid">{source}</code>
      </pre>
    )
  }
  return <div data-mermaid="diagram" className="overflow-x-auto [&_svg]:mx-auto" dangerouslySetInnerHTML={{ __html: svg }} />
}
