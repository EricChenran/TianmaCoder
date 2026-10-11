/**
 * The `WebSearchProvider` that answers a search by scraping engine result pages over plain HTTP:
 * no vendor search API, no API key, and no auxiliary model request. It queries every configured
 * engine concurrently, drops the engines that fail, and merges the survivors into one bounded,
 * deduplicated source list.
 * @module @deepseek-ai/dsh-web-search-serp/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SerpEngineId, SerpHit } from './types.ts'
import { boundHtml, looksChallenged, urlKey } from './html.ts'
import { ENGINE_SPECS } from './engines.ts'

/** Stable id this provider registers under. */
export const SERP_PROVIDER_ID = 'serp'

/** Engines queried when the configuration names none. */
export const SERP_DEFAULT_ENGINES: readonly SerpEngineId[] = ['baidu', 'bing', 'so360']

/** Per-search budget (ms), covering every engine request that search starts. */
export const SERP_DEFAULT_TIMEOUT_MS = 8_000

/** Minimum gap (ms) between two requests to one engine host; `0` disables throttling. */
export const SERP_DEFAULT_MIN_INTERVAL_MS = 1_000

/** Largest number of rows read from one engine's page. */
export const SERP_DEFAULT_MAX_RESULTS_PER_ENGINE = 10

/** Largest fetched document the parsers read, so one oversized page cannot hold unbounded memory. */
export const SERP_DEFAULT_MAX_HTML_CHARS = 2_000_000

/**
 * User agent sent with every engine request. Engines answer a client they do not recognize with a
 * challenge page instead of results, so the provider presents the browser identity they serve.
 */
export const SERP_DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** The provider's time source; the platform clock unless a caller supplies another. */
export interface SerpClock {
  /**
   * Read the current time.
   * @returns milliseconds since the epoch.
   */
  now(): number
  /**
   * Resolve once at least `ms` milliseconds have passed.
   * @param ms - the delay in milliseconds.
   * @returns a promise that resolves after the delay.
   */
  sleep(ms: number): Promise<void>
}

/** The platform clock the request gate uses when no other source is supplied. */
const PLATFORM_CLOCK: SerpClock = {
  now: () => Date.now(),
  sleep: ms => new Promise<void>((resolve) => { setTimeout(resolve, ms) }),
}

/** Resolved provider options (the plugin's `apply` fills every default). */
export interface SerpSearchProviderOptions {
  /** Engines to query, in the order their rows enter the merged result. */
  readonly engines: readonly SerpEngineId[]
  /** Endpoint overrides by engine; an engine absent here uses its default endpoint. */
  readonly endpoints: Partial<Record<SerpEngineId, string>>
  /** Per-search budget in milliseconds. */
  readonly timeoutMs: number
  /** Minimum gap in milliseconds between two requests to one engine host. */
  readonly minIntervalMs: number
  /** Largest number of rows read from one engine. */
  readonly maxResultsPerEngine: number
  /** Largest fetched document the parsers read. */
  readonly maxHtmlChars: number
  /** User agent sent with every engine request. */
  readonly userAgent: string
  /** Time source for the request gate; the platform clock when absent. */
  readonly clock?: SerpClock
}

/**
 * Serializes requests per engine host with a minimum gap, so one tool call that fans several
 * queries over the same engine does not burst it. One gate belongs to one provider instance and
 * keeps one last-start time per key; concurrent callers on an idle key pass through in call order.
 */
export class RequestGate {
  private readonly lastStart = new Map<string, number>()

  /**
   * @param minIntervalMs - the minimum gap; zero or less lets every request pass immediately.
   * @param clock - the time source for both the wait computation and the recorded start.
   */
  constructor(private readonly minIntervalMs: number, private readonly clock: SerpClock) {}

  /**
   * Wait until this key's next allowed start, then record it.
   * @param key - the request key, which is the engine host.
   */
  async acquire(key: string): Promise<void> {
    if (this.minIntervalMs <= 0) return
    const previous = this.lastStart.get(key)
    if (previous !== undefined) {
      const waitMs = previous + this.minIntervalMs - this.clock.now()
      if (waitMs > 0) await this.clock.sleep(waitMs)
    }
    this.lastStart.set(key, this.clock.now())
  }
}

/**
 * The engine-scraping search provider.
 *
 * An engine answers a request only while that engine serves its result markup to this client; a
 * challenge page parses to no rows and is reported as that engine's failure, which leaves the other
 * engines' results in place.
 */
export class SerpSearchProvider implements WebSearchProvider {
  readonly id = SERP_PROVIDER_ID

  private readonly options: SerpSearchProviderOptions
  private readonly gate: RequestGate

  /**
   * @param options - the resolved options every search this instance serves uses.
   */
  constructor(options: SerpSearchProviderOptions) {
    this.options = options
    this.gate = new RequestGate(options.minIntervalMs, options.clock ?? PLATFORM_CLOCK)
  }

  /**
   * Whether the configured engines and numeric bounds can serve a search. This is a local check:
   * it parses each endpoint and validates each bound, and makes no network request.
   * @returns true when every configured value is usable.
   */
  available(): boolean {
    return this.options.engines.length > 0
      && this.options.engines.every(id => this.endpointUrl(id) !== undefined)
      && isPositiveInteger(this.options.timeoutMs)
      && isPositiveInteger(this.options.maxResultsPerEngine)
      && isPositiveInteger(this.options.maxHtmlChars)
      && Number.isInteger(this.options.minIntervalMs)
      && this.options.minIntervalMs >= 0
  }

