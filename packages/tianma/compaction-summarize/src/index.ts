/**
 * Fidelity compaction summarizer: `BasicCompactionEngine` subclass overriding
 * only the documented `summarize()` customization hook.
 *
 * The auxiliary call keeps the upstream envelope exactly — replayed prefix,
 * same tool schemas, instruction as the final user message — so the
 * provider's KV prefix cache is reused. What changes is the instruction
 * (ZCode's nine-section verbatim-preservation prompt with NO_TOOLS bookends)
 * and the output handling (`<analysis>` discarded, `<summary>` extracted).
 * Per-model policy overrides are v1-out-of-scope: the configured
 * summarization target wins, else the routed target, else agent options.
 *
 * @module @tianma/dsh-compaction-summarize
 */

import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
// The upstream default one-shot summarizer. `super.summarize` cannot serve as
// the fallback: the base engine dispatches its hook back to `this.summarize`
// (summarize is bound dynamically at index.ts), which would re-enter the
// fidelity override. The plain function IS the upstream behavior.
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type {
  SummarizationInput,
  SummaryResult,
} from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import {
  BlockAssembler,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  LlmCallConfig,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FIDELITY_INSTRUCTION } from './instruction.ts'
import { extractSummaryBlocks } from './extract.ts'
import {
  FIDELITY_RETRY_LIMIT,
  SummarizeBreaker,
  estimatePrefixTokens,
  fallbackCheckpoint,
  isPromptTooLong,
  truncatePrefix,
} from './resilience.ts'

export { FIDELITY_INSTRUCTION, FIDELITY_SECTION_HEADERS } from './instruction.ts'
export { extractSummaryBlocks } from './extract.ts'
export {
  FIDELITY_BREAKER_LIMIT,
  FIDELITY_RETRY_LIMIT,
  SummarizeBreaker,
  fallbackCheckpoint,
  isPromptTooLong,
  truncatePrefix,
} from './resilience.ts'

/** Resolve the summarization target: configured, else routed, else agent options. */
function fidelityTarget(
  agent: Agent,
  config: ResolvedConfig,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  if (config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider.length > 0 && latest.model.length > 0) {
    return { provider: latest.provider, model: latest.model }
  }
  if (agent.options.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens':
      return new Error('summarization truncated at the token cap (incomplete checkpoint)')
    default:
      return undefined
  }
}

/** Fidelity compaction engine: upstream replay and durability, fidelity prompt. */
export class FidelityCompactionEngine extends BasicCompactionEngine {
  private readonly breaker = new SummarizeBreaker()

  /**
   * Public pass-through to the resilience-wrapped summarizer for embedding
   * callers and tests (the hook itself stays protected like upstream).
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact call envelope and output.
   */
  runSummarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return this.summarize(input, agent, signal)
  }

  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // Circuit breaker: after FIDELITY_BREAKER_LIMIT consecutive failures the
    // engine falls back to the upstream one-shot instruction until a call
    // succeeds again, so a poisoned route degrades instead of compounding.
    if (this.breaker.open) {
      const result = await this.upstreamSummarize(input, agent, signal)
      this.breaker.recordSuccess()
      return result
    }
    let attemptInput = input
    let lastError: unknown
    for (let attempt = 0; attempt <= FIDELITY_RETRY_LIMIT; attempt += 1) {
      try {
        const result = await this.summarizeOnce(attemptInput, agent, signal)
        this.breaker.recordSuccess()
        return result
      } catch (error) {
        lastError = error
        if (isPromptTooLong(error) && attempt < FIDELITY_RETRY_LIMIT
          && estimatePrefixTokens(attemptInput.messages) > 0) {
          // Retryable over-window rejections are progress, not poison: they
          // must not count toward the breaker.
          attemptInput = { ...attemptInput, messages: truncatePrefix(attemptInput.messages) }
          continue
        }
        const open = this.breaker.recordFailure()
        if (open) {
          const result = await this.upstreamSummarize(input, agent, signal)
          this.breaker.recordSuccess()
          return result
        }
        // Final squeeze: land a deterministic fallback checkpoint instead of
        // erroring the compaction turn (roadmap willRetrigger clause).
        if ((error as { code?: string } | null)?.code === 'MAX_TOKENS'
          || isPromptTooLong(error)) {
          const target = fidelityTarget(agent, this.config)
          if (target !== undefined) {
            const summary = [{ type: 'text' as const, text: fallbackCheckpoint(input.messages) }]
            return {
              summary,
              rawOutput: summary,
              provider: target.provider,
              model: target.model,
              maxTokens: this.config.maxTokens,
            }
          }
        }
        throw error
      }
    }
    throw lastError
  }

  /**
   * One fidelity summarization attempt without resilience wrapping.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact call envelope and output.
   */
  /**
   * The upstream default one-shot summarizer, used as the breaker fallback.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns safe text summary blocks and the exact call envelope and output.
   */
  private upstreamSummarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return summarizeWithLlm(this.ctx, this.config, input, agent, signal)
  }

  private async summarizeOnce(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = fidelityTarget(agent, this.config)
    if (target === undefined) {
      throw new Error(
        'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, route one request, or set both AgentOptions fields',
      )
    }

    const assembler = new BlockAssembler()
    const messages: RequestMessage[] = [
      ...input.messages,
      deepFreeze({
        role: 'user',
        content: [{ type: 'text', text: FIDELITY_INSTRUCTION }],
      }),
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      ...input.tools === undefined ? {} : { tools: [...input.tools] },
      maxTokens: this.config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const error = finishError(assembler.finish)
    if (error !== undefined) throw error

    const rawOutput = assembler.blocks()
    const summary = extractSummaryBlocks(rawOutput)
    if (!summary.some(block => block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: this.config.maxTokens,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }
}

export default FidelityCompactionEngine
