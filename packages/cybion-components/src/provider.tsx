import { createContext, useContext, useMemo, type AnchorHTMLAttributes, type ReactNode } from "react"

import { CybionThreadClient, type CybionClientOptions, type Language } from "./api"
import { copyFor, type CopyKey } from "./copy"

export type CybionLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }

/**
 * Links inside the thread point at the host app (a manual, another thread). The
 * host injects its router's Link here; the default keeps a plain anchor so the
 * package works without a router.
 */
export type CybionLink = (props: CybionLinkProps) => ReactNode

type CybionContextValue = {
  client: CybionThreadClient
  language: Language
  identity: string
  t: (key: CopyKey) => string
  link: CybionLink
}

const CybionContext = createContext<CybionContextValue | null>(null)

const defaultLink: CybionLink = ({ href, children, ...rest }) => <a href={href} {...rest}>{children}</a>

export type CybionThreadProviderProps = CybionClientOptions & {
  language?: Language
  /** Scope for composer drafts kept in localStorage; normally the signed-in user ID. */
  identity?: string
  link?: CybionLink
  children: ReactNode
}

/**
 * Wires the thread surface to one Cybion origin and one token source. Everything
 * below it (`CybionThreadView`) only needs a thread ID.
 */
export function CybionThreadProvider({ baseUrl, getToken, fetch, language = "zh", identity = "anonymous", link, children }: CybionThreadProviderProps) {
  const value = useMemo<CybionContextValue>(() => ({
    client: new CybionThreadClient({ baseUrl, getToken, fetch }),
    language,
    identity,
    t: (key) => copyFor(language, key),
    link: link ?? defaultLink,
  }), [baseUrl, getToken, fetch, language, identity, link])
  return <CybionContext.Provider value={value}>{children}</CybionContext.Provider>
}

/**
 * Links inside record cards point at the host (a Manual, another Thread). A card
 * rendered outside a provider — a test page, a host composing one record — still
 * gets a working plain anchor.
 */
export function useCybionLink(): CybionLink {
  return useContext(CybionContext)?.link ?? defaultLink
}

export function useCybion() {
  const value = useContext(CybionContext)
  if (!value) throw new Error("CybionThreadView must be rendered inside CybionThreadProvider")
  return value
}
