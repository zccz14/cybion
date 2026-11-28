import { useQuery } from "@tanstack/react-query"

import type { Thread, ThreadDefaults, UpstreamModels, UpstreamSearchSources } from "../api"
import type { ManualChoice } from "../lib/model-catalog"
import { useCybion } from "../provider"

// The literals stand in for the moment before `/api/thread-defaults` lands, so a
// settings panel never shows an empty fallback.
export const FALLBACK_CONTEXT_BUDGET = 200000
export const FALLBACK_LOADED_MANUALS = 12

/** One upstream catalog per kind: text, image, speech-to-text. */
export function useUpstreamModels(kind?: "image" | "sst") {
  const { client } = useCybion()
  return useQuery({
    queryKey: [kind === "image" ? "upstream-image-models" : kind === "sst" ? "upstream-audio-models" : "upstream-models"],
    queryFn: ({ signal }) => client.request<UpstreamModels>(`/api/integrations/upstreams/models${kind ? `?kind=${kind}` : ""}`, { signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/** The web-search sources each of this account's own upstreams serves. */
export function useUpstreamSearchSources() {
  const { client } = useCybion()
  return useQuery({
    queryKey: ["upstream-search-sources"],
    queryFn: ({ signal }) => client.request<UpstreamSearchSources>("/api/integrations/upstreams/search-sources", { signal }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}

/** The Manuals a picker may name; their bodies stay on the Manuals page. */
export function useManualChoices() {
  const { client, identity } = useCybion()
  return useQuery({
    queryKey: ["manual-summaries", identity],
    queryFn: ({ signal }) => client.request<{ manuals: ManualChoice[] }>("/api/manual-summaries", { signal }),
  })
}

/** One Thread exactly as the controller holds it. */
export function useThread(threadId: string) {
  const { client, identity } = useCybion()
  return useQuery({
    queryKey: ["thread", threadId, identity],
    queryFn: () => client.request<Thread>(`/api/threads/${encodeURIComponent(threadId)}`),
    enabled: Boolean(threadId),
  })
}

/** The account defaults every Thread inherits unless it overrides them. */
export function useThreadDefaults() {
  const { client } = useCybion()
  return useQuery({
    queryKey: ["thread-defaults"],
    queryFn: ({ signal }) => client.request<ThreadDefaults>("/api/thread-defaults", { signal }),
  })
}
