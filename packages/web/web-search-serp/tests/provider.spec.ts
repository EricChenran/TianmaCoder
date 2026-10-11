import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeFailure,
  mergeEngineHits,
  RequestGate,
  SerpSearchProvider,
  SERP_PROVIDER_ID,
} from '../src/provider.ts'
import type { SerpClock, SerpSearchProviderOptions } from '../src/provider.ts'

/** The captured result page each engine host answers with. */
const PAGES: Record<string, string> = {
  'www.baidu.com': page('baidu'),
  'cn.bing.com': page('bing'),
  'www.so.com': page('so360'),
}

function page(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')
}

function options(overrides: Partial<SerpSearchProviderOptions> = {}): SerpSearchProviderOptions {
  return {
    engines: ['baidu', 'bing', 'so360'],
    endpoints: {},
    timeoutMs: 5_000,
    minIntervalMs: 0,
    maxResultsPerEngine: 10,
    maxHtmlChars: 2_000_000,
    userAgent: 'test-agent',
    ...overrides,
  }
}

/** Answer every engine host, with per-host overrides or failures. */
function stubEngines(overrides: Record<string, Response | Error> = {}): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: URL) => {
    const override = overrides[input.host]
    if (override instanceof Error) throw override
    if (override !== undefined) return override
    const html = PAGES[input.host]
    return html === undefined ? new Response('no fixture', { status: 404 }) : new Response(html, { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function stubHtml(html: string): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(html, { status: 200 }))
  vi.stubGlobal('fetch', mock)
  return mock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SerpSearchProvider availability', () => {
  it('is available with the shipped defaults', () => {
    expect(new SerpSearchProvider(options()).available()).toBe(true)
  })

  it('is unusable without an engine, with an unparseable endpoint, or with a bad bound', () => {
    expect(new SerpSearchProvider(options({ engines: [] })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ endpoints: { baidu: 'not a url' } })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ timeoutMs: 0 })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ timeoutMs: 1.5 })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ maxResultsPerEngine: 0 })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ maxHtmlChars: 0 })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ minIntervalMs: -1 })).available()).toBe(false)
    expect(new SerpSearchProvider(options({ minIntervalMs: 1.5 })).available()).toBe(false)
  })
})

