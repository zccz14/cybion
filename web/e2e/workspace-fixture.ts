import { generateKeyPairSync, sign } from "node:crypto"
import { readFileSync } from "node:fs"
import type { Page } from "@playwright/test"
import { emptyThreadUsage } from "../src/lib/thread-usage"

// Exercise the real app, including Auth Mini verification, with a test-only

// signing key and intercepted HTTP. No production credentials or calls escape.
export async function stubWorkspace(page: Page, options: {
  language?: "zh" | "en"; theme?: "light" | "dark"; activeTotal?: number; webTotal?: number; archivedTotal?: number;
  countFails?: boolean; connectionFails?: boolean; startFails?: boolean; fallbackReady?: boolean;
  contexts?: { id: string; name: string; parent_id?: string | null }[];
} = {}) {
  const language = options.language ?? "zh", theme = options.theme ?? "light"
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "workspace-fixture", alg: "EdDSA", use: "sig" }
  const now = Math.floor(Date.now() / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const unsigned = `${encode({ alg: "EdDSA", kid: jwk.kid })}.${encode({ iss: "https://auth.ntnl.io", sub: "onboarding-user", sid: "onboarding-session", aud: ["cybion.ntnl.io", "linkit.ntnl.io", "openai.ntnl.io", "ctx.ntnl.io", "normai.ntnl.io", "127.0.0.1"], iat: now, exp: now + 3600 })}`
  const token = `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString("base64url")}`
  await page.addInitScript(({ token, language, theme }) => {
    localStorage.setItem("auth-mini.sdk:https://auth.ntnl.io/", JSON.stringify({ sessionId: "onboarding-session", accessToken: token, refreshToken: "fixture-refresh", receivedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }))
    localStorage.setItem("cybion.language", language)
    localStorage.setItem("linkit.theme", theme)
  }, { token, language, theme })
  const references: { id: string; name: string; description: string; content: string; parent_id: string | null; sort_key: string }[] = []
  const writes: { path: string; body: Record<string, unknown> }[] = []
  const requests: string[] = [], unexpected: string[] = []
  page.on("pageerror", (error) => unexpected.push(`Page error: ${error.message}`))
  const state = { connectionFails: options.connectionFails ?? false }
  const profile = { user_id: "onboarding-user", username: "onboarding", intro: "", lang: language, theme, avatar_url: null }
  const release = JSON.parse(readFileSync(new URL("../../worker-release.json", import.meta.url), "utf8"))
  const upstream = { id: options.fallbackReady ? "manual-upstream" : "normai-upstream", name: options.fallbackReady ? "Manual" : "NormAI", base_url: options.fallbackReady ? "https://model.fixture" : "https://normai.ntnl.io", api_key_configured: true }
  const defaults = { model: "deepseek-flash", upstream_id: options.connectionFails && !options.fallbackReady ? null : upstream.id, reasoning_effort: "medium", service_tier_fast: false, context_budget_tokens: 200000, minimal_mode: false, image_generation_model: "" }
  const thread = { ...defaults, id: "created-thread", title: "Fixture conversation", status: "idle", display_status: "ready", usage: emptyThreadUsage, context_tokens: 0, archived_at: null, created_at: now, updated_at: now, created_by: "web", external_ref: null }
  const notifications = { enabled: true, configured: true, bot_id: "fixture-bot", recipient_username: "onboarding", last_attempt_at: null, last_success_at: null, last_error: null, conversation_id: null, message_id: null }
  // Mirror the controller: every group keeps fractional-style keys in array order.
  const renumberContextSortKeys = () => {
    const groups = new Map<string | null, typeof references>()
    for (const reference of references) {
      const key = reference.parent_id ?? null
      groups.set(key, [...(groups.get(key) ?? []), reference])
    }
    for (const group of groups.values()) group.forEach((reference, index) => { reference.sort_key = String(index).padStart(2, "0") })
  }
  for (const context of options.contexts ?? []) {
    references.push({ id: context.id, name: context.name, description: `Metadata for ${context.name}`, content: `${context.name} content`, parent_id: context.parent_id ?? null, sort_key: "" })
  }
  renumberContextSortKeys()
  await page.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname
    const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "authorization,content-type" }
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers })
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    if (url.hostname === "auth.ntnl.io") {
      if (path === "/jwks") return json({ keys: [jwk] })
      if (path === "/time") return json({ now_ms: Date.now() })
    }
    if (url.hostname === "linkit.ntnl.io") {
      if (path === "/api/me") return json({ id: profile.user_id, profile })
      if (path.startsWith("/api/public/profiles/")) return json(profile)
      if (path === "/api/unread-count") return json({ total: 0 })
      if (path === "/api/events") return route.fulfill({ contentType: "text/event-stream", body: "", headers })
    }
    if (url.hostname === "127.0.0.1" && path.startsWith("/api/")) {
      requests.push(path + url.search)
      if (!["GET", "HEAD"].includes(request.method())) writes.push({ path, body: request.postDataJSON() ?? {} })
      if (path === "/api/me") return json({ user_id: profile.user_id, hosted: true, is_admin: false })
      if (path === "/api/thread-defaults") return json(defaults)
      if (path === "/api/integrations/normai") {
        if (state.connectionFails) return json({ error: "Fixture: model connection unavailable" }, 503)
        defaults.upstream_id ??= upstream.id
        return json(upstream)
      }
      if (path === "/api/integrations/upstreams") return json(defaults.upstream_id ? [upstream] : [])
      if (path === "/api/integrations/upstreams/models") return json({ upstreams: defaults.upstream_id ? [{ ...upstream, models: [defaults.model], error: null }] : [] })
      if (path === "/api/integrations/linkit") return json(notifications)
      if (path === "/api/workers") return json([])
      if (path === "/api/worker-release") return json(release)
      if (path === "/api/threads") {
        if (url.searchParams.get("limit") === "1" && options.countFails) return json({ error: "Fixture: count unavailable" }, 503)
        const archived = url.searchParams.has("archived")
        const total = archived ? options.archivedTotal ?? 0 : url.searchParams.has("q") || url.searchParams.has("status") ? 0 : url.searchParams.get("origin") === "web" ? options.webTotal ?? options.activeTotal ?? 0 : options.activeTotal ?? 0
        return json({ items: total ? [{ ...thread, archived_at: archived ? now : null }] : [], total, next_cursor: null })
      }
      if (path === "/api/threads/start" && options.startFails) return json({ error: "Fixture: model access denied" }, 403)
      if (path === "/api/threads/start") return json({ thread_id: thread.id, record_idx: 1, status: "accepted" })
      if (path === `/api/threads/${thread.id}`) return json(thread)
      if (path === `/api/threads/${thread.id}/history/window`) return json({ records: [], has_older: false })
      if (path === `/api/threads/${thread.id}/response`) return json(null)
      if (path === `/api/threads/${thread.id}/grants`) return json([])
      if (path === "/api/contexts") {
        if (request.method() === "POST") {
          const reference = { ...request.postDataJSON(), id: references.length === 0 ? "saved-reference" : `saved-reference-${references.length + 1}`, sort_key: "" }
          references.push(reference)
          renumberContextSortKeys()
          return json(reference)
        }
        return json(references)
      }
      if (/^\/api\/contexts\/[^/]+\/move$/.test(path)) {
        const reference = references.find((item) => item.id === path.split("/").at(-2))!
        const body = request.postDataJSON() as { parent_id: string | null; after_id: string | null }
        references.splice(references.indexOf(reference), 1)
        reference.parent_id = body.parent_id ?? null
        if (body.after_id) {
          const afterIndex = references.findIndex((item) => item.id === body.after_id)
          references.splice(afterIndex + 1, 0, reference)
        } else {
          const firstIndex = references.findIndex((item) => (item.parent_id ?? null) === (body.parent_id ?? null))
          references.splice(firstIndex === -1 ? references.length : firstIndex, 0, reference)
        }
        renumberContextSortKeys()
        return json(reference)
      }
      if (path.startsWith("/api/contexts/")) {
        const reference = references.find((item) => item.id === path.split("/").at(-1))!
        Object.assign(reference, request.postDataJSON())
        return json(reference)
      }
      if (path === "/api/common-contexts") return json({
        revision: 1,
        root: {
          id: "common-root",
          name: "Cybion Common Context",
          description: "Compiled into Cybion from its source tree, shared by every user, read-only",
          content: "# Cybion Common Context\n\nFixture content.",
          children: [],
        },
      })
    }
    if (url.hostname === "127.0.0.1" && !path.startsWith("/api/")) return route.continue()
    unexpected.push(request.url())
    return json({ error: "Unstubbed fixture request" }, 404)
  })
  return { state, writes, requests, references, unexpected }
}
