import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bingWrapperTarget,
  ENGINE_SPECS,
  parseBaidu,
  parseBing,
  parseSo360,
  SERP_ENGINE_IDS,
} from '../src/engines.ts'
import { looksChallenged } from '../src/html.ts'

/**
 * Fixtures are the first result rows of one live result page per engine, captured on 2026-10-11 and
 * reduced to the result markup: page assets and attributes the parsers do not read are removed.
 */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8')
}

function baiduBlock(inner: string, attributes = ''): string {
  return `<div class="result c-container"${attributes}>${inner}</div>`
}

/** Baidu's row pattern ends at the next container or the document end, so constructed markup needs one. */
function baiduPage(...blocks: string[]): string {
  return `<html><body>${blocks.join('')}</body></html>`
}

describe('engine registry', () => {
  it('declares one spec per engine id', () => {
    expect([...SERP_ENGINE_IDS].sort()).toEqual(Object.keys(ENGINE_SPECS).sort())
  })

  it('sends each query to that engine\'s endpoint and parameter', () => {
    expect(ENGINE_SPECS.baidu).toMatchObject({ endpoint: 'https://www.baidu.com/s', queryParam: 'wd' })
    expect(ENGINE_SPECS.bing).toMatchObject({ endpoint: 'https://cn.bing.com/search', queryParam: 'q' })
    expect(ENGINE_SPECS.so360).toMatchObject({ endpoint: 'https://www.so.com/s', queryParam: 'q' })
  })
})

describe('parseBaidu', () => {
  it('reads the organic rows of a captured page and drops the engine\'s widget rows', () => {
    const hits = parseBaidu(fixture('baidu'))
    expect(hits.map(hit => hit.url)).toEqual(['https://deepseek.com/', 'https://chat.deepseek.com/'])
    expect(hits.map(hit => hit.title)).toEqual(['DeepSeek | 深度求索', 'DeepSeek - 探索未至之境'])
    // The captured organic rows are cards without an abstract, so no snippet is invented for them.
    expect(hits.every(hit => hit.snippet === undefined)).toBe(true)
  })

  it('reads a row title and summary from the container the engine renders them in', () => {
    expect(parseBaidu(baiduPage(baiduBlock('<h3>Title</h3><div class="c-abstract">Summary <em>text</em></div>', ' mu="https://a.test/"'))))
      .toEqual([{ url: 'https://a.test/', title: 'Title', snippet: 'Summary text' }])
  })

  it('omits a title the row does not carry', () => {
    expect(parseBaidu(baiduPage(baiduBlock('<div class="c-abstract">Only a summary</div>', ' mu="https://a.test/"'))))
      .toEqual([{ url: 'https://a.test/', snippet: 'Only a summary' }])
  })

  it('falls back to the anchor when the container carries no target', () => {
    expect(parseBaidu(baiduPage(baiduBlock('<a href="https://b.test/page">B</a><h3>Fallback</h3>'))))
      .toEqual([{ url: 'https://b.test/page', title: 'Fallback' }])
  })

  it('skips a row with no reference and a row whose reference is unusable', () => {
    expect(parseBaidu(baiduPage(baiduBlock('<span>no link</span>')))).toEqual([])
    expect(parseBaidu(baiduPage(baiduBlock('<a href="javascript:void(0)">J</a>')))).toEqual([])
  })

  it('drops the engine\'s own pages but keeps its click wrapper', () => {
    expect(parseBaidu(baiduPage(baiduBlock('', ' mu="https://www.baidu.com/baidu.php?url=x"')))).toEqual([])
    expect(parseBaidu(baiduPage(baiduBlock('', ' mu="http://28608.recommend_list.baidu.com"')))).toEqual([])
    expect(parseBaidu(baiduPage(baiduBlock('', ' mu="https://www.baidu.com/link?url=x"'))))
      .toEqual([{ url: 'https://www.baidu.com/link?url=x' }])
  })

  it('separates two rows that follow each other', () => {
    const hits = parseBaidu(baiduPage(
      baiduBlock('<h3>One</h3>', ' mu="https://a.test/1"'),
      baiduBlock('<h3>Two</h3>', ' mu="https://a.test/2"'),
    ))
    expect(hits).toEqual([
      { url: 'https://a.test/1', title: 'One' },
      { url: 'https://a.test/2', title: 'Two' },
    ])
  })

  it('reads no rows from a challenge page', () => {
    expect(parseBaidu(fixture('baidu-challenge'))).toEqual([])
    expect(looksChallenged(fixture('baidu-challenge'))).toBe(true)
  })
})

