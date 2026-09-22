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

export { FIDELITY_INSTRUCTION, FIDELITY_SECTION_HEADERS } from './instruction.ts'
export { extractSummaryBlocks } from './extract.ts'

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
  protected override async summarize(
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
