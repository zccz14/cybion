import { Link } from "react-router-dom"
import { CircleHelpIcon, FolderTreeIcon, MessagesSquareIcon, MonitorIcon } from "lucide-react"
import { onboardingCopy, contextReferenceExample, type OnboardingLanguage, type ReferenceExample } from "@/lib/onboarding"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

type Topic = "thread" | "context" | "worker"
const topics = {
  thread: { icon: MessagesSquareIcon, to: "/threads/new", details: ["threadDetail", "threadOptional"] },
  context: { icon: FolderTreeIcon, to: "/contexts", details: ["contextDetail", "contextBoundary"] },
  worker: { icon: MonitorIcon, to: "/workers", details: ["workerOptional", "workerBoundary"] },
} as const

function ConceptDetails({ topic, language }: { topic: Topic; language: OnboardingLanguage }) {
  const text = onboardingCopy[language]
  return <div className="space-y-3 text-sm leading-6 text-muted-foreground">
    {topics[topic].details.map((key) => <p key={key}>{text[key]}</p>)}
  </div>
}

export function ConceptHelp({ topic, language }: { topic: Topic; language: OnboardingLanguage }) {
  const text = onboardingCopy[language]
  return <Dialog>
    <DialogTrigger asChild><Button type="button" size="icon-sm" variant="ghost" aria-label={text[`${topic}Title`]} title={text[`${topic}Title`]}><CircleHelpIcon /></Button></DialogTrigger>
    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{text[`${topic}Title`]}</DialogTitle><DialogDescription className="leading-6">{text[`${topic}Summary`]}</DialogDescription></DialogHeader>
      <ConceptDetails topic={topic} language={language} />
      <DialogFooter><Button asChild variant="outline"><Link to="/help">{text.learnMore}</Link></Button><DialogClose asChild><Button type="button">{text.close}</Button></DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function UsageHelp({ language }: { language: OnboardingLanguage }) {
  const text = onboardingCopy[language]
  return <div className="flex flex-col gap-6">
    <div className="grid gap-4 lg:grid-cols-3">{(Object.keys(topics) as Topic[]).map((topic) => {
      const entry = topics[topic]
      return <Card key={topic}><CardHeader><entry.icon className="mb-1 size-5 text-muted-foreground" /><CardTitle>{text[`${topic}Title`]}</CardTitle><CardDescription className="leading-6">{text[`${topic}Summary`]}</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><ConceptDetails topic={topic} language={language} /><Button asChild variant="outline" className="self-start"><Link to={entry.to}>{text[`${topic}Action`]}</Link></Button></CardContent></Card>
    })}</div>
    <Card><CardContent className="space-y-5 pt-6">{(["chat", "library", "budget", "model"] as const).map((question) => <section key={question}><h2 className="text-sm font-semibold">{text[`${question}Question`]}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{text[`${question}Answer`]}</p></section>)}<Button asChild variant="outline"><Link to="/configuration">{text.modelAction}</Link></Button></CardContent></Card>
  </div>
}

export function ConversationWelcome({ language }: { language: OnboardingLanguage }) {
  const text = onboardingCopy[language]
  return <div className="space-y-3 rounded-xl border bg-muted/20 p-4 sm:p-5">
    <h2 className="text-base font-semibold">{text.welcomeTitle}</h2>
    <p className="text-sm leading-6 text-muted-foreground">{text.welcomeDescription}</p>
    <p className="text-xs leading-5 text-muted-foreground">{text.threadOptional}</p>
    <Link to="/help" className="inline-flex items-center gap-1.5 text-sm underline underline-offset-4"><CircleHelpIcon className="size-4" />{text.learnMore}</Link>
  </div>
}

export function ConversationExamples({ language, onChoose }: { language: OnboardingLanguage; onChoose: (input: string) => void }) {
  const text = onboardingCopy[language]
  return <div className="space-y-2"><div className="flex flex-wrap gap-2">
    <Button type="button" size="sm" variant="outline" onClick={() => onChoose(text.planPrompt)}>{text.planExample}</Button>
    <Button type="button" size="sm" variant="outline" onClick={() => onChoose(text.rewritePrompt)}>{text.rewriteExample}</Button>
  </div><p className="text-xs leading-5 text-muted-foreground">{text.examplesHint}</p></div>
}

export function ContextReferenceIntro({ language }: { language: OnboardingLanguage }) {
  const text = onboardingCopy[language]
  return <div className="space-y-2 rounded-xl border bg-muted/20 p-4 sm:p-5"><h2 className="text-base font-semibold">{text.referencesTitle}</h2><p className="text-sm leading-6 text-muted-foreground">{text.referencesDescription}</p><p className="text-xs leading-5 text-muted-foreground">{text.contextBoundary}</p></div>
}

export function ContextReferenceExamples({ language, onChoose }: { language: OnboardingLanguage; onChoose: (example: ReferenceExample) => void }) {
  const text = onboardingCopy[language]
  return <div className="space-y-4"><p className="text-sm leading-6 text-muted-foreground">{text.examplesDescription}</p>
    {(["device", "network"] as const).map((source) => <div key={source} className="space-y-3 rounded-lg border p-3"><pre className="whitespace-pre-wrap break-words text-xs leading-6 text-muted-foreground">{contextReferenceExample(language, source).content}</pre><Button type="button" size="sm" variant="outline" onClick={() => onChoose(contextReferenceExample(language, source))}>{text[`${source}Example`]}</Button></div>)}
  </div>
}
