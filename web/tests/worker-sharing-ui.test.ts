import assert from "node:assert/strict"
import test from "node:test"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router-dom"
import { AuthMiniProvider } from "auth-mini-react-components"
import { LinkitProvider } from "linkit-react-components"
import { createTestServer } from "./vite-server.ts"

const sessionId = "session-not-uid"
const withLinkit = (children: ReactElement) => createElement(AuthMiniProvider, { authMiniBaseUrl: "https://auth.test", autoRedirectToLogin: false }, createElement(LinkitProvider, { linkitBaseUrl: "https://linkit.test" }, children))
const owner = { id: "owned", label: "Owner device", owner_user_id: "stable-owner", access: "owner", status: "online", created_at: 1 }
const shared = { id: "shared", label: "Shared device", owner_user_id: "remote-owner", access: "shared", status: "unknown", created_at: 1 }

test("real WorkerConnections separates access roles and exposes the stable UID without shared owner controls", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  try {
    const { WorkerConnections } = await server.ssrLoadModule("/src/components/worker-connections.tsx")
    client.setQueryData(["me", sessionId], { user_id: "stable-owner" })
    client.setQueryData(["workers", sessionId], [shared])
    client.setQueryData(["worker-release"], { version: "v0.2.0", platforms: [], release_url: "" })
    const render = (language: string) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, {}, createElement(WorkerConnections, { sessionId, language, request: () => { throw new Error("Unexpected request during render") } }))))
    const html = render("en")
    assert.match(html, /Shared with me/)
    assert.match(html, /remote-owner/)
    assert.match(html, /Unknown · not queried live/)
    assert.match(html, /stable-owner/)
    assert.doesNotMatch(html, /session-not-uid/)
    assert.match(html, /href="\/threads\/new"/)
    for (const label of ["Share access", "Rename", "Remove", "Upgrade Worker", "Run connection check", "Command execution verified; ready to use", "Generate manual configuration"]) assert.ok(!html.includes(label), label)
    assert.match(render("zh"), /与我共享/)
    client.setQueryData(["workers", sessionId], [owner, shared])
    const mixed = render("en")
    assert.equal(mixed.match(/>Share access</g)?.length, 1)
    assert.equal(mixed.match(/>Run connection check</g)?.length, 1)
  } finally { client.clear(); await server.close() }
})

test("real grant panel picks recipients through the Linkit user picker and renders active, revoked and unsynced recipients with explicit consent in both languages", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" })
  const client = new QueryClient()
  try {
    const { WorkerSharing } = await server.ssrLoadModule("/src/components/worker-sharing.tsx")
    const grant = { grantee_user_id: "recipient", grant_id: "g1", revoked_at: null, revision: 2, synced_revision: 1, created_at: 1, updated_at: 1 }
    client.setQueryData(["worker-grants", sessionId, "owned"], [grant, { ...grant, grant_id: "g2", grantee_user_id: "revoked-user", revoked_at: 2, synced_revision: 2 }])
    const render = (language: string) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, withLinkit(createElement(WorkerSharing, { sessionId, userId: "stable-owner", workerId: "owned", language, request: () => { throw new Error("Unexpected request") } }))))
    const html = render("en")
    for (const text of ["recipient", "revoked-user", "Active", "Revoked", "Propagation pending", "Synced", "without a sandbox", "OS account", "audit commands and results", "Search the Linkit directory by username or UUID", "The recipient must have signed in to Cybion before"]) assert.ok(html.includes(text), text)
    assert.match(html, /class="linkit-user-picker linkit-user-picker--single"/)
    assert.match(html, /role="combobox"/)
    assert.match(html, /placeholder="Search username, UUID or note"/)
    assert.equal(html.match(/>Revoke access</g)?.length, 1)
    assert.match(html, /type="checkbox"/)
    assert.match(html, /disabled=""[^>]*>Grant access</)
    const zh = render("zh")
    assert.match(zh, /没有沙箱/)
    assert.match(zh, /在 Linkit 目录中按用户名或 UUID 搜索/)
    assert.match(zh, /placeholder="搜索用户名、UUID 或备注"/)
  } finally { client.clear(); await server.close() }
})

test("real audit renders summary metadata without payloads and hides foreign Thread titles and links", async () => {
  const server = await createTestServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" })
  const client = new QueryClient()
  try {
    const { WorkerAudit } = await server.ssrLoadModule("/src/components/worker-audit.tsx")
    client.setQueryData(["me", sessionId], { user_id: "stable-owner" })
    client.setQueryData(["workers", sessionId], [owner])
    const call = { id: "own", caller_user_id: "stable-owner", has_details: true, worker_id: "owned", worker_label: "Owner device", thread_id: "own-thread", thread_title: "My task", input_record_id: 1, name: "bash", arguments: null, result: null, worker_resource: null, status: "completed", error: null, created_at: 1, completed_at: 2 }
    client.setQueryData(["worker-calls", sessionId, "all", "all", 1, 20], { items: [call, { ...call, id: "foreign", caller_user_id: "foreign-uid", thread_id: "secret-thread", thread_title: "Secret title" }], total: 2, page: 1, page_size: 20 })
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, {}, createElement(WorkerAudit, { sessionId, language: "en", request: () => { throw new Error("Unexpected detail request") } }))))
    assert.match(html, /href="\/threads\/own-thread"/)
    assert.match(html, /foreign-uid/)
    assert.doesNotMatch(html, /secret-thread|Secret title/)
    assert.doesNotMatch(html, /<pre/)
    assert.equal(html.match(/<summary/g)?.length, 2)
    assert.equal(client.getQueryCache().findAll({ queryKey: ["worker-call-detail"] }).every((query) => query.state.fetchStatus === "idle"), true)
  } finally { client.clear(); await server.close() }
})
