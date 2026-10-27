/**
 * Effective endpoint, protocol, and per-model connections of one installed
 * catalog route.
 *
 * `/provider` probes a route's endpoint live when the profile stores a
 * baseURL. A catalog route may inherit that endpoint instead: the provider
 * directory reports `defaultBaseURL` for single-endpoint catalogs, while
 * providers whose models each carry their own endpoint (opencode-go, say)
 * report none. Editing such a route still needs an endpoint to refresh its
 * model list, so read it from the catalog the host's dsh-llm-pi-ai owns.
 *
 * The adapter's own pi-ai dependency is resolved rather than importing a
 * second copy: different host prereleases can pin different pi-ai versions,
 * and catalog objects must come from the instance the adapter actually uses.
 * The installed `dsh` on PATH is preferred because a profile can link dsh-tui
 * to a checkout whose dev dependency is older than the running host; a bare
 * or checkout-only run falls back to this package's peer. The lookup is
 * synchronous and cached because the provider host lists routes
 * synchronously; a missing package degrades to "no catalog endpoint" instead
 * of failing `/provider`.
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { findHostDsh } from './host-dsh.js'

interface CatalogModel {
  readonly id: string
  readonly api: string
  readonly baseUrl?: string
}

interface CatalogProvider {
  readonly id: string
  readonly baseUrl?: string
  getModels(): readonly CatalogModel[]
}

interface ProviderCatalogModule {
  builtinProviders(): readonly CatalogProvider[]
}

/** Protocols the host's model-discovery seam can list. */
const LISTABLE_APIS = new Set([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

let installed: readonly CatalogProvider[] | undefined

function installedCatalog(): readonly CatalogProvider[] {
  if (installed !== undefined) return installed
  installed = []
  for (const adapterManifest of adapterManifests()) {
    const catalog = catalogFile(adapterManifest)
    if (catalog === undefined) continue
    try {
      installed = (createRequire(adapterManifest)(catalog) as ProviderCatalogModule).builtinProviders()
      break
    } catch {
      // A catalog this build cannot load synchronously: try the next adapter.
    }
  }
  return installed
}

/**
 * Adapter manifests to try, most authoritative first.
 *
 * A profile install can link dsh-tui to a checkout whose dev dependencies
 * pin an older pi-ai than the running host; the endpoint recorded there can
 * then be stale. Resolve the adapter the installed `dsh` on PATH depends on
 * first (the instance actually serving `llm`), and fall back to this
 * package's peer for bare or checkout runs with no host CLI.
 */
function adapterManifests(): readonly string[] {
  const manifests: string[] = []
  const host = findHostDsh()
  if ('packageDir' in host) {
    try {
      manifests.push(createRequire(join(host.packageDir, 'package.json'))
        .resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
    } catch {
      // Host without the adapter: fall through to this package's peer.
    }
  }
  try {
    manifests.push(import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai/package.json'))
  } catch {
    // Bare composition with no adapter at all.
  }
  return manifests
}

/** The pi-ai catalog file shipped beside one adapter manifest. */
function catalogFile(adapterManifest: string): string | undefined {
  try {
    const require = createRequire(adapterManifest)
    for (const root of require.resolve.paths('@earendil-works/pi-ai') ?? []) {
      const entry = join(root, '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js')
      if (existsSync(entry)) return entry
    }
  } catch {
    // Fall through to the next candidate.
  }
  return undefined
}

/** One endpoint/protocol pair a catalog route's models actually use. */
export interface CatalogRouteConnection {
  readonly baseURL: string
  readonly api?: string
}

/** Catalog facts a provider profile inherits instead of storing. */
export interface CatalogRouteInfo {
  /** Route-level endpoint the adapter uses for a model the catalog lacks. */
  readonly baseURL?: string
  /** The single protocol every catalog model speaks; absent for mixed catalogs. */
  readonly sharedApi?: string
  /** Catalog connection of each described model, by id. */
  readonly connections: Readonly<Record<string, CatalogRouteConnection>>
  /** Pair to probe live, or undefined when no model names a usable endpoint. */
  readonly connection?: CatalogRouteConnection
}

/**
 * Read the installed catalog's facts for `provider`.
 *
 * Models the profile already enables decide the probe pair first: their
 * catalog entries name the exact endpoint and protocol the route serves them
 * on, which is the only sound choice for a catalog whose models span several
 * endpoints (opencode-go splits anthropic-messages and OpenAI-style models
 * across two URLs). With no usable enabled model, the endpoint serving the
 * most listable models wins and ties keep catalog order. Protocols the
 * discovery seam cannot list (`google-generative-ai`) never vote.
 *
 * `connections` lets the wizard verify a selected set before it pins an
 * inherited route to one endpoint/protocol so endpoint-only models can be
 * materialized: such a pin overrides each model's own catalog `baseUrl`/`api`
 * for the whole route, so a mixed selection must not be written.
 *
 * @param provider - catalog route key.
 * @param preferredModels - model ids the profile enables, in stored order.
 * @returns the route's facts, or undefined when it is not in the installed
 *   catalog.
 */
export function catalogRouteInfo(
  provider: string,
  preferredModels: readonly string[] = [],
): CatalogRouteInfo | undefined {
  const entry = installedCatalog().find(candidate => candidate.id === provider)
  if (entry === undefined) return undefined
  const routeBase = usableBaseURL(entry.baseUrl)
  const models = entry.getModels().flatMap(model => {
    const baseURL = usableBaseURL(model.baseUrl) ?? routeBase
    return baseURL === undefined ? [] : [{ id: model.id, api: model.api, baseURL }]
  })
  const connections = Object.fromEntries(models.map(model => [
    model.id,
    { baseURL: model.baseURL, api: model.api },
  ]))
  const apis = new Set(entry.getModels().map(model => model.api))
  const sharedApi = apis.size === 1 ? [...apis][0] : undefined
  const connection = preferredConnection(models, preferredModels) ?? majorityConnection(models) ?? (
    routeBase === undefined ? undefined : { baseURL: routeBase }
  )
  return {
    ...(routeBase === undefined ? {} : { baseURL: routeBase }),
    ...(sharedApi === undefined ? {} : { sharedApi }),
    connections,
    ...(connection === undefined ? {} : { connection }),
  }
}

function preferredConnection(
  models: readonly { readonly id: string; readonly api: string; readonly baseURL: string }[],
  preferredModels: readonly string[],
): CatalogRouteConnection | undefined {
  const byId = new Map(models.map(model => [model.id, model] as const))
  for (const id of preferredModels) {
    const model = byId.get(id)
    if (model !== undefined && LISTABLE_APIS.has(model.api)) {
      return { baseURL: model.baseURL, api: model.api }
    }
  }
  return undefined
}

function majorityConnection(
  models: readonly { readonly id: string; readonly api: string; readonly baseURL: string }[],
): CatalogRouteConnection | undefined {
  const groups = new Map<string, { baseURL: string; count: number; apis: Map<string, number> }>()
  for (const model of models) {
    if (!LISTABLE_APIS.has(model.api)) continue
    const group = groups.get(model.baseURL) ?? { baseURL: model.baseURL, count: 0, apis: new Map() }
    group.count += 1
    group.apis.set(model.api, (group.apis.get(model.api) ?? 0) + 1)
    groups.set(model.baseURL, group)
  }
  let best: { baseURL: string; count: number; apis: Map<string, number> } | undefined
  for (const group of groups.values()) {
    if (best === undefined || group.count > best.count) best = group
  }
  if (best === undefined) return undefined
  const api = [...best.apis.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
  return { baseURL: best.baseURL, ...(api === undefined ? {} : { api }) }
}

/** A concrete, non-templated endpoint the discovery seam can address. */
function usableBaseURL(value: string | undefined): string | undefined {
  return value === undefined || value === '' || value.includes('{') ? undefined : value
}
