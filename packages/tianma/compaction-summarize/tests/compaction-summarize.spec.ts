/**
 * Fidelity summarizer behavior: the nine-section instruction with NO_TOOLS
 * bookends rides as the final user message (KV-prefix-preserving), the
 * `<analysis>` scratchpad is discarded in favor of the extracted `<summary>`,
 * and untagged output still lands a usable checkpoint.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  FIDELITY_INSTRUCTION,
  FIDELITY_SECTION_HEADERS,
  extractSummaryBlocks,
} from '@tianma/dsh-compaction-summarize'
import FidelityCompactionEngine from '@tianma/dsh-compaction-summarize'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  LlmAdapter,
  createMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

const CHECKPOINT = [
  '1. Primary Request and Intent: fix the login timeout.',
  '2. Key Technical Concepts: session refresh, retry policy.',
  '3. Files and Code: src/auth.ts — refresh logic.',
  '4. Errors and Fixes: 401 loop — added backoff.',
  '5. All User Messages:',
  '  1. "Fix the login timeout but never log credentials."',
  '  2. "Prefer the retry helper."',
  '6. Pending Tasks: add regression test.',
  '7. Current Work: wiring the retry helper into refresh().',
  '8. Next Step: run the auth suite. Quote: "run the auth suite after wiring".',
  '9. Critical Context: constraint — never log credentials.',
].join('\n')

class FidelityAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined

  constructor(private readonly blocks: readonly ContentBlock[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 1_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    for (const [index, block] of this.blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') {
        yield { type: 'text-delta', index, text: block.text }
      } else {
        yield { type: 'block-end', index, block }
      }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(adapter: FidelityAdapter): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], adapter)
  return ctx
}

function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId('fidelity-conversation'))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

async function compactIfNeeded(
  compact: FidelityCompactionEngine,
  session: Session,
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
}

describe('fidelity instruction', () => {
  it('carries all nine section headers in order', () => {
    const positions = FIDELITY_SECTION_HEADERS.map(header => FIDELITY_INSTRUCTION.indexOf(header))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('demands verbatim user-message and security-constraint preservation', () => {
    expect(FIDELITY_INSTRUCTION).toContain('List ALL user messages')
    expect(FIDELITY_INSTRUCTION).toContain('preserved verbatim')
    expect(FIDELITY_INSTRUCTION).toContain('security-relevant instructions or constraints')
    expect(FIDELITY_INSTRUCTION).toContain('VERBATIM')
  })

  it('bookends the body with NO_TOOLS guards and forces the output shape', () => {
    expect(FIDELITY_INSTRUCTION.startsWith('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.')).toBe(true)
    expect(FIDELITY_INSTRUCTION.trimEnd().endsWith('Tool calls will be rejected and you will fail the task.')).toBe(true)
    expect(FIDELITY_INSTRUCTION).toContain('<analysis> block followed by a <summary> block')
  })

  it('consolidates prior checkpoints instead of copying them forward', () => {
    expect(FIDELITY_INSTRUCTION).toContain('<compacted-summary>')
    expect(FIDELITY_INSTRUCTION).toContain('Do not copy it forward verbatim')
  })
})

describe('summary extraction', () => {
  const tagged: ContentBlock[] = [
    { type: 'text', text: '<analysis>scratchpad reasoning</analysis>' },
    { type: 'text', text: `<summary>\n${CHECKPOINT}\n</summary>` },
  ]

  it('keeps only the summary span, dropping the analysis scratchpad', () => {
    const extracted = extractSummaryBlocks(tagged)
    expect(extracted).toEqual([{ type: 'text', text: CHECKPOINT }])
  })

  it('passes untagged text through as a tolerant fallback', () => {
    const extracted = extractSummaryBlocks([{ type: 'text', text: CHECKPOINT }])
    expect(extracted).toEqual([{ type: 'text', text: CHECKPOINT }])
  })

  it('rejects an empty summary span and image output', () => {
    expect(() => extractSummaryBlocks([{ type: 'text', text: '<summary>  </summary>' }]))
      .toThrow(/empty <summary> block/)
    expect(() => extractSummaryBlocks([
      { type: 'text', text: 'ok' },
      { type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } },
    ])).toThrow(/cannot contain image/)
  })
})

describe('FidelityCompactionEngine', () => {
  it('sends the fidelity instruction as the final user message with tools attached', async () => {
    const adapter = new FidelityAdapter([
      { type: 'text', text: `<analysis>thinking</analysis>\n<summary>${CHECKPOINT}</summary>` },
    ])
    const ctx = createContext(adapter)
    const engine = new FidelityCompactionEngine(ctx, {
      headroomTokens: 0,
      maxTokens: 8192,
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = conversation()
    expect(await compactIfNeeded(engine, session)).not.toBeNull()

    const options = adapter.lastOptions!
    expect(options.messages.at(-1)).toMatchObject({ role: 'user' })
    const last = options.messages.at(-1)!
    expect(last.content).toEqual([{ type: 'text', text: FIDELITY_INSTRUCTION }])
    expect(options.purpose).toBe('compaction')
    expect(options.messages[0]).toBeDefined()
  })

  it('lands the extracted checkpoint, not the analysis scratchpad', async () => {
    const adapter = new FidelityAdapter([
      { type: 'text', text: '<analysis>private reasoning must not survive</analysis>' },
      { type: 'text', text: `<summary>\n${CHECKPOINT}\n</summary>` },
    ])
    const ctx = createContext(adapter)
    const engine = new FidelityCompactionEngine(ctx, {
      headroomTokens: 0,
      maxTokens: 8192,
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = conversation()
    expect(await compactIfNeeded(engine, session)).not.toBeNull()

    const head = session.deriveMessages()[0]!
    const headText = head.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(headText).toContain('1. Primary Request and Intent')
    expect(headText).toContain('5. All User Messages')
    expect(headText).not.toContain('private reasoning must not survive')
  })

  it('still lands a checkpoint when the provider ignores the tag shape', async () => {
    const adapter = new FidelityAdapter([{ type: 'text', text: CHECKPOINT }])
    const ctx = createContext(adapter)
    const engine = new FidelityCompactionEngine(ctx, {
      headroomTokens: 0,
      maxTokens: 8192,
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    })
    const session = conversation()
    expect(await compactIfNeeded(engine, session)).not.toBeNull()
    const head = session.deriveMessages()[0]!
    expect(head.content.some(block => block.type === 'text' && block.text.includes('9. Critical Context'))).toBe(true)
  })
})
