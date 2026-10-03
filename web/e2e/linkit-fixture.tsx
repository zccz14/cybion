import type { ReactNode } from "react"
import type { Request } from "@playwright/test"
import { createBrowserSdk } from "auth-mini/sdk/browser"
import { AuthMiniProvider } from "auth-mini-react-components"
import { LinkitProvider } from "linkit-react-components"

// Shared plumbing for fixtures that render `LinkitUserPicker`. The provider
// resolves its absolute `/api/...` paths against this dedicated origin, so
// Linkit traffic stays apart from the Cybion `/api/**` routes each spec stubs.
export type LinkitFixtureUser = { user_id: string; username: string; avatar_url: string | null }
export type LinkitFixtureResponse = { status?: number; contentType?: string; body?: string; json?: unknown; headers?: Record<string, string> }
export const linkitFixtureOrigin = "http://linkit.fixture"
const authMiniFixtureBaseUrl = () => new URL("/linkit-auth", window.location.origin).toString()

export async function adoptLinkitFixtureSession() {
  await createBrowserSdk(authMiniFixtureBaseUrl()).session.acceptRedirectCallback({
    access_token: "fixture-token",
    session_id: "fixture-session",
    refresh_token: "fixture-refresh",
    expires_in: 3600,
  })
}

export function LinkitFixtureProviders({ lang = "en", children }: { lang?: string; children: ReactNode }) {
  return <AuthMiniProvider authMiniBaseUrl={authMiniFixtureBaseUrl()} autoRedirectToLogin={false}>
    <LinkitProvider linkitBaseUrl={linkitFixtureOrigin} lang={lang}>{children}</LinkitProvider>
  </AuthMiniProvider>
}

export function linkitFixtureResponse(request: Request, users: readonly LinkitFixtureUser[]): LinkitFixtureResponse | null {
  const url = new URL(request.url())
  if (url.origin !== linkitFixtureOrigin) return null
  const headers = {
    "Access-Control-Allow-Origin": request.headers()["origin"] ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type",
  }
  if (request.method() === "OPTIONS") return { status: 204, headers }
  const path = url.pathname
  if (path === "/api/users/search") {
    const query = (url.searchParams.get("query") ?? "").trim().toLowerCase()
    return { json: query ? users.filter((user) => user.username.toLowerCase().startsWith(query) || user.user_id.toLowerCase().startsWith(query)) : [], headers }
  }
  if (path === "/api/me") return { json: { id: "fixture-viewer", profile: null }, headers }
  if (path.startsWith("/api/public/profiles/")) return { status: 404, json: { error: "Linkit fixture profile not found" }, headers }
  if (path === "/api/unread-count") return { json: { total: 0 }, headers }
  if (path === "/api/events") return { contentType: "text/event-stream", body: "", headers }
  return { status: 404, json: { error: `Linkit fixture endpoint not stubbed: ${path}` }, headers }
}
