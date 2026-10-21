import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { needsFirstConversationCheck, onboardingCopy } from "../src/lib/onboarding.ts"

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")
const onboarding = readFileSync(new URL("../src/lib/onboarding.ts", import.meta.url), "utf8")

test("only an unsearched empty entry view may check whether the whole workspace is new", () => {
  for (const view of ["mine", "all"] as const) assert.equal(needsFirstConversationCheck({ view, q: "" }, 0, 0), true)
  for (const view of ["running", "failed", "api"] as const) assert.equal(needsFirstConversationCheck({ view, q: "" }, 0, 0), false)
  assert.equal(needsFirstConversationCheck({ view: "mine", q: "project" }, 0, 0), false)
  for (const [visible, archived] of [[undefined, 0], [0, undefined], [undefined, undefined], [1, 0], [0, 1], [0, 100]]) {
    assert.equal(needsFirstConversationCheck({ view: "mine", q: "" }, visible, archived), false)
  }
})

test("the first composer requires a positive unfiltered zero count and retains the standard route", () => {
  assert.match(main, /queryKey: \["threads", sdk\.session\.getState\(\)\.sessionId, "first-conversation"\]/)
  assert.match(main, /api<ThreadPage>\(sdk, "\/api\/threads\?limit=1", \{ signal \}\)/)
  assert.match(main, /enabled: checkFirstConversation/)
  assert.match(main, /emptyWorkspace = checkFirstConversation && firstConversation\.data\?\.total === 0/)
  assert.match(main, /if \(desktop \|\| emptyWorkspace\) return <NewThreadPage/)
  assert.doesNotMatch(main, /localStorage\.(?:getItem|setItem)\(["'].*onboard/)
})

test("Chinese and English help are complete, manual-first and honest about retained results", () => {
  assert.deepEqual(Object.keys(onboardingCopy.en), Object.keys(onboardingCopy.zh))
  for (const language of ["en", "zh"] as const) for (const value of Object.values(onboardingCopy[language])) assert.ok(value.trim())
  assert.match(onboardingCopy.zh.manualSummary, /Markdown.*不是资料本体/)
  assert.match(onboardingCopy.zh.manualDetail, /Worker.*根据任务需要/)
  assert.match(onboardingCopy.zh.manualBoundary, /读取的内容仍可能进入.*对话记录/)
  assert.match(onboardingCopy.en.manualBoundary, /retrieved.*conversation's records/)
  assert.match(onboardingCopy.zh.workerOptional, /普通对话不需要 Worker/)
  assert.match(onboardingCopy.en.workerOptional, /Optional for normal conversation/)
})

test("the Manuals page never seeds conversations, uploads files or mentions references", () => {
  assert.doesNotMatch(main, /useReference|manualReferencePrompt/)
  assert.doesNotMatch(onboarding, /useReference|manualReferencePrompt/)
  const manuals = main.slice(main.indexOf("function ManualsPage("), main.indexOf("function ManualEditorForm("))
  assert.doesNotMatch(manuals, /CtxIntegrationCard|integrations\/ctx/)
  assert.doesNotMatch(manuals, /type="file"|\/threads\/start/)
})

test("manuals are never presented as \"references\" in user-facing copy", () => {
  for (const source of [main, onboarding]) {
    assert.doesNotMatch(source, /手册引用/)
    assert.doesNotMatch(source, /Manual references?/i)
  }
})

test("help is a normal route and model connection errors have explicit, non-blocking recovery", () => {
  assert.match(main, /path="\/help" element=\{<Page/)
  assert.match(main, /to: "\/help", label: t\("help"\), icon: CircleHelpIcon/)
  const composer = main.slice(main.indexOf("function NewThreadPage("), main.indexOf("function ThreadConversation("))
  assert.match(composer, /const connection = useNormaiConnection\(sdk\)/)
  assert.match(composer, /connection\.error && <Alert>/)
  assert.match(composer, /connection\.refetch\(\)/)
  assert.match(composer, /<Link to="\/configuration">\{help\.modelAction\}/)
  assert.doesNotMatch(composer, /disabled=\{[^}]*connection\.(isError|error|isPending)/)
})
