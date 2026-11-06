import { StickyNoteIcon } from "lucide-react"

const copy = {
  zh: {
    label: "便签",
    scope: "本线程还没有划掉的便签：模型写下的、这个线程欠着的事。划掉就从这里消失，在「便签」页留档；只有人可以撕掉一条便签。",
  },
  en: {
    label: "Notes",
    scope: "Notes this Thread has not crossed out: what the model wrote down as still owed here. Crossing one out removes it from this row and keeps it on the Notes page; only you can tear one off.",
  },
} as const

// The Thread's open debts, in the same compact row shape as the loaded manuals
// below it: one wrapped line of truncated chips, full text in the title. The
// server caps a Thread at ten open notes, so the row stays bounded.
export function ThreadNotes({ notes, language }: {
  notes: readonly { id: string; text: string }[]
  language: "en" | "zh"
}) {
  const text = copy[language]
  if (notes.length === 0) return null
  return <div data-slot="thread-notes" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
    <span title={text.scope} className="flex items-center gap-1 whitespace-nowrap">
      <StickyNoteIcon aria-hidden="true" className="size-3.5" />
      {text.label} <strong className="font-medium tabular-nums text-foreground">{notes.length}</strong>
    </span>
    {notes.map((note) => <span
      key={note.id}
      title={note.text}
      className="flex min-w-0 max-w-64 items-center rounded-full border bg-card px-2 py-0.5"
    ><span className="truncate">{note.text}</span></span>)}
  </div>
}
