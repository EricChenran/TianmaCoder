/**
 * CJK-aware text density estimation.
 *
 * The upstream token meter prices all text at a fixed 4 chars/token, which
 * under-prices CJK-heavy sessions by 2–3× (CJK text runs ~1.5 chars/token on
 * frontier tokenizers), so pressure reads low and compaction triggers late.
 * This module splits text into CJK and non-CJK spans and prices each at its
 * own density, keeping pure-ASCII pricing bit-identical to upstream.
 *
 * @module @tianma/dsh-token-meter-calibration/density
 */

/**
 * Matches one CJK code point: ideographs (incl. ext A and compat), kana,
 * hangul, fullwidth forms, and CJK punctuation/symbols.
 */
const CJK_PATTERN = new RegExp(
  '[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏'
    + '㐀-䶿一-鿿가-힯'
    + '豈-﫿︰-﹏＀-｠￠-￦]',
  'u',
)

/** Chars per token for CJK spans (frontier tokenizers run ~1.4–1.8). */
export const CJK_CHARS_PER_TOKEN = 1.5

/** Chars per token for everything else — identical to the upstream constant. */
export const NON_CJK_CHARS_PER_TOKEN = 4

/**
 * Count CJK code points in a text.
 * @param text - text to measure.
 * @returns the number of CJK code points.
 */
export function countCjkCodePoints(text: string): number {
  let count = 0
  for (const point of text) {
    if (CJK_PATTERN.test(point)) count += 1
  }
  return count
}

/**
 * Price one text under split densities. Pure non-CJK text prices exactly
 * `Math.ceil(length / 4)`, matching the upstream heuristic bit for bit.
 * @param text - text to price.
 * @returns estimated tokens for the text span.
 */
export function estimateTextTokensCalibrated(text: string): number {
  const total = text.length
  if (total === 0) return 0
  const cjk = countCjkCodePoints(text)
  if (cjk === 0) return Math.ceil(total / NON_CJK_CHARS_PER_TOKEN)
  const nonCjk = total - cjk
  return Math.ceil(cjk / CJK_CHARS_PER_TOKEN) + Math.ceil(nonCjk / NON_CJK_CHARS_PER_TOKEN)
}
