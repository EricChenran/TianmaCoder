/** Configuration resolution for recency-preserving tool-result clearing. */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { RecencyPruneConfig, ResolvedConfig } from './types.ts'

/** Whole-result replacement substituted for cleared text spans. */
export const CLEARED_MARKER = '[Old tool result content cleared]'

/**
 * Volume-heavy tools whose old results are worth clearing. Mirrors ZCode's
 * microcompact whitelist translated to dsh tool names; `pwsh` rides along on
 * win32 where `bash` never mounts.
 */
export const DEFAULT_COMPACTABLE_TOOLS: readonly string[] = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'web_search',
  'web_fetch',
])

/** Defaults aligned with ZCode microcompact policy. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  keepRecentResults: 5,
  thresholdChars: 8192,
  minCharsSaved: 1024,
  compactableTools: DEFAULT_COMPACTABLE_TOOLS,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'keepRecentResults',
  'thresholdChars',
  'minCharsSaved',
  'compactableTools',
])

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text to measure.
 * @returns the Unicode code-point count.
 */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/**
 * Resolve and validate clearing policy.
 * @param config - raw plugin configuration.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: RecencyPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `RecencyPruneConfig: unknown key "${key}" `
        + '(allowed: keepRecentResults, thresholdChars, minCharsSaved, compactableTools)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    keepRecentResults: config.keepRecentResults ?? DEFAULTS.keepRecentResults,
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    minCharsSaved: config.minCharsSaved ?? DEFAULTS.minCharsSaved,
    compactableTools: Object.freeze([...(config.compactableTools ?? DEFAULTS.compactableTools)]),
  }
  assertPositiveInteger('keepRecentResults', resolved.keepRecentResults)
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('minCharsSaved', resolved.minCharsSaved)
  for (const tool of resolved.compactableTools) {
    if (typeof tool !== 'string' || tool.length === 0) {
      throw new Error('RecencyPruneConfig: compactableTools entries must be non-empty strings')
    }
  }
  return deepFreeze(structuredClone({ ...resolved, compactableTools: [...resolved.compactableTools] }))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`RecencyPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`RecencyPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}
