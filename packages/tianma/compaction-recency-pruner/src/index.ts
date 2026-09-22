/**
 * Replay-safe, model-free recency-preserving tool-result clearing.
 *
 * The upstream `dsh-compaction-tool-result-pruner` prunes EVERY over-budget
 * result to head+marker+tail — including the result the model is actively
 * working from, whose load-bearing span for code tasks is usually the middle.
 * This plugin registers the same `ctx.toolResultPruner` seam with ZCode
 * microcompact semantics instead: the most recent results stay byte-identical,
 * and older oversized results from volume-heavy tools are cleared wholesale to
 * one marker line. Degradation is shaped "new context intact, old context
 * zeroed", never "everything partially truncated".
 *
 * @module @tianma/dsh-compaction-recency-pruner
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/*` SessionEventMap merges (the shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import { CLEARED_MARKER, codePointLength, DEFAULTS, resolveConfig } from './config.ts'
import type {
  ClearResult,
  ClearedEntry,
  RecencyPruneConfig,
  ResolvedConfig,
} from './types.ts'

export { CLEARED_MARKER, codePointLength, DEFAULTS, resolveConfig } from './config.ts'
export type {
  ClearResult,
  ClearedEntry,
  RecencyPruneConfig,
  ResolvedConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: RecencyToolResultPruner
  }
}

interface Candidate {
  readonly seq: SessionSeq
  readonly event: SessionEvent<'tool/result'>
  readonly toolName: string | undefined
}

/** Deterministic recency-preserving clearing for current tool-result surface nodes. */
export class RecencyToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so clearing genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<RecencyPruneConfig> = z.object({
    keepRecentResults: z.number().step(1).min(0).default(DEFAULTS.keepRecentResults),
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    minCharsSaved: z.number().step(1).min(0).default(DEFAULTS.minCharsSaved),
    compactableTools: z.array(z.string()).default([...DEFAULTS.compactableTools]),
  })

  /** Resolved and immutable clearing policy. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: RecencyPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace every text block of an old result with one marker line while
   * preserving rich-block order and logged image-offload selections; the
   * whole-result degradation shape is the point (never a partial middle cut).
   * @param blocks - original tool-result content.
   * @returns cleared content, or `null` when there is no text to clear.
   */
  clearContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const hasText = blocks.some(block => block.type === 'text')
    if (!hasText) return null
    const cleared: ContentBlock[] = []
    let markerEmitted = false
    for (const block of blocks) {
      if (block.type !== 'text') {
        cleared.push(block)
        continue
      }
      if (markerEmitted) continue
      cleared.push({ ...block, text: CLEARED_MARKER })
      markerEmitted = true
    }
    return cleared
  }

  /**
   * Clear older oversized tool results from one stable current-surface
   * snapshot, keeping the most recent `keepRecentResults` results untouched.
   * Each replacement preserves the complete event data except `content`,
   * cites the shadowed node so replay can recover the replacement input, and
   * is immediately preceded by a `compaction/prune` shadow-price event pricing
   * the shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session): ClearResult {
    const candidates: Candidate[] = []
    // Tool names live in `tool/call` log events, which are not surface nodes;
    // resolve them from the full event log so whitelist checks see real names.
    const toolNames = new Map<string, string>()
    for (const event of session.snapshotEvents()) {
      if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
    }
    for (const seq of [...session.surface.nodes]) {
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const event = session.eventAt(seq)
      if (event?.type === 'tool/result') {
        const callId = event.data.message.source.callId
        candidates.push({ seq, event, toolName: toolNames.get(callId) })
      }
    }

    // The active window is the tail of the surface's tool results: whatever
    // the model is working from stays byte-identical.
    const activeWindowStart = Math.max(0, candidates.length - this.config.keepRecentResults)
    const eligible = candidates
      .slice(0, activeWindowStart)
      .filter(candidate => this.isCompactable(candidate))

    const cleared: ClearedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of eligible) {
      const original = session.deriveEventMessage(event) as ToolResultMessage
      const content = this.clearContent(original.content)
      if (content === null) continue
      const charsBefore = this.measureContent(original.content)
      const charsAfter = this.measureContent(content)
      if (charsBefore - charsAfter < this.config.minCharsSaved) continue
      const message = freezeMessage<ToolResultMessage>({
        ...original,
        content,
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(original),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      cleared.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { cleared, charsRemoved }
  }

  /** Whether one candidate is old, whitelisted, and over the text threshold. */
  private isCompactable(candidate: Candidate): boolean {
    if (candidate.toolName === undefined) return false
    if (this.config.compactableTools.length > 0
      && !this.config.compactableTools.includes(candidate.toolName)) return false
    const event = candidate.event
    const original = event.data.message
    return this.measureContent(original.content) > this.config.thresholdChars
  }
}

export default RecencyToolResultPruner
