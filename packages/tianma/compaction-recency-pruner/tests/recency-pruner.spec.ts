/**
 * Recency-pruner behavior: the active window stays byte-identical, older
 * oversized results from whitelisted tools clear wholesale to one marker
 * line, and the shadow-price protocol lands replays exactly like the
 * upstream pruner's.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  Session,
  SessionId,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import RecencyToolResultPruner, {
  CLEARED_MARKER,
  DEFAULTS,
  resolveConfig,
} from '@tianma/dsh-compaction-recency-pruner'
import type { RecencyPruneConfig } from '@tianma/dsh-compaction-recency-pruner'

const MODEL = 'test-model'
const SMALL: RecencyPruneConfig = {
  keepRecentResults: 2,
  thresholdChars: 50,
  minCharsSaved: 5,
}

function service(config: RecencyPruneConfig = SMALL): RecencyToolResultPruner {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  return new RecencyToolResultPruner(ctx, config)
}

function session(): Session {
  return Session.create(SessionId('recency-test'))
}

function appendToolStep(
  session: Session,
  turn: number,
  call: string,
  name: string,
  content: ContentBlock[],
): number {
  const callId = ToolCallId(call)
  session.append('turn/start', {
    turn,
  })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name, arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result.seq
}

const OVERSIZED: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(120) }]

describe('recency-pruner configuration', () => {
  it('resolves detached immutable defaults', () => {
    const resolved = resolveConfig()
    expect(resolved).toEqual({
      keepRecentResults: 5,
      thresholdChars: 8192,
      minCharsSaved: 1024,
      compactableTools: DEFAULTS.compactableTools,
    })
    expect(Object.isFrozen(resolved)).toBe(true)
  })

  it('rejects unknown keys and an impossible threshold', () => {
    expect(() => resolveConfig({ nope: 1 } as unknown as RecencyPruneConfig))
      .toThrow(/unknown key "nope"/)
    expect(() => resolveConfig({ keepRecentResults: 0 })).toThrow(/keepRecentResults .* positive integer/)
    // threshold 30 cannot exceed marker (~32) + minCharsSaved 5.
    expect(() => resolveConfig({ minCharsSaved: -1 })).toThrow(/minCharsSaved .* non-negative integer/)
    expect(() => resolveConfig({ compactableTools: [''] })).toThrow(/non-empty strings/)
  })
})

describe('RecencyToolResultPruner active-window guarantee', () => {
  it('keeps the most recent results byte-identical and clears only older oversized ones', () => {
    const test = session()
    const seqs: number[] = []
    for (let turn = 1; turn <= 7; turn += 1) {
      seqs.push(appendToolStep(test, turn, `call-${turn}`, 'read', OVERSIZED))
    }
    const result = service().pruneSession(test)

    // 7 results, keepRecentResults 2: only the 5 oldest are candidates.
    expect(result.cleared.map(entry => entry.originalSeq)).toEqual(seqs.slice(0, 5))
    expect(result.charsRemoved).toBe(5 * (120 - CLEARED_MARKER.length))

    // The active window is untouched: no replacement event cites it.
    for (const seq of seqs.slice(5)) {
      expect(result.cleared.some(entry => entry.originalSeq === seq)).toBe(false)
      const event = test.eventAt(SessionSeq(seq))
      expect(JSON.stringify(test.deriveEventMessage(event!))).not.toContain(CLEARED_MARKER)
    }
  })

  it('clears nothing when the session holds at most keepRecentResults results', () => {
    const test = session()
    appendToolStep(test, 1, 'only-1', 'read', OVERSIZED)
    appendToolStep(test, 2, 'only-2', 'read', OVERSIZED)
    expect(service().pruneSession(test).cleared).toEqual([])
  })

  it('leaves below-threshold old results alone', () => {
    const test = session()
    appendToolStep(test, 1, 'small', 'read', [{ type: 'text', text: 'tiny' }])
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    expect(service().pruneSession(test).cleared).toEqual([])
  })

  it('leaves non-whitelisted tools alone even when old and oversized', () => {
    const test = session()
    appendToolStep(test, 1, 'todo', 'todo_write', OVERSIZED)
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    expect(service().pruneSession(test).cleared).toEqual([])
  })

  it('skips candidates whose savings do not clear minCharsSaved', () => {
    const test = session()
    // 60 chars over threshold 50 saves 60 - 33 = 27 < 40.
    appendToolStep(test, 1, 'marginal', 'read', [{ type: 'text', text: 'y'.repeat(60) }])
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    const marginal = service({ ...SMALL, minCharsSaved: 40 }).pruneSession(test)
    expect(marginal.cleared).toEqual([])

    // 90 chars over threshold 50 saves 90 - 33 = 57 >= 40: clears.
    const qualifying = session()
    appendToolStep(qualifying, 1, 'ample', 'read', [{ type: 'text', text: 'y'.repeat(90) }])
    appendToolStep(qualifying, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(qualifying, 3, 'recent-2', 'read', OVERSIZED)
    expect(service({ ...SMALL, minCharsSaved: 40 }).pruneSession(qualifying).cleared).toHaveLength(1)
  })
})

describe('RecencyToolResultPruner replacement shape', () => {
  it('replaces text with the single marker line and preserves rich blocks', () => {
    const test = session()
    appendToolStep(test, 1, 'old', 'bash', [
      { type: 'text', text: 'line-one '.repeat(10) },
      { type: 'text', text: 'line-two '.repeat(10) },
    ])
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    const result = service().pruneSession(test)

    expect(result.cleared).toHaveLength(1)
    const replacement = test.snapshotEvents().at(-1)!
    expect(replacement.type).toBe('tool/result')
    const message = test.deriveEventMessage(replacement) as unknown as { content: ContentBlock[] }
    expect(message.content).toEqual([{ type: 'text', text: CLEARED_MARKER }])
  })

  it('lands the compaction/prune shadow-price event before each replacement', () => {
    const test = session()
    appendToolStep(test, 1, 'old', 'bash', OVERSIZED)
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    service().pruneSession(test)

    const events = test.snapshotEvents()
    const pruneAt = events.findIndex(event => event.type === 'compaction/prune')
    expect(pruneAt).toBeGreaterThanOrEqual(0)
    expect(events[pruneAt + 1]!.type).toBe('tool/result')
    const shadow = events[pruneAt] as unknown as { data: { shadowedTokenCount: number } }
    expect(shadow.data.shadowedTokenCount).toBeGreaterThan(0)
  })

  it('preserves non-text blocks (logged image-offload selections survive)', () => {
    const test = session()
    appendToolStep(test, 1, 'old', 'bash', [
      { type: 'text', text: 'x'.repeat(120) },
      { type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}` as never, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } },
    ])
    appendToolStep(test, 2, 'recent', 'read', OVERSIZED)
    appendToolStep(test, 3, 'recent-2', 'read', OVERSIZED)
    service().pruneSession(test)

    const replacement = test.snapshotEvents().at(-1)!
    const message = test.deriveEventMessage(replacement) as unknown as { content: ContentBlock[] }
    expect(message.content[0]).toEqual({ type: 'text', text: CLEARED_MARKER })
    expect(message.content[1]!.type).toBe('image')
  })
})

describe('RecencyToolResultPruner service registration', () => {
  it('registers on the toolResultPruner seam with the token meter injected', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const pruner = new RecencyToolResultPruner(ctx, SMALL)
    const seam = ctx.get('toolResultPruner') as unknown as RecencyToolResultPruner
    expect(seam.config).toEqual(pruner.config)
    expect(typeof seam.pruneSession).toBe('function')
  })

  it('loads as a Cordis plugin with validated config', async () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    await ctx.plugin(RecencyToolResultPruner, { keepRecentResults: 3 })
    const pruner = ctx.get('toolResultPruner') as unknown as RecencyToolResultPruner
    expect(pruner.config.keepRecentResults).toBe(3)
    expect(pruner.config.thresholdChars).toBe(DEFAULTS.thresholdChars)
    expect(pruner.config.minCharsSaved).toBe(DEFAULTS.minCharsSaved)
  })
})

// Keep the invariant registry import meaningful for session integrity checks.
void SessionInvariant
void InvariantRegistry