  /**
   * Query every configured engine concurrently and merge the engines that answered.
   *
   * A failed engine — a network error, a non-2xx response, or a page with no parseable rows — is
   * dropped while the remaining engines still answer, so one engine's challenge page cannot fail the
   * whole search. An engine that answers is also what bounds the page read: rows past
   * `maxResultsPerEngine` are discarded, and a query with no results at all is reported as every
   * engine failing. The returned result carries no `content`, because no engine supplies a
   * generated answer.
   *
   * @param request - the query and the optional source bound.
   * @param signal - the caller's cancellation signal, combined with the per-search budget.
   * @returns the merged sources, deduplicated by canonical URL and bounded by the request or the
   *   configured per-engine default.
   * @throws WebError `WEB_ABORTED` when the caller aborted, `WEB_PROVIDER_ERROR` when no engine answered.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const budget = signal === undefined
      ? AbortSignal.timeout(this.options.timeoutMs)
      : AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)])
    const outcomes = await Promise.all(this.options.engines.map(async (id) => {
      try {
        return { answered: true as const, hits: await this.searchEngine(id, request.query, budget) }
      } catch (error: unknown) {
        return { answered: false as const, engine: id, error }
      }
    }))
    const perEngine: SerpHit[][] = []
    const failures: string[] = []
    for (const outcome of outcomes) {
      if (outcome.answered) perEngine.push(outcome.hits)
      else failures.push(`${outcome.engine}: ${describeFailure(outcome.error)}`)
    }
    if (perEngine.length === 0) {
      if (signal?.aborted === true) throw abortedSearch(signal)
      throw new WebError(`every configured search engine failed — ${failures.join('; ')}`, 'WEB_PROVIDER_ERROR')
    }
    return mergeEngineHits(perEngine, request.maxResults ?? this.options.maxResultsPerEngine)
  }

  /**
   * Fetch and parse one engine's result page.
   * @param id - the engine to query.
   * @param query - the search terms.
   * @param signal - the shared per-search budget signal.
   * @returns the parsed rows, in page order, bounded by `maxResultsPerEngine`.
   * @throws WebError when the endpoint is unusable, the request fails, or the page yields no rows.
   */
  private async searchEngine(id: SerpEngineId, query: string, signal: AbortSignal): Promise<SerpHit[]> {
    const spec = ENGINE_SPECS[id]
    const endpoint = this.endpointUrl(id)
    if (endpoint === undefined) {
      throw new WebError('engine endpoint is not a usable HTTP(S) URL', 'WEB_PROVIDER_ERROR')
    }
    endpoint.searchParams.set(spec.queryParam, query)
    await this.gate.acquire(endpoint.host)
    let response: Response
    try {
      response = await fetch(endpoint, {
        // This request carries no credential, so following the engine's own redirect to the host
        // that serves it is safe; the redirect rejection rule covers credential-bearing requests.
        redirect: 'follow',
        headers: {
          'user-agent': this.options.userAgent,
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw abortedSearch(signal)
      throw new WebError(`search request failed: ${describeFailure(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (!response.ok) {
      throw new WebError(`search request failed (HTTP ${String(response.status)})`, 'WEB_PROVIDER_ERROR')
    }
    const body = boundHtml(await response.text(), this.options.maxHtmlChars)
    const hits = spec.parse(body)
    if (hits.length === 0) {
      throw new WebError(
        looksChallenged(body)
          ? 'anti-automation challenge page returned instead of results'
          : 'returned no parseable results; the page layout may have changed',
        'WEB_PROVIDER_ERROR',
      )
    }
    return hits.slice(0, this.options.maxResultsPerEngine)
  }

  /**
   * Resolve one engine's endpoint into a request URL the caller may modify.
   * @param id - the engine.
   * @returns a fresh URL per call, or `undefined` when neither the override nor the default parses.
   */
  private endpointUrl(id: SerpEngineId): URL | undefined {
    const endpoint = this.options.endpoints[id] ?? ENGINE_SPECS[id].endpoint
    try {
      return new URL(endpoint)
    } catch {
      // `new URL` throws TypeError for a configured value that is not a URL; the provider reports
      // that engine as unusable instead of failing every search with an unrelated error.
      return undefined
    }
  }
}

/**
 * Merge per-engine rows by rank, so every engine that answered is represented near the top before
 * any engine's second row, dropping duplicate targets and honoring the bound.
 * @param perEngine - one row list per engine that answered, in configured order.
 * @param maxResults - the largest number of sources to return.
 * @returns the merged sources and whether the bound dropped a row.
 */
export function mergeEngineHits(perEngine: readonly (readonly SerpHit[])[], maxResults: number): WebSearchResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  let deepest = 0
  for (const rows of perEngine) deepest = Math.max(deepest, rows.length)
  let truncated = false
  merge: for (let rank = 0; rank < deepest; rank++) {
    for (const rows of perEngine) {
      const hit = rows[rank]
      if (hit === undefined) continue
      const key = urlKey(hit.url)
      if (seen.has(key)) continue
      if (sources.length === maxResults) {
        truncated = true
        break merge
      }
      seen.add(key)
      sources.push({
        url: hit.url,
        ...hit.title === undefined ? {} : { title: hit.title },
        ...hit.snippet === undefined ? {} : { snippet: hit.snippet },
      })
    }
  }
  return { sources, truncated }
}

/**
 * Describe one engine's failure for the all-engines-failed message.
 * @param error - the caught value.
 * @returns the error's message, the thrown string, or a placeholder for any other value.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown engine failure'
}

/**
 * Build the provider's cancellation error while retaining the caller's abort reason.
 * @param signal - the aborted signal.
 * @returns the error the caller sees.
 */
function abortedSearch(signal: AbortSignal): WebError {
  return new WebError('search engine request aborted', 'WEB_ABORTED', { cause: signal.reason })
}
/**
 * Whether a value is a positive integer.
 * @param value - the value to test.
 * @returns true for a whole number greater than zero.
 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
