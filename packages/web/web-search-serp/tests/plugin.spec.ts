import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as serpPlugin from '@deepseek-ai/dsh-web-search-serp'
import { apply, SERP_DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-search-serp'

const RESULT_PAGE = '<li class="b_algo"><h2><a href="https://c.test/">C</a></h2></li>'

function stubHtml(html: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(html, { status: 200 }))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web-search-serp plugin registration', () => {
  it('registers the provider into ctx.web and removes it on dispose', async () => {
    stubHtml(RESULT_PAGE)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'serp' })
    const fiber = await ctx.plugin(serpPlugin, { engines: ['bing'], minIntervalMs: 0 })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://c.test/', title: 'C' }],
      truncated: false,
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in serpPlugin).toBe(false)
  })

  it('defaults to every engine, the shipped user agent, and the default endpoints', async () => {
    const mock = stubHtml(RESULT_PAGE)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'serp' })
    const fiber = await ctx.plugin(serpPlugin, { minIntervalMs: 0 })
    await ctx.web.search({ query: 'q' })
    expect(String(mock.mock.calls[0]?.[0])).toBe('https://www.baidu.com/s?wd=q')
    expect(mock.mock.calls).toHaveLength(3)
    const [, init] = mock.mock.calls[0] as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['user-agent']).toBe(SERP_DEFAULT_USER_AGENT)
    await fiber.dispose()
  })

  it('threads the configured engines, endpoint, and user agent into the request', async () => {
    const mock = stubHtml(RESULT_PAGE)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'serp' })
    const fiber = await ctx.plugin(serpPlugin, {
      engines: ['bing'],
      endpoints: { bing: 'https://mirror.test/find' },
      userAgent: 'custom-agent',
      minIntervalMs: 0,
      timeoutMs: 1_000,
      maxResultsPerEngine: 1,
      maxHtmlChars: 4_096,
    })
    await ctx.web.search({ query: 'q' })
    expect(mock.mock.calls).toHaveLength(1)
    expect(String(mock.mock.calls[0]?.[0])).toBe('https://mirror.test/find?q=q')
    const [, init] = mock.mock.calls[0] as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['user-agent']).toBe('custom-agent')
    await fiber.dispose()
  })

  it('registers the shipped defaults when a caller passes an empty section', async () => {
    const mock = stubHtml(RESULT_PAGE)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: 'serp' })
    // A programmatic caller may hand `apply` a partial section; only the loader fills schema defaults.
    apply(ctx, {})
    await ctx.web.search({ query: 'q' })
    expect(mock.mock.calls).toHaveLength(3)
    expect(String(mock.mock.calls[0]?.[0])).toBe('https://www.baidu.com/s?wd=q')
  })

  it('fails at load on a misconfigured engine list or bound', () => {
    const ctx = new Context()
    expect(() => { apply(ctx, { engines: [] }) }).toThrow('web-search-serp: engines must name at least one engine')
    expect(() => { apply(ctx, { timeoutMs: 0 }) }).toThrow('web-search-serp: timeoutMs must be a positive integer')
    expect(() => { apply(ctx, { maxResultsPerEngine: 0 }) }).toThrow('web-search-serp: maxResultsPerEngine must be a positive integer')
    expect(() => { apply(ctx, { maxHtmlChars: 1.5 }) }).toThrow('web-search-serp: maxHtmlChars must be a positive integer')
    expect(() => { apply(ctx, { minIntervalMs: -1 }) }).toThrow('web-search-serp: minIntervalMs must be a non-negative integer')
    expect(() => { apply(ctx, { minIntervalMs: 1.5 }) }).toThrow('web-search-serp: minIntervalMs must be a non-negative integer')
  })
})
