import type { ModelCatalog } from "../components/thread-settings-popover"

/// Image generation runs over the Thread's own upstream, so its options are
/// that upstream's image catalog; saved values stay selectable even when the
/// upstream stops reporting them. Account defaults use the same rule with no
/// upstream in mind.
export function imageModelOptions(catalogs: ModelCatalog[] | undefined, upstreamId: string | null, values: (string | null)[]) {
  const groups = (catalogs ?? []).filter((group) => upstreamId === null || group.id === upstreamId)
  const models = new Set<string>()
  for (const group of groups) for (const model of group.models) models.add(model)
  for (const value of values) if (value) models.add(value)
  return [...models]
}
