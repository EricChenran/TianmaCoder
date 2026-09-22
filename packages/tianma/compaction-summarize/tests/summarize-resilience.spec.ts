/**
 * Summarizer resilience: prompt-too-long retries truncate the prefix, the
 * deterministic fallback checkpoint lands when the cap is final, and the
 * circuit breaker falls back to upstream behavior after consecutive
 * failures.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  FIDELITY_BREAKER_LIMIT,
  FIDELITY_RETRY_LIMIT,
  FidelityCompactionEngine,
  fallbackCheckpoint,
  isPromptTooLong,
  truncatePrefix,
} from '@tianma/dsh-compaction-summarize'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime, { LlmAdapter, LlmError, createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

type Failure = { kind: 'error'; failure: { message: string; code?: string } }

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: Array<'ok' | Failure>,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = this.script.shift() ?? 'ok'
    if (step !== 'ok') {
      yield { type: 'finish', reason: step as never }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '<summary>1. Primary Request and Intent: ok</summary>' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TOO_LONG: Failure = { kind: 'error', failure: { message: 'prompt too long', code: 'CONTEXT_WINDOW_EXCEEDED' } }
const CAPPED: Failure = { kind: 'error', failure: { message: 'capped', code: 'MAX_TOKENS' } }
const BROKEN: Failure = { kind: 'error', failure: { message: 'route broken', code: 'PROVIDER_DOWN' } }

function userMessage(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function assistantMessage(text: string): Message {
  return createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
  })
}

function replay(turns = 12): Message[] {
  const messages: Message[] = []
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(userMessage(`user request ${turn} ${'detail '.repeat(20)}`))
    messages.push(assistantMessage(`assistant reply ${turn}`))
  }
  return messages
}

function engine(ctx: Context): FidelityCompactionEngine {
  return new FidelityCompactionEngine(ctx, {
    headroomTokens: 0,
    maxTokens: 8192,
    auto: false,
    thresholdRatio: 0.5,
    retainTokens: 50,
  })
}

function createContext(adapter: ScriptedAdapter): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], adapter)
  return ctx
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

describe('resilience helpers', () => {
  it('detects prompt-too-long failures by code', () => {
    expect(isPromptTooLong(new LlmError('x', 'CONTEXT_WINDOW_EXCEEDED'))).toBe(true)
    expect(isPromptTooLong(new LlmError('x', 'MAX_TOKENS'))).toBe(false)
    expect(isPromptTooLong(new Error('x'))).toBe(false)
  })

  it('truncates to half the tail with a marker and keeps the system head', () => {
    const messages: Message[] = [createSystemMessage('system head'), ...replay(8)]
    const truncated = truncatePrefix(messages)
    expect(truncated.length).toBeLessThan(messages.length)
    expect(truncated[0]!.role).toBe('system')
    expect(truncated.some(message => message.role === 'user'
      && message.content.some(block => block.type === 'text' && block.text.includes('truncated for compaction retry')))).toBe(true)
    expect(truncated.at(-1)).toEqual(messages.at(-1))
  })

  it('builds a fallback checkpoint with verbatim user lines and a tail', () => {
    const checkpoint = fallbackCheckpoint(replay(3))
    expect(checkpoint).toContain('user request 1')
    expect(checkpoint).toContain('mechanical fallback')
    expect(checkpoint.length).toBeLessThan(12_000 + 2_000)
  })
})

describe('FidelityCompactionEngine resilience', () => {
  it('retries truncated prefixes on CONTEXT_WINDOW_EXCEEDED and succeeds', async () => {
    const adapter = new ScriptedAdapter([TOO_LONG, TOO_LONG, 'ok'])
    const ctx = createContext(adapter)
    const compact = engine(ctx)
    const input = { messages: replay(12) }
    const result = await compact.runSummarize(input, agent(Session.create(SessionId('retry'))), SIGNAL)
    expect(result.summary.some(block => block.type === 'text' && block.text.includes('Primary Request'))).toBe(true)
    expect(adapter.requests.length).toBe(3)
    const first = adapter.requests[0]!.messages.length
    const second = adapter.requests[1]!.messages.length
    expect(second).toBeLessThan(first)
  })

  it('lands the deterministic fallback checkpoint after final MAX_TOKENS', async () => {
    const script: Array<'ok' | Failure> = [TOO_LONG, TOO_LONG, TOO_LONG, TOO_LONG, CAPPED]
    const adapter = new ScriptedAdapter(script)
    const ctx = createContext(adapter)
    const compact = engine(ctx)
    const result = await compact.runSummarize(
      { messages: replay(12) },
      agent(Session.create(SessionId('fallback'))),
      SIGNAL,
    )
    const text = result.summary.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('user request 12')
    expect(text).toContain('mechanical fallback')
  }, 20_000)

  it('gives up after the retry limit on persistent non-retryable failures', async () => {
    const adapter = new ScriptedAdapter(Array.from({ length: FIDELITY_RETRY_LIMIT + 1 }, () => BROKEN))
    const ctx = createContext(adapter)
    const compact = engine(ctx)
    await expect(compact.runSummarize(
      { messages: replay(4) },
      agent(Session.create(SessionId('broken'))),
      SIGNAL,
    )).rejects.toThrow('route broken')
    expect(adapter.requests.length).toBe(1)
  })

  it('opens the breaker after consecutive failures and falls back to upstream instruction', async () => {
    const script: Array<'ok' | Failure> = Array.from({ length: FIDELITY_BREAKER_LIMIT }, () => BROKEN)
    script.push('ok', 'ok')
    const adapter = new ScriptedAdapter(script)
    const ctx = createContext(adapter)
    const compact = engine(ctx)
    const firstTwo = FIDELITY_BREAKER_LIMIT - 1
    for (let i = 0; i < firstTwo; i += 1) {
      await expect(compact.runSummarize(
        { messages: replay(2) },
        agent(Session.create(SessionId(`breaker-${i}`))),
        SIGNAL,
      )).rejects.toThrow('route broken')
    }
    // The failure that opens the breaker degrades the SAME call to upstream.
    const degraded = await compact.runSummarize(
      { messages: replay(2) },
      agent(Session.create(SessionId('breaker-degraded'))),
      SIGNAL,
    )
    const degradedInstruction = adapter.requests[3]!.messages.at(-1)!
    const text = degradedInstruction.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Output EXACTLY the Markdown structure below')
    expect(degraded.summary.some(block => block.type === 'text')).toBe(true)
    // The upstream success closed the breaker: the next call is fidelity again.
    await compact.runSummarize(
      { messages: replay(2) },
      agent(Session.create(SessionId('after-breaker'))),
      SIGNAL,
    )
    const afterText = adapter.requests[4]!.messages.at(-1)!.content
      .map(block => block.type === 'text' ? block.text : '').join('')
    expect(afterText).toContain('CRITICAL: Respond with TEXT ONLY')
  }, 20_000)
})
