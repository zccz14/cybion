import type { Element } from "hast"
import { ExternalLinkIcon } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeKatex from "rehype-katex"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math-extended"
import { Mermaid } from "@/components/mermaid"

// 公式排版依赖 KaTeX 自带的样式与字体，随渲染组件一起引入，
// 让每个 Markdown 展示面（对话、检查点、手册预览）都自动获得公式渲染。
import "katex/dist/katex.min.css"

function mermaidSource(node: Element | undefined): string | null {
  const code = node?.children[0]
  if (code?.type !== "element" || code.tagName !== "code") return null
  const classes = code.properties.className
  if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return null
  const text = code.children[0]
  return text?.type === "text" ? text.value : null
}

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLinkIcon aria-hidden="true" className="ml-0.5 inline size-[0.8em] align-[-0.1em] text-muted-foreground" />
    </a>
  ),
  pre: ({ node, children, ...props }) => {
    const source = mermaidSource(node)
    return source === null ? <pre {...props}>{children}</pre> : <Mermaid source={source} />
  },
}

// 公式同时接受美元与 LaTeX 两套分隔符：remark-math-extended 在上游
// remark-math 的 `$` / `$$` 之外补上了模型最常写的 `\(...\)` 与 `\[...\]`，
// 且 `\\[2pt]` 这类公式内的换行命令仍是公式内容，不会被当成新的展示公式。
const remarkPlugins = [remarkGfm, remarkMath]

// 模型输出的公式常见宽松写法（Unicode 符号、全角字符、\text 里的中文），
// 严格模式只会把这些记成警告而不改变渲染结果，因此这里直接忽略，保持转录干净。
// 语法错误仍由 KaTeX 自己兜底：渲染成带 title 的错误片段，不会抛到页面。
const katexOptions = { strict: "ignore", errorColor: "var(--destructive)" } as const

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={[[rehypeKatex, katexOptions]]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  )
}