describe('SerpSearchProvider search', () => {
  it('merges every engine by rank, keeping each engine\'s rows near the top', async () => {
    stubEngines()
    const result = await new SerpSearchProvider(options()).search({ query: 'deepseek' })
    expect(result.sources.map(source => source.url)).toEqual([
      'https://deepseek.com/',
      'https://www.deepseek.com/',
      result.sources[2]?.url,
      'https://chat.deepseek.com/',
      result.sources[4]?.url,
      result.sources[5]?.url,
      'https://download.deepseek.com/',
    ])
    expect(result.sources).toHaveLength(7)
    expect(result.sources[1]?.snippet).toContain('DeepSeek is an AI research company')
    expect(result.truncated).toBe(false)
    // No engine returns a generated answer, so the seam carries no `content`.
    expect(result.content).toBeUndefined()
  })

  it('sends the query to each engine endpoint and forwards the shared budget', async () => {
    const mock = stubEngines()
    await new SerpSearchProvider(options()).search({ query: 'hello world' })
    const requested = mock.mock.calls.map(call => String(call[0]))
    expect(requested).toEqual([
      'https://www.baidu.com/s?wd=hello+world',
      'https://cn.bing.com/search?q=hello+world',
      'https://www.so.com/s?q=hello+world',
    ])
    const [, init] = mock.mock.calls[0] as [URL, RequestInit]
    expect(init.redirect).toBe('follow')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect((init.headers as Record<string, string>)['user-agent']).toBe('test-agent')
  })

  it('combines the caller signal with the per-search budget', async () => {
    const mock = stubEngines()
    const controller = new AbortController()
    await new SerpSearchProvider(options({ engines: ['bing'] })).search({ query: 'q' }, controller.signal)
    const [, init] = mock.mock.calls[0] as [URL, RequestInit]
    expect(init.signal).not.toBe(controller.signal)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('honors an endpoint override', async () => {
    const mock = stubHtml('<li class="b_algo"><h2><a href="https://c.test/">C</a></h2></li>')
    const provider = new SerpSearchProvider(options({ engines: ['bing'], endpoints: { bing: 'https://mirror.test/find' } }))
    await expect(provider.search({ query: 'q' })).resolves.toMatchObject({ sources: [{ url: 'https://c.test/', title: 'C' }] })
    expect(String(mock.mock.calls[0]?.[0])).toBe('https://mirror.test/find?q=q')
  })

  it('bounds each engine\'s rows and the merged result', async () => {
    const rows = ['1', '2', '3'].map(index => `<li class="b_algo"><h2><a href="https://c.test/${index}">C${index}</a></h2></li>`).join('')
    stubHtml(rows)
    const provider = new SerpSearchProvider(options({ engines: ['bing'], maxResultsPerEngine: 2 }))
    await expect(provider.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://c.test/1' }, { url: 'https://c.test/2' }],
      truncated: false,
    })
    await expect(provider.search({ query: 'q', maxResults: 1 })).resolves.toMatchObject({
      sources: [{ url: 'https://c.test/1' }],
      truncated: true,
    })
  })

  it('drops a duplicate target reported by two engines', async () => {
    stubHtml('<li class="b_algo"><h2><a href="https://dup.test/x">A</a></h2></li><li class="b_algo"><h2><a href="https://dup.test/x#f">B</a></h2></li>')
    await expect(new SerpSearchProvider(options({ engines: ['bing'] })).search({ query: 'q' }))
      .resolves.toMatchObject({ sources: [{ url: 'https://dup.test/x', title: 'A' }] })
  })

  it('keeps the engines that answered when one fails', async () => {
    stubEngines({ 'cn.bing.com': new Response('boom', { status: 500 }) })
    const result = await new SerpSearchProvider(options()).search({ query: 'q' })
    expect(result.sources.map(source => source.url)).toEqual([
      'https://deepseek.com/',
      result.sources[1]?.url,
      'https://chat.deepseek.com/',
      result.sources[3]?.url,
    ])
  })

  it('keeps the engines that answered when one request fails outright', async () => {
    stubEngines({ 'cn.bing.com': new TypeError('connection refused') })
    await expect(new SerpSearchProvider(options()).search({ query: 'q' })).resolves.toMatchObject({ truncated: false })
  })
})

describe('SerpSearchProvider failures', () => {
  it('reports every engine that failed when none answered', async () => {
    stubEngines({
      'www.baidu.com': new Response('no', { status: 500 }),
      'cn.bing.com': new TypeError('connection refused'),
      'www.so.com': new Response('no', { status: 502 }),
    })
    const search = (): Promise<unknown> => new SerpSearchProvider(options()).search({ query: 'q' })
    await expect(search()).rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(search()).rejects.toThrow(
      'every configured search engine failed — baidu: search request failed (HTTP 500); '
      + 'bing: search request failed: connection refused; so360: search request failed (HTTP 502)',
    )
  })

  it('names an unusable endpoint instead of failing the search obscurely', async () => {
    await expect(new SerpSearchProvider(options({ engines: ['baidu'], endpoints: { baidu: 'not a url' } })).search({ query: 'q' }))
      .rejects.toThrow('baidu: engine endpoint is not a usable HTTP(S) URL')
  })

  it('names a challenge page and a page that yielded no rows', async () => {
    stubHtml(page('baidu-challenge'))
    await expect(new SerpSearchProvider(options({ engines: ['baidu'] })).search({ query: 'q' }))
      .rejects.toThrow('baidu: anti-automation challenge page returned instead of results')

    stubHtml('<html><body><p>没有找到该URL</p></body></html>')
    await expect(new SerpSearchProvider(options({ engines: ['baidu'] })).search({ query: 'q' }))
      .rejects.toThrow('baidu: returned no parseable results; the page layout may have changed')
  })

  it('bounds the page it parses', async () => {
    stubHtml(PAGES['cn.bing.com'] ?? '')
    await expect(new SerpSearchProvider(options({ engines: ['bing'], maxHtmlChars: 50 })).search({ query: 'q' }))
      .rejects.toThrow('returned no parseable results')
  })

  it('reports caller cancellation as WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    const controller = new AbortController()
    controller.abort('user cancelled')
    await expect(new SerpSearchProvider(options()).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

})

describe('request throttling', () => {
  it('waits the remaining interval for a hot host and passes when it elapsed', async () => {
    let time = 0
    const sleeps: number[] = []
    const clock: SerpClock = {
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms)
        time += ms
        return Promise.resolve()
      },
    }
    stubHtml('<li class="b_algo"><h2><a href="https://c.test/">C</a></h2></li>')
    const provider = new SerpSearchProvider(options({ engines: ['bing'], minIntervalMs: 1_000, clock }))
    await provider.search({ query: 'a' })
    time += 200
    await provider.search({ query: 'b' })
    time += 2_000
    await provider.search({ query: 'c' })
    expect(sleeps).toEqual([800])
  })

  it('does not wait when throttling is disabled', async () => {
    let time = 0
    const sleeps: number[] = []
    const clock: SerpClock = {
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms)
        time += ms
        return Promise.resolve()
      },
    }
    stubHtml('<li class="b_algo"><h2><a href="https://c.test/">C</a></h2></li>')
    const provider = new SerpSearchProvider(options({ engines: ['bing'], minIntervalMs: 0, clock }))
    await provider.search({ query: 'a' })
    await provider.search({ query: 'b' })
    expect(sleeps).toEqual([])
  })

  it('waits on the platform clock by default', async () => {
    stubHtml('<li class="b_algo"><h2><a href="https://c.test/">C</a></h2></li>')
    const provider = new SerpSearchProvider(options({ engines: ['bing'], minIntervalMs: 5 }))
    await provider.search({ query: 'a' })
    await expect(provider.search({ query: 'b' })).resolves.toMatchObject({ sources: [{ url: 'https://c.test/', title: 'C' }] })
  })

  it('keeps one last-start time per key', async () => {
    let time = 0
    const sleeps: number[] = []
    const gate = new RequestGate(1_000, {
      now: () => time,
      sleep: (ms) => {
        sleeps.push(ms)
        time += ms
        return Promise.resolve()
      },
    })
    await gate.acquire('a.test')
    await gate.acquire('b.test')
    expect(sleeps).toEqual([])
    await gate.acquire('a.test')
    expect(sleeps).toEqual([1_000])
  })
})

