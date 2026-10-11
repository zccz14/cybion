import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { needsFirstConversationCheck, onboardingCopy, contextReferenceExample, contextReferencePrompt } from "../src/lib/onboarding.ts"

const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8")

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

test("Chinese and English help are complete, reference-first and honest about retained results", () => {
  assert.deepEqual(Object.keys(onboardingCopy.en), Object.keys(onboardingCopy.zh))
  for (const language of ["en", "zh"] as const) for (const value of Object.values(onboardingCopy[language])) assert.ok(value.trim())
  assert.match(onboardingCopy.zh.contextSummary, /轻量的引用.*不是资料本体/)
  assert.match(onboardingCopy.zh.contextDetail, /Worker.*CTX.*根据任务需要/)
  assert.match(onboardingCopy.zh.contextBoundary, /读取的内容仍可能进入.*对话记录/)
  assert.match(onboardingCopy.en.contextBoundary, /retrieved.*conversation's records/)
  assert.match(onboardingCopy.zh.workerOptional, /普通对话不需要 Worker/)
  assert.match(onboardingCopy.en.workerOptional, /Optional for normal conversation/)
})

test("reference examples contain locations and reading steps, never copied source material", () => {
  for (const language of ["en", "zh"] as const) {
    const device = contextReferenceExample(language, "device")
    const network = contextReferenceExample(language, "network")
    assert.match(device.content, /Worker.*\/path\/to\/project\//)
    assert.match(device.content, /README\.md/)
    assert.match(network.content, /https:\/\/example\.com\/docs\//)
    for (const example of [device, network]) {
      assert.deepEqual(Object.keys(example), ["name", "description", "content"])
      assert.ok(example.content.length < 500)
    }
  }
})

test("using a saved reference only seeds the ordinary composer, preserving existing drafts", () => {
  for (const language of ["en", "zh"] as const) {
    const prompt = contextReferencePrompt(language, "Project A", "context-123")
    assert.ok(prompt.includes("Project A"))
    assert.ok(prompt.includes("context_id: context-123"))
  }
  assert.match(main, /initialInput: contextReferencePrompt\(language, selected\.name, selected\.id\)/)
  assert.match(main, /seed\(initialInput\)/)
  assert.match(main, /seed\(example\); inputRef\.current\?\.focus\(\)/)
  const contexts = main.slice(main.indexOf("function ContextsPage("), main.indexOf("function ContextTree("))
  assert.match(contexts, /<CtxIntegrationCard sdk=\{sdk\} \/>/)
  assert.doesNotMatch(contexts, /type="file"|\/threads\/start/)
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
