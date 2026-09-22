import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Recency policy for tool-result clearing. */
export interface RecencyPruneConfig {
  /**
   * Tool results this recent (in surface order) are never cleared, regardless
   * of size. ZCode's microcompact keeps five groups; here the unit is the
   * tool-result event. Defaults to `5`.
   */
  keepRecentResults?: number
  /**
   * Clear an older tool result only when its text exceeds this many Unicode
   * code points; smaller results are not worth the context dance. Defaults
   * to `8192` (mirrors the upstream pruner's threshold).
   */
  thresholdChars?: number
  /**
   * Skip a candidate whose replacement would save fewer Unicode code points.
   * ZCode gates at 256 tokens; at the harness's 4-chars-per-token heuristic
   * that is 1024 code points, which is the default here.
   */
  minCharsSaved?: number
  /**
   * Tool names eligible for clearing; an empty list means every tool. The
   * default lists the volume-heavy read/search/shell tools and leaves
   * everything else untouched.
   */
  compactableTools?: string[]
}

/** Validated, detached, deeply immutable clearing configuration. */
export interface ResolvedConfig {
  readonly keepRecentResults: number
  readonly thresholdChars: number
  readonly minCharsSaved: number
  readonly compactableTools: readonly string[]
}

/** Cited source event and size accounting for one landed clearing. */
export interface ClearedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended cleared tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}

/** Aggregate outcome of one stable-surface clearing pass. */
export interface ClearResult {
  /** Replacements in the snapshotted surface order. */
  readonly cleared: readonly ClearedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
