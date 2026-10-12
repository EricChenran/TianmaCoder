/**
 * Vocabulary for the search-engine-result-page provider: the engine ids it scrapes and one
 * engine's parsed row.
 * @module @deepseek-ai/dsh-web-search-serp/types
 */

/** Stable ids of the engines this provider scrapes. */
export type SerpEngineId = 'baidu' | 'bing' | 'so360'

/**
 * One parsed result row, before the provider normalizes it into a `WebSearchSource`.
 * `url` is absolute and entity-decoded. `title` and `snippet` are omitted when the row carried
 * no usable text, because inventing either would make the seam lie.
 */
export interface SerpHit {
  /** Absolute target URL. */
  readonly url: string
  /** Result title text. */
  readonly title?: string
  /** Result summary text. */
  readonly snippet?: string
}
