// A checkpoint's first content is its `# Durable working context` title, so a preview has to
// skip structure and stop at the first prose: a heading, table, quote, rule or fence opening
// describes the shape of the checkpoint, never what it holds. The first fenced block ends the
// search, because everything after it is evidence (code, JSON) rather than prose.
const structural = /^(?:#|\||>|[-*_]{3,}$)/

function proseText(line: string) {
  return line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/[*`_]/g, "").trim()
}

export function checkpointPreview(markdown: string): string {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim()
    if (line.startsWith("```")) return ""
    if (line === "" || structural.test(line)) continue
    const text = proseText(line)
    if (text === "") continue
    return text.length > 120 ? `${text.slice(0, 119)}…` : text
  }
  return ""
}