describe('parseBing', () => {
  it('reads a captured page with titles, targets, and summaries', () => {
    const hits = parseBing(fixture('bing'))
    expect(hits).toHaveLength(3)
    expect(hits[0]).toMatchObject({ url: 'https://www.deepseek.com/', title: 'DeepSeek | Into the Unknown' })
    expect(hits[0]?.snippet).toContain('DeepSeek is an AI research company')
    expect(hits[1]?.url).toContain('baike.baidu.com')
    expect(hits[1]?.snippet).toContain('DeepSeek弹性计算')
    expect(hits[2]).toMatchObject({ url: 'https://download.deepseek.com/', title: 'DeepSeek App' })
  })

  it('reads a row title and summary from the heading and paragraph', () => {
    expect(parseBing('<li class="b_algo"><h2><a href="https://c.test/">C</a></h2><p>Snip</p></li>'))
      .toEqual([{ url: 'https://c.test/', title: 'C', snippet: 'Snip' }])
  })

  it('resolves a relative reference against the engine origin and drops it as an engine page', () => {
    expect(parseBing('<li class="b_algo"><h2><a href="/rel">R</a></h2></li>')).toEqual([])
  })

  it('resolves a relative click wrapper against the engine origin', () => {
    const encoded = Buffer.from('https://example.test/rel', 'utf8').toString('base64url')
    expect(parseBing(`<li class="b_algo"><h2><a href="/ck/a?u=a1${encoded}">W</a></h2></li>`))
      .toEqual([{ url: 'https://example.test/rel', title: 'W' }])
  })

  it('skips a row with no link, an unusable reference, and the engine\'s own page', () => {
    expect(parseBing('<li class="b_algo">plain</li>')).toEqual([])
    expect(parseBing('<li class="b_algo"><h2><a href="javascript:void(0)">J</a></h2></li>')).toEqual([])
    expect(parseBing('<li class="b_algo"><h2><a href="https://www.bing.com/images/x">I</a></h2></li>')).toEqual([])
  })

  it('omits a title the row does not carry', () => {
    expect(parseBing('<li class="b_algo"><h2><a href="https://d.test/"></a></h2></li>')).toEqual([{ url: 'https://d.test/' }])
  })

  it('prefers the target a click wrapper carries', () => {
    const encoded = Buffer.from('https://example.test/path', 'utf8').toString('base64url')
    expect(parseBing(`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${encoded}">W</a></h2></li>`))
      .toEqual([{ url: 'https://example.test/path', title: 'W' }])
  })
})

describe('bingWrapperTarget', () => {
  const encoded = Buffer.from('https://example.test/path', 'utf8').toString('base64url')

  it('decodes a wrapper target', () => {
    expect(bingWrapperTarget(new URL(`https://www.bing.com/ck/a?u=a1${encoded}`))).toBe('https://example.test/path')
  })

  it('returns undefined for anything that is not a decodable wrapper', () => {
    expect(bingWrapperTarget(new URL(`https://example.test/ck/a?u=a1${encoded}`))).toBeUndefined()
    expect(bingWrapperTarget(new URL(`https://www.bing.com/other?u=a1${encoded}`))).toBeUndefined()
    expect(bingWrapperTarget(new URL('https://www.bing.com/ck/a'))).toBeUndefined()
    expect(bingWrapperTarget(new URL('https://www.bing.com/ck/a?u=zzz'))).toBeUndefined()
    expect(bingWrapperTarget(new URL('https://www.bing.com/ck/a?u=a1'))).toBeUndefined()
    expect(bingWrapperTarget(new URL(`https://www.bing.com/ck/a?u=a1${Buffer.from('not-url', 'utf8').toString('base64url')}`))).toBeUndefined()
  })
})

describe('parseSo360', () => {
  it('reads a captured page through the engine\'s click wrapper', () => {
    const hits = parseSo360(fixture('so360'))
    expect(hits).toHaveLength(2)
    expect(hits[0]?.url.startsWith('https://www.so.com/link?m=')).toBe(true)
    expect(hits[0]?.title).toBe('DeepSeek | 深度求索')
    expect(hits[0]?.snippet).toContain('DeepSeek-V4')
    expect(hits[1]?.snippet).toContain('Chat with DeepSeek AI')
  })

  it('resolves the relative wrapper reference and reads the summary container', () => {
    expect(parseSo360('<li class="res-list"><h3><a href="/link?m=abc">T</a></h3><div class="res-desc">S</div></li>'))
      .toEqual([{ url: 'https://www.so.com/link?m=abc', title: 'T', snippet: 'S' }])
    expect(parseSo360('<li class="res-list"><h3><a href="/link?m=abc">T</a></h3><span class="res-list-summary">S2</span></li>'))
      .toEqual([{ url: 'https://www.so.com/link?m=abc', title: 'T', snippet: 'S2' }])
  })

  it('skips a row with no link, an unusable reference, and the engine\'s own page', () => {
    expect(parseSo360('<li class="res-list">plain</li>')).toEqual([])
    expect(parseSo360('<li class="res-list"><h3><a href="javascript:;">J</a></h3></li>')).toEqual([])
    expect(parseSo360('<li class="res-list"><h3><a href="https://www.so.com/s?q=x">X</a></h3></li>')).toEqual([])
  })

  it('omits a title the row does not carry', () => {
    expect(parseSo360('<li class="res-list"><h3><a href="/link?m=abc"></a></h3></li>'))
      .toEqual([{ url: 'https://www.so.com/link?m=abc' }])
  })
})
