/**
 * Resilience helpers for the fidelity summarizer: prompt-too-long truncation
 * retries, a consecutive-failure circuit breaker, and a deterministic
 * fallback checkpoint that keeps a useful summary landing even when the
 * summarization model cannot fit the replayed prefix.
 *
 * @module @tianma/dsh-compaction-summarize/resilience
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

/** Truncation retries before the deterministic fallback checkpoint. */
export const FIDELITY_RETRY_LIMIT = 3

/** Consecutive failures before the breaker falls back to upstream behavior. */
export const FIDELITY_BREAKER_LIMIT = 3

/** Marker injected at each truncation cut point. */
export const TRUNCATION_MARKER = '[earlier conversation truncated for compaction retry]'

/** Rough char budget the replayed prefix must fit after each retry round. */
const CHARS_PER_TOKEN = 4

/**
 * Whether one failure is a prompt-too-long rejection worth retrying with a
 * truncated prefix.
 * @param error - the thrown failure.
 * @returns whether the error code marks an over-window request.
 */
export function isPromptTooLong(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'CONTEXT_WINDOW_EXCEEDED'
}

/**
 * Truncate the replayed prefix for one retry round: keep the system head and
 * roughly half of the remaining tail each round, inserting a marker user
 * message at the cut so the model knows earlier context was dropped.
 * @param messages - the replayed prefix.
 * @returns a strictly shorter prefix carrying the truncation marker.
 */
export function truncatePrefix(messages: readonly Message[]): Message[] {
  if (messages.length <= 1) return [...messages]
  const head = messages[0]!.role === 'system' ? [messages[0]!] : []
  const rest = messages.slice(head.length)
  const keep = Math.max(1, Math.floor(rest.length / 2))
  const tail = rest.slice(rest.length - keep)
  const marker = createUserMessage({
    content: [{ type: 'text', text: TRUNCATION_MARKER }],
    source: { kind: 'user' },
  })
  return [...head, marker, ...tail]
}

/**
 * Deterministic last-resort checkpoint: the recent user messages verbatim
 * plus the tail of the conversation, so the next window still carries the
 * user's intent even when the summarizer cannot run. Directly implements the
 * roadmap's "one squeeze short must not roll back with an error" clause.
 * @param messages - the replayed prefix.
 * @param maxChars - upper bound for the fallback text.
 * @returns checkpoint text for the synthesized replacement user message.
 */
export function fallbackCheckpoint(messages: readonly Message[], maxChars = 12_000): string {
  const userLines: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(' ')
      .trim()
    if (text.length > 0) userLines.push(`- ${text}`)
  }
  const users = userLines.length > 0
    ? ['1. Primary Request and Intent (verbatim recent user messages):', ...userLines.map(line => `  ${line}`), '']
    : []
  const tailText: string[] = []
  let budget = maxChars - userLines.join('\n').length
  for (let i = messages.length - 1; i >= 0 && budget > 0; i -= 1) {
    const message = messages[i]!
    const text = message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(' ')
      .trim()
    if (text.length === 0) continue
    const clipped = text.length > budget ? text.slice(0, budget) : text
    tailText.unshift(`${message.role}: ${clipped}`)
    budget -= clipped.length + message.role.length + 2
  }
  return [
    ...users,
    '2. Recent Conversation Tail (mechanical fallback — the summarizer could not fit the replayed prefix; re-read files before relying on this):',
    ...tailText.map(line => `  ${line}`),
  ].join('\n')
}

/**
 * Consecutive-failure circuit breaker state. Opens after
 * {@link FIDELITY_BREAKER_LIMIT} consecutive failures; a success resets it.
 */
export class SummarizeBreaker {
  private consecutive = 0

  /**
   * Record one failure.
   * @returns whether the breaker is now open.
   */
  recordFailure(): boolean {
    this.consecutive += 1
    return this.consecutive >= FIDELITY_BREAKER_LIMIT
  }

  /** Record one success, resetting the breaker. */
  recordSuccess(): void {
    this.consecutive = 0
  }

  /** Whether the breaker is open (fall back to upstream behavior). */
  get open(): boolean {
    return this.consecutive >= FIDELITY_BREAKER_LIMIT
  }
}

/** Estimated token size of a replayed prefix, for retry-budget assertions.
 * @param messages - the replayed prefix to measure.
 * @returns the estimated token size under the shared char divisor.
 */
export function estimatePrefixTokens(messages: readonly Message[]): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) {
      chars += block.type === 'text' ? block.text.length : JSON.stringify(block).length
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
