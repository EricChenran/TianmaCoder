import { describe, expect, it } from 'vitest'
import { SerpSearchProvider, SERP_DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-search-serp'

/**
 * Live smoke for the engine-scraping provider. It reaches the engines' own sites, so it runs only
 * when `$DSH_WEB_SEARCH_SERP_E2E=1`; CI has neither that opt-in nor a guarantee that an engine
 * answers a datacenter address with results instead of a challenge page.
 */
const enabled = process.env.DSH_WEB_SEARCH_SERP_E2E === '1' ? describe : describe.skip

enabled('SerpSearchProvider live engines', () => {
  it('returns citeable sources for a live query', async () => {
    const provider = new SerpSearchProvider({
      engines: ['baidu', 'bing', 'so360'],
      endpoints: {},
      timeoutMs: 20_000,
      minIntervalMs: 1_000,
      maxResultsPerEngine: 10,
      maxHtmlChars: 2_000_000,
      userAgent: SERP_DEFAULT_USER_AGENT,
    })
    const result = await provider.search({ query: 'DeepSeek 深度求索', maxResults: 8 })
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) {
      expect(source.url).toMatch(/^https?:\/\//)
      expect(source.title ?? '').not.toBe('')
    }
  }, 60_000)
})
