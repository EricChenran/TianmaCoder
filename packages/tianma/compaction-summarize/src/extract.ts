/**
 * Extract the checkpoint text from a fidelity summarizer response.
 *
 * @module @tianma/dsh-compaction-summarize/extract
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const SUMMARY_OPEN = '<summary>'
const SUMMARY_CLOSE = '</summary>'

/**
 * Pull the `<summary>` span out of the model's text output, discarding the
 * `<analysis>` scratchpad; tolerate untagged output by passing the text
 * through unchanged so a provider that ignores the shape still lands a
 * usable checkpoint.
 * @param blocks - complete text-only model output.
 * @returns the extracted summary as one text block per contributing block.
 * @throws when the output contains images or the extracted span is empty.
 */
export function extractSummaryBlocks(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  const texts = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  const joined = texts.map(block => block.text).join('\n')
  const open = joined.lastIndexOf(SUMMARY_OPEN)
  const close = joined.lastIndexOf(SUMMARY_CLOSE)
  if (open !== -1 && close !== -1 && close > open) {
    const extracted = joined.slice(open + SUMMARY_OPEN.length, close).trim()
    if (extracted.length === 0) {
      throw new Error('summarization produced an empty <summary> block')
    }
    return [{ type: 'text', text: extracted }]
  }
  const fallback = texts.filter(block => block.text.trim().length > 0)
  if (fallback.length === 0) {
    throw new Error('summarization produced no text summary content')
  }
  return fallback
}
