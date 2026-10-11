/**
 * Search-engine-result-page provider plugin. It contributes a `WebSearchProvider` to the `ctx.web`
 * registry, so a deployment searches the web through the engines' own result pages — with no
 * vendor search API, no API key, and no auxiliary model request — while the model-facing
 * `web_search` tool keeps its schema, prompt guidance, result text, and card unchanged.
 * @module @deepseek-ai/dsh-web-search-serp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SERP_ENGINE_IDS } from './engines.ts'
import {
  SerpSearchProvider,
  SERP_DEFAULT_MAX_HTML_CHARS,
  SERP_DEFAULT_MAX_RESULTS_PER_ENGINE,
  SERP_DEFAULT_MIN_INTERVAL_MS,
  SERP_DEFAULT_TIMEOUT_MS,
  SERP_DEFAULT_USER_AGENT,
} from './provider.ts'
import type { SerpSearchProviderOptions } from './provider.ts'
import type { SerpEngineId } from './types.ts'

export {
  ENGINE_SPECS,
  parseBaidu,
  parseBing,
  parseSo360,
  SERP_ENGINE_IDS,
} from './engines.ts'
export {
  describeFailure,
  mergeEngineHits,
  RequestGate,
  SerpSearchProvider,
  SERP_DEFAULT_MAX_HTML_CHARS,
  SERP_DEFAULT_MAX_RESULTS_PER_ENGINE,
  SERP_DEFAULT_MIN_INTERVAL_MS,
  SERP_DEFAULT_TIMEOUT_MS,
  SERP_DEFAULT_USER_AGENT,
  SERP_PROVIDER_ID,
} from './provider.ts'
export type { EngineSpec } from './engines.ts'
export type { SerpClock, SerpSearchProviderOptions } from './provider.ts'
export type { SerpEngineId, SerpHit } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-serp'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the shipped defaults). */
export interface Config {
  /** Engines to query, in result-merge order. Defaults to every supported engine. */
  engines?: SerpEngineId[]
  /** Endpoint override by engine, for a mirror or a test double. Omitted engines use their default. */
  endpoints?: Partial<Record<SerpEngineId, string>>
  /** Per-search budget (ms), covering every engine request that search starts. Defaults to 8000. */
  timeoutMs?: number
  /** Minimum gap (ms) between two requests to one engine host. `0` disables throttling. Defaults to 1000. */
  minIntervalMs?: number
  /** Largest number of rows read from one engine's page. Defaults to 10. */
  maxResultsPerEngine?: number
  /** Largest fetched document the parsers read. Defaults to 2000000. */
  maxHtmlChars?: number
  /** User agent sent with every engine request. Defaults to a browser identity. */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  // Declared here rather than only at the use site: a configuration surface renders the resolved
  // section, and this schema materializes an absent array as empty, so an unset `engines` would
  // otherwise read as "no engines" instead of the shipped set.
  engines: z.array(z.union(SERP_ENGINE_IDS)).default([...SERP_ENGINE_IDS]),
  endpoints: z.object({
    baidu: z.string(),
    bing: z.string(),
    so360: z.string(),
  }),
  timeoutMs: z.number().step(1).min(1),
  minIntervalMs: z.number().step(1).min(0),
  maxResultsPerEngine: z.number().step(1).min(1),
  maxHtmlChars: z.number().step(1).min(1),
  userAgent: z.string(),
})

/**
 * Reject a configured bound that cannot serve a search.
 * @param field - the config field name used in the message.
 * @param value - the configured value.
 */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-search-serp: ${field} must be a positive integer`)
  }
}

/**
 * Register the engine-scraping search provider with `ctx.web`.
 *
 * Misconfiguration fails at load: an empty engine list or a non-positive bound throws here rather
 * than failing every search later with an unrelated error.
 * @param ctx - the context whose `web` registry receives the provider.
 * @param config - the plugin section; every absent field takes its shipped default.
 */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? SERP_DEFAULT_TIMEOUT_MS
  const minIntervalMs = config.minIntervalMs ?? SERP_DEFAULT_MIN_INTERVAL_MS
  const maxResultsPerEngine = config.maxResultsPerEngine ?? SERP_DEFAULT_MAX_RESULTS_PER_ENGINE
  const maxHtmlChars = config.maxHtmlChars ?? SERP_DEFAULT_MAX_HTML_CHARS
  const engines = config.engines ?? [...SERP_ENGINE_IDS]
  assertPositiveInteger('timeoutMs', timeoutMs)
  assertPositiveInteger('maxResultsPerEngine', maxResultsPerEngine)
  assertPositiveInteger('maxHtmlChars', maxHtmlChars)
  if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
    throw new Error('web-search-serp: minIntervalMs must be a non-negative integer')
  }
  if (engines.length === 0) {
    throw new Error('web-search-serp: engines must name at least one engine')
  }
  const options: SerpSearchProviderOptions = {
    engines,
    endpoints: config.endpoints ?? {},
    timeoutMs,
    minIntervalMs,
    maxResultsPerEngine,
    maxHtmlChars,
    userAgent: config.userAgent ?? SERP_DEFAULT_USER_AGENT,
  }
  ctx.web.registerSearchProvider(new SerpSearchProvider(options))
}
