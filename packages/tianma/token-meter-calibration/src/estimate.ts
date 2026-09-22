/**
 * Density-parameterized message pricing.
 *
 * The token meter prices every text span at a fixed 4 chars/token. This module
 * reproduces that arithmetic exactly under the `flat` density and prices the
 * same spans under the `calibrated` CJK split, so pricing one message set both
 * ways yields the density correction as a ratio: structural framing and role
 * overhead appear in both terms and cancel, and pure-ASCII text yields exactly
 * 1.
 *
 * @module @tianma/dsh-token-meter-calibration/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import { estimateTextTokensCalibrated, NON_CJK_CHARS_PER_TOKEN } from './density.ts'

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
const ROLE_OVERHEAD = 4

/** Text density applied to every priced span. */
export type TextPricing = 'flat' | 'calibrated'

/**
 * Price one text span under the selected density.
 * @param text - text to price.
 * @param pricing - `flat` for the meter's 4 chars/token, `calibrated` for the CJK split.
 * @returns estimated tokens for the span.
 */
function priceText(text: string, pricing: TextPricing): number {
  return pricing === 'calibrated'
    ? estimateTextTokensCalibrated(text)
    : Math.ceil(text.length / NON_CJK_CHARS_PER_TOKEN)
}

/**
 * Price a block outside the typed pricing arms — image references and
 * merge-extended blocks — at its JSON structure.
 * @param block - block to price without mutation.
 * @param pricing - text density applied to the serialized block.
 * @returns heuristic tokens for the block's JSON structure.
 */
function priceStructuralBlock(block: ContentBlock, pricing: TextPricing): number {
  return BLOCK_OVERHEAD + priceText(JSON.stringify(block), pricing)
}

/**
 * Price content blocks recursively.
 * @param blocks - content blocks to price without mutation.
 * @param pricing - text density applied to every priced span.
 * @returns heuristic tokens including per-block structural overhead.
 */
function priceContent(blocks: readonly ContentBlock[], pricing: TextPricing): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += priceText(block.text, pricing) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += priceText(block.name, pricing)
          + priceText(block.arguments, pricing)
          + BLOCK_OVERHEAD
        break
      default:
        tokens += priceStructuralBlock(block, pricing)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: its text density plus role framing, with no
 * per-block overhead. The meter aggregates the prompt's characters and divides
 * once, so the `flat` arm reproduces that single division rather than dividing
 * per block.
 * @param content - system message content blocks.
 * @param pricing - text density applied to the prompt text.
 * @returns heuristic system-prompt tokens; 0 for empty content.
 */
function priceSystemMessage(content: readonly ContentBlock[], pricing: TextPricing): number {
  if (content.length === 0) return 0
  if (pricing === 'flat') {
    let characters = 0
    for (const block of content) {
      characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length
    }
    return Math.ceil(characters / NON_CJK_CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  let tokens = 0
  for (const block of content) {
    tokens += estimateTextTokensCalibrated(block.type === 'text' ? block.text : JSON.stringify(block))
  }
  return tokens + ROLE_OVERHEAD
}

/**
 * Price one model-visible message under the selected text density.
 * @param message - message to price without mutation.
 * @param pricing - `flat` reproduces the token meter's heuristic bit for bit;
 *   `calibrated` prices CJK spans at their own density.
 * @returns heuristic tokens including role framing and per-block overhead.
 */
export function estimateMessageTokens(message: Message, pricing: TextPricing): number {
  if (message.role === 'system') return priceSystemMessage(message.content, pricing)
  return priceContent(message.content, pricing) + ROLE_OVERHEAD
}
