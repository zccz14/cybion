/// One upstream's catalog as `GET /api/integrations/upstreams/models` answers it.
export type ModelCatalog = {
  id: string
  name: string
  models: string[]
  error: string | null
}

/// One Manual the picker can offer: the ids `GET /api/manual-summaries`
/// answers with, and nothing else about the Manual.
export type ManualChoice = { manual_id: string; name: string }

// A model is chosen as an upstream/model pair; the encoded value keeps the two
// entries apart even when two upstreams report the same model id.
export function modelSelection(upstreamId: string | null, model: string) {
  return upstreamId ? `${upstreamId}:${model}` : ""
}

export function parseModelSelection(value: string) {
  const index = value.indexOf(":")
  return { upstreamId: value.slice(0, index), model: value.slice(index + 1) }
}

// Each upstream owns its catalog, but a thread saved earlier must stay
// selectable even after its upstream stops reporting the model.
export function modelGroups(catalogs: ModelCatalog[] | undefined, upstreamId: string | null, model: string) {
  const groups = catalogs ?? []
  if (!upstreamId) return groups
  if (groups.some((group) => group.id === upstreamId)) {
    return groups.map((group) => group.id === upstreamId && !group.models.includes(model) ? { ...group, models: [model, ...group.models] } : group)
  }
  return [...groups, { id: upstreamId, name: "", models: [model], error: null }]
}

// Image generation runs over the Thread's own upstream, so its options are
// that upstream's image catalog; saved values stay selectable even when the
// upstream stops reporting them.
export function imageModelOptions(catalogs: ModelCatalog[] | undefined, upstreamId: string | null, values: (string | null)[]) {
  const groups = (catalogs ?? []).filter((group) => upstreamId === null || group.id === upstreamId)
  const models = new Set<string>()
  for (const group of groups) for (const model of group.models) models.add(model)
  for (const value of values) if (value) models.add(value)
  return [...models]
}
