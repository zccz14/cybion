import { ExternalLinkIcon } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLinkIcon aria-hidden="true" className="ml-0.5 inline size-[0.8em] align-[-0.1em] text-muted-foreground" />
    </a>
  ),
}

export function Markdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
}
