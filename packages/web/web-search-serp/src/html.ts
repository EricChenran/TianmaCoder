/**
 * HTML reading helpers for search-engine result pages. They read attributes, visible text, and
 * whole result rows out of one already-fetched document; they never fetch, and they avoid a DOM
 * dependency so the provider adds no runtime package to the installation.
 * @module @deepseek-ai/dsh-web-search-serp/html
 */

/** Named entities that appear in engine result markup, mapped to the character they decode to. */
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  bull: '•',
  times: '×',
  plusmn: '±',
  deg: '°',
  sect: '§',
  para: '¶',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  yen: '¥',
  euro: '€',
  pound: '£',
}

/**
 * Decode the entities engines emit in titles, snippets, and result URLs. Numeric (`&#38;`,
 * `&#x26;`) and mapped named forms decode; an unknown name, an out-of-range code point, or a bare
 * `&` stays verbatim rather than disappearing from the text.
 * @param text - the encoded text.
 * @returns the decoded text.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match: string, body: string) =>
    body.startsWith('#')
      ? decodeCodePoint(body.slice(1)) ?? match
      : NAMED_ENTITIES[body.toLowerCase()] ?? match)
}

/**
 * Decode one numeric entity body.
 * @param body - the digits, prefixed with `x` or `X` for hexadecimal.
 * @returns the decoded character, or `undefined` when the body is not a Unicode scalar value.
 */
function decodeCodePoint(body: string): string | undefined {
  const hexadecimal = body.startsWith('x') || body.startsWith('X')
  const code = Number.parseInt(hexadecimal ? body.slice(1) : body, hexadecimal ? 16 : 10)
  if (!Number.isInteger(code) || code <= 0 || code > 0x10_ffff) return undefined
  // Surrogates are not scalar values; `String.fromCodePoint` would emit a lone half.
  if (code >= 0xd800 && code <= 0xdfff) return undefined
  return String.fromCodePoint(code)
}

/**
 * Read one double-quoted attribute value.
 * @param markup - the markup to search.
 * @param attributeName - the attribute name, without the `=`.
 * @returns the raw (still entity-encoded) value, or `undefined` when the markup lacks the
 *   attribute or its quote never closes.
 */
export function attributeOf(markup: string, attributeName: string): string | undefined {
  const needle = `${attributeName}="`
  const start = markup.indexOf(needle)
  if (start === -1) return undefined
  const valueStart = start + needle.length
  const end = markup.indexOf('"', valueStart)
  return end === -1 ? undefined : markup.slice(valueStart, end)
}

/**
 * Read the capture groups a pattern contributes to one markup fragment.
 * @param pattern - a non-global pattern whose groups carry the values.
 * @param markup - the fragment to search.
 * @returns one raw (still entity-encoded) string per capture group, empty when the pattern does
 *   not match.
 */
export function captureGroups(pattern: RegExp, markup: string): string[] {
  const matched = pattern.exec(markup)
  return matched === null ? [] : matched.slice(1)
}

/** Tags whose boundaries separate words; every other tag is inline and disappears without a gap. */
const BLOCK_TAGS = new RegExp(
  '</?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form'
  + '|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\\b[^>]*>',
  'gi',
)

/**
 * Visible text of a markup fragment: script and style bodies removed, block tags read as word
 * boundaries, inline tags removed without a gap, entities decoded, whitespace runs collapsed.
 * Inline removal keeps a highlighted term intact, so `www.<b>deepseek</b>.com` reads as one token.
 * @param markup - the fragment.
 * @returns the visible text, trimmed; empty when the fragment carries none.
 */
export function textOf(markup: string): string {
  const withoutCode = markup.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const withBlockGaps = withoutCode.replace(BLOCK_TAGS, ' ')
  const withoutTags = withBlockGaps.replace(/<[^>]*>/g, '')
  return decodeEntities(withoutTags).replace(/\s+/gu, ' ').trim()
}

/**
 * Match one pattern against a fragment and return its first group as visible text.
 * @param markup - the fragment to search.
 * @param pattern - a non-global pattern whose first group wraps the text.
 * @returns the text, or `undefined` when the pattern does not match or the text is blank.
 */
export function firstText(markup: string, pattern: RegExp): string | undefined {
  const [raw = ''] = captureGroups(pattern, markup)
  const text = textOf(raw)
  return text === '' ? undefined : text
}

/**
 * Resolve a possibly-relative, entity-encoded reference against an engine origin and drop its
 * fragment.
 * @param raw - the raw reference.
 * @param base - the engine origin used for a relative reference.
 * @returns the absolute URL, or `undefined` when it does not parse or is not HTTP(S).
 */
export function absoluteHttpUrl(raw: string, base: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(decodeEntities(raw), base)
  } catch {
    // `new URL` throws TypeError for a reference the engine mangled; such a row has no source.
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  parsed.hash = ''
  return parsed.toString()
}

/**
 * Canonical dedupe key for one source: origin, path, and query, with the fragment and a trailing
 * slash removed, so two engines reporting the same page collapse into one source.
 * @param url - an absolute URL.
 * @returns the key; the raw input when it does not parse.
 */
export function urlKey(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // `new URL` throws TypeError for a non-URL key; the raw value still dedupes exactly.
    return url
  }
  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname
  return `${parsed.origin}${path}${parsed.search}`
}

/**
 * Markers that identify an engine's anti-automation challenge page, observed live on 2026-10-11 for
 * Baidu. An engine that changes its challenge page adds its marker here; an engine with no known
 * marker simply reports that it returned no parseable results.
 */
const CHALLENGE_MARKERS = ['wappass.baidu.com', '百度安全验证']

/**
 * Whether a fetched document is an anti-automation challenge rather than a result page.
 * @param html - the fetched document.
 * @returns true when the document carries a known challenge marker.
 */
export function looksChallenged(html: string): boolean {
  return CHALLENGE_MARKERS.some(marker => html.includes(marker))
}

/**
 * Bound a fetched document before parsing it, so one oversized page cannot hold unbounded memory.
 * @param html - the fetched document.
 * @param maxChars - the largest document the parser reads.
 * @returns the document, cut to `maxChars` when it is larger.
 */
export function boundHtml(html: string, maxChars: number): string {
  return html.length <= maxChars ? html : html.slice(0, maxChars)
}
