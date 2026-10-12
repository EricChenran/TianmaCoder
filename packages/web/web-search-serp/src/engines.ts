/**
 * One adapter per supported engine: where to send the query and how to read that engine's result
 * rows out of its HTML. An adapter returns raw rows; the provider owns normalization, dedupe, the
 * request budget, and the result bound. An engine's markup is this package's regression surface,
 * so each parser is covered by a captured-structure fixture.
 * @module @deepseek-ai/dsh-web-search-serp/engines
 */

import type { SerpEngineId, SerpHit } from './types.ts'
import { absoluteHttpUrl, captureGroups, firstText, textOf } from './html.ts'

/** How to reach one engine and read its result page. */
export interface EngineSpec {
  /** The engine this spec describes. */
  readonly id: SerpEngineId
  /** Default endpoint that receives the query. */
  readonly endpoint: string
  /** Query-string parameter carrying the search terms. */
  readonly queryParam: string
  /**
   * Read the result rows out of one fetched result page.
   * @param html - the fetched document.
   * @returns the rows in page order; empty when the page carries none.
   */
  readonly parse: (html: string) => SerpHit[]
}

/** Baidu origin, used to resolve the relative references its result rows carry. */
const BAIDU_ORIGIN = 'https://www.baidu.com'

/** Result containers, including Baidu's rich `result-op` form. */
const BAIDU_BLOCK = new RegExp(
  '<div[^>]+class="[^"]*\\bc-container\\b[^"]*"[\\s\\S]*?'
  + '(?=<div[^>]+class="[^"]*\\bc-container\\b|<div[^>]+id="page"|</body>)',
  'g',
)

/** The real target, which Baidu exposes on the container rather than on the anchor. */
const BAIDU_TARGET = /mu="([^"]*)"/

/** The anchor used as the target fallback for rows that omit `mu`. */
const BAIDU_ANCHOR = /href="([^"]*)"/

/** The result's title. */
const BAIDU_TITLE = /<h3[^>]*>([\s\S]*?)<\/h3>/

/** The result's summary, in the container class Baidu renders it with. */
const BAIDU_SNIPPET = /class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div|p)>/

/** Baidu hosts whose rows are the engine's own chrome rather than a search result. */
const BAIDU_WIDGET_HOSTS = ['www.baidu.com']

/** Baidu widget host suffixes, for the widget farms that live on numbered subdomains. */
const BAIDU_WIDGET_SUFFIXES = ['.ubs.baidu.com', '.recommend_list.baidu.com']

/** Baidu's click wrapper; rows under any other path on those hosts are self pages. */
const BAIDU_WRAPPER_PATH = '/link'

/**
 * Whether a Baidu row belongs to the engine's own chrome.
 * @param host - the row's host.
 * @returns true for a widget farm or the search host itself.
 */