describe('mergeEngineHits', () => {
  it('interleaves by rank, omits absent fields, and keeps a duplicate-free list', () => {
    expect(mergeEngineHits([
      [{ url: 'https://a.test/1', title: 'A1' }, { url: 'https://a.test/2' }],
      [{ url: 'https://b.test/1', snippet: 'B1' }],
    ], 10)).toEqual({
      sources: [
        { url: 'https://a.test/1', title: 'A1' },
        { url: 'https://b.test/1', snippet: 'B1' },
        { url: 'https://a.test/2' },
      ],
      truncated: false,
    })
  })

  it('drops a duplicate target and flags the row the bound cut', () => {
    expect(mergeEngineHits([
      [{ url: 'https://a.test/1' }, { url: 'https://a.test/2' }],
      [{ url: 'https://a.test/1#fragment' }],
    ], 1)).toEqual({ sources: [{ url: 'https://a.test/1' }], truncated: true })
  })
})

describe('describeFailure', () => {
  it('reads an Error message, a thrown string, and any other value', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
    expect(describeFailure('boom')).toBe('boom')
    expect(describeFailure(42)).toBe('unknown engine failure')
  })
})

describe('provider identity', () => {
  it('registers under the stable engine-scraping id', () => {
    expect(new SerpSearchProvider(options()).id).toBe(SERP_PROVIDER_ID)
    expect(SERP_PROVIDER_ID).toBe('serp')
  })
})
