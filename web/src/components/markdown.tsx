import type { Element } from "hast"
import { ExternalLinkIcon } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { Mermaid } from "@/components/mermaid"

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

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
}
