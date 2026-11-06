// Every Worker tool call carries the one-sentence intent summary the model
// wrote in its arguments. The card shows it under the title so the user can
// follow why the call was made without opening the raw arguments.
export function WorkerCallSummary({ summary }: { summary: string | null }) {
  if (summary === null) return null
  return <p data-slot="worker-call-summary" className="mt-1.5 break-words text-sm text-muted-foreground">{summary}</p>
}