function isBaiduWidget(host: string): boolean {
  return BAIDU_WIDGET_HOSTS.includes(host)
    || BAIDU_WIDGET_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/**
 * Read Baidu's result rows. Baidu exposes the real target in the container's `mu` attribute and
 * falls back to the anchor for rows that omit it, such as encyclopedia summaries.
 * @param html - the fetched result page.
 * @returns the parsed rows.
 */
export function parseBaidu(html: string): SerpHit[] {
  const hits: SerpHit[] = []
  for (const block of html.match(BAIDU_BLOCK) ?? []) {
    const [target = ''] = captureGroups(BAIDU_TARGET, block)
    const [anchor = ''] = captureGroups(BAIDU_ANCHOR, block)
    const reference = target === '' ? anchor : target
    if (reference === '') continue
    const url = absoluteHttpUrl(reference, BAIDU_ORIGIN)
    if (url === undefined) continue
    const parsed = new URL(url)
    if (isBaiduWidget(parsed.host) && !parsed.pathname.startsWith(BAIDU_WRAPPER_PATH)) continue
    const title = firstText(block, BAIDU_TITLE)
    const snippet = firstText(block, BAIDU_SNIPPET)
    hits.push({
      url,
      ...title === undefined ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return hits
}

/** Bing's result list items. */
const BING_BLOCK = /<li class="b_algo"[\s\S]*?<\/li>/g

/** The result's link and title inside its heading. */
const BING_LINK = /<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/

/** The result's summary paragraph. */
const BING_SNIPPET = /<p[^>]*>([\s\S]*?)<\/p>/

/** Bing origin, used to resolve the relative references its rows carry. */
const BING_ORIGIN = 'https://cn.bing.com'

/** Bing hosts that serve rows from the engine itself. */
const BING_SELF_HOSTS = ['cn.bing.com', 'www.bing.com']

/** Bing's click wrapper path. */
const BING_WRAPPER_PATH = '/ck/a'

/**
 * Decode the target a Bing click wrapper carries, so a citation points at the result rather than
 * at the engine's redirector.
 * @param url - one parsed result URL.
 * @returns the decoded target, or `undefined` when the URL is not a decodable wrapper.
 */
export function bingWrapperTarget(url: URL): string | undefined {
  if (!BING_SELF_HOSTS.includes(url.host) || !url.pathname.startsWith(BING_WRAPPER_PATH)) return undefined
  const encoded = url.searchParams.get('u')
  if (encoded === null || !encoded.startsWith('a1')) return undefined
  const target = Buffer.from(encoded.slice(2), 'base64url').toString('utf8')
  // A wrapper whose parameter does not decode to an absolute reference carries no target.
  if (!target.startsWith('http')) return undefined
  return absoluteHttpUrl(target, url.origin)
}

/**
 * Read Bing's result rows.
 * @param html - the fetched result page.
 * @returns the parsed rows.
 */
export function parseBing(html: string): SerpHit[] {
  const hits: SerpHit[] = []
  for (const block of html.match(BING_BLOCK) ?? []) {
    const [href = '', titleMarkup = ''] = captureGroups(BING_LINK, block)
    const resolved = absoluteHttpUrl(href, BING_ORIGIN)
    if (resolved === undefined) continue
    const parsed = new URL(resolved)
    if (BING_SELF_HOSTS.includes(parsed.host) && !parsed.pathname.startsWith(BING_WRAPPER_PATH)) continue
    const url = bingWrapperTarget(parsed) ?? resolved
    const title = textOf(titleMarkup)
    const snippet = firstText(block, BING_SNIPPET)
    hits.push({
      url,
      ...title === '' ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return hits
}

/** 360's result list items. */
const SO360_BLOCK = /<li class="res-list[\s\S]*?<\/li>/g

/** The result's link and title inside its heading. */
const SO360_LINK = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/

/** The result's summary. */
const SO360_SNIPPET = /class="[^"]*(?:res-desc|res-list-summary)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/

/** 360 origin, used to resolve the relative click-wrapper references its rows carry. */
const SO360_ORIGIN = 'https://www.so.com'

/** 360 hosts that serve rows from the engine itself. */
const SO360_SELF_HOSTS = ['www.so.com', 'so.com']

/** 360's click wrapper path. */
const SO360_WRAPPER_PATH = '/link'

/**
 * Read 360's result rows. Its rows link through a click wrapper whose `m` parameter the engine
 * resolves on the way to the target, so the citation carries that wrapper URL unchanged.
 * @param html - the fetched result page.
 * @returns the parsed rows.
 */
export function parseSo360(html: string): SerpHit[] {
  const hits: SerpHit[] = []
  for (const block of html.match(SO360_BLOCK) ?? []) {
    const [href = '', titleMarkup = ''] = captureGroups(SO360_LINK, block)
    const url = absoluteHttpUrl(href, SO360_ORIGIN)
    if (url === undefined) continue
    const parsed = new URL(url)
    if (SO360_SELF_HOSTS.includes(parsed.host) && !parsed.pathname.startsWith(SO360_WRAPPER_PATH)) continue
    const title = textOf(titleMarkup)
    const snippet = firstText(block, SO360_SNIPPET)
    hits.push({
      url,
      ...title === '' ? {} : { title },
      ...snippet === undefined ? {} : { snippet },
    })
  }
  return hits
}

/** Every engine this provider scrapes, in the order their rows enter a merged result. */
export const SERP_ENGINE_IDS = ['baidu', 'bing', 'so360'] as const

/** Every engine spec, keyed by its stable id. */
export const ENGINE_SPECS: Record<SerpEngineId, EngineSpec> = {
  baidu: {
    id: 'baidu',
    endpoint: `${BAIDU_ORIGIN}/s`,
    queryParam: 'wd',
    parse: parseBaidu,
  },
  bing: {
    id: 'bing',
    endpoint: `${BING_ORIGIN}/search`,
    queryParam: 'q',
    parse: parseBing,
  },
  so360: {
    id: 'so360',
    endpoint: `${SO360_ORIGIN}/s`,
    queryParam: 'q',
    parse: parseSo360,
  },
}
