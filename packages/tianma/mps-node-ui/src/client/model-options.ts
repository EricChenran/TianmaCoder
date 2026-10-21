/**
 * The provider/model route a node's deployment chooses, taken from the same catalog the
 * session model selector lists. One deployment states one route for the whole node, so the
 * form offers one list of routes — grouped by provider, exactly as Settings → Models shows
 * them — and a choice can never be half a pair that the default-model row would refuse.
 * @module @tianma/dsh-mps-node-ui/model-options
 */

/** One model the catalog advertises for a provider route. */
export interface NodeModelChoice {
  /** Provider-owned model id, which the deployment stores as-is. */
  id: string
  /** Name the platform shows for it. */
  name: string
}

/** One provider route and the models it advertises. */
export interface NodeModelGroup {
  /** Registered provider route id, such as `deepseek-official`. */
  id: string
  /** Name the platform shows for the route. */
  name: string
  /** Models this route advertises, in catalog order. */
  models: NodeModelChoice[]
}

/** One selectable route: a provider and one of its models. */
export interface NodeRouteChoice {
  /** Provider route the choice states. */
  provider: string
  /** Model id the choice states. */
  model: string
  /** Select value, `provider/model`, resolved back through {@link routeOfChoice}. */
  value: string
  /** Text the option shows: the model's own name. */
  label: string
  /** Group the option sits under: the provider's name. */
  group: string
}

/** The separator between the provider and the model in one select value. */
export const ROUTE_SEPARATOR = '/'

/**
 * One selectable route per advertised model, in catalog order.
 * @param groups - the catalog's provider routes.
 * @returns the routes, grouped by provider.
 */
export function routeChoices(groups: readonly NodeModelGroup[]): NodeRouteChoice[] {
  const choices: NodeRouteChoice[] = []
  for (const group of groups) {
    for (const model of group.models) {
      choices.push({
        provider: group.id,
        model: model.id,
        value: `${group.id}${ROUTE_SEPARATOR}${model.id}`,
        label: model.name === '' ? model.id : model.name,
        group: group.name === '' ? group.id : group.name,
      })
    }
  }
  return choices
}

/**
 * The select value one stored route matches, so the select shows it selected.
 * @param provider - the stored provider route.
 * @param model - the stored model id.
 * @returns the select value, or an empty string when the deployment states no pair.
 */
export function routeValue(provider: string | undefined, model: string | undefined): string {
  const stated = (provider ?? '').trim()
  const chosen = (model ?? '').trim()
  if (stated === '' || chosen === '') return ''
  return `${stated}${ROUTE_SEPARATOR}${chosen}`
}

/**
 * Resolve one select value into the two fields a deployment stores.
 * @param value - the picked select value, or an empty string for the profile's default.
 * @returns the provider and model to store, both empty when the default was picked.
 */
export function routeFields(value: string): { agentProvider: string; agentModel: string } {
  const index = value.indexOf(ROUTE_SEPARATOR)
  if (index <= 0) return { agentProvider: '', agentModel: '' }
  return { agentProvider: value.slice(0, index), agentModel: value.slice(index + 1) }
}

/**
 * The text a read-only row shows for one stored route.
 * @param provider - the stored provider route.
 * @param model - the stored model id.
 * @param fallback - text to show when the deployment states no pair.
 * @returns the route as `provider / model`, or the fallback.
 */
export function routeLabel(provider: string | undefined, model: string | undefined, fallback: string): string {
  const value = routeValue(provider, model)
  return value === '' ? fallback : value.replace(ROUTE_SEPARATOR, ' / ')
}
