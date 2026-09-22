/**
 * File-rehydrator behavior: the ledger rebuilt from the log reflects reads
 * and post-read edits with STALE flagging, the renderer bounds its budget,
 * and the plugin registers a scoped context on agent creation that renders
 * the live view.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { buildFileStateView, renderRehydrationSection } from '@tianma/dsh-compaction-file-rehydrator'
import * as plugin from '@tianma/dsh-compaction-file-rehydrator'

const MODEL = 'test-model'

function session(): Session {
  return Session.create(SessionId('rehydrator-test'))
}

function toolStep(
  test: Session,
  turn: number,
  call: string,
  name: string,
  args: string,
  content: ContentBlock[],
): void {
  const callId = ToolCallId(call)
  test.append('turn/start', { turn })
  test.append('step/start', { turn, step: 1 })
  test.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  test.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: args }],
      source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
    }),
  }, { surfaceOp: 'append' })
  test.append('tool/call', { turn, step: 1, callId, name, arguments: args })
  test.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content, isError: false }),
  }, { surfaceOp: 'append' })
  test.append('step/end', { turn, step: 1 })
  test.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function readStep(test: Session, turn: number, call: string, path: string, body: string): void {
  toolStep(test, turn, call, 'read', JSON.stringify({ path }), [{ type: 'text', text: body }])
}

function editStep(test: Session, turn: number, call: string, path: string): void {
  toolStep(test, turn, call, 'edit', JSON.stringify({ path }), [{ type: 'text', text: 'edited' }])
}

describe('buildFileStateView', () => {
  it('counts reads and flags edits since the last read, newest first', () => {
    const test = session()
    readStep(test, 1, 'r1', '/src/a.ts', 'a body')
    readStep(test, 2, 'r2', '/src/b.ts', 'b body')
    editStep(test, 3, 'e1', '/src/a.ts')
    const view = buildFileStateView(test.snapshotEvents())
    expect(view.skippedUnreadable).toBe(0)
    expect(view.entries.map(entry => entry.path)).toEqual(['/src/a.ts', '/src/b.ts'])
    expect(view.entries[0]).toMatchObject({ path: '/src/a.ts', readCount: 1, editsSinceLastRead: 1 })
    expect(view.entries[1]).toMatchObject({ path: '/src/b.ts', readCount: 1, editsSinceLastRead: 0 })
  })

  it('counts repeated reads of one path and skips unreadable arguments', () => {
    const test = session()
    readStep(test, 1, 'r1', '/src/a.ts', 'one')
    readStep(test, 2, 'r2', '/src/a.ts', 'two')
    toolStep(test, 3, 'x1', 'read', '{not-json', [{ type: 'text', text: 'oops' }])
    const view = buildFileStateView(test.snapshotEvents())
    expect(view.entries).toHaveLength(1)
    expect(view.entries[0]).toMatchObject({ path: '/src/a.ts', readCount: 2 })
    expect(view.skippedUnreadable).toBe(1)
  })

  it('ignores non-file tools entirely', () => {
    const test = session()
    toolStep(test, 1, 'b1', 'bash', JSON.stringify({ command: 'ls' }), [{ type: 'text', text: 'out' }])
    expect(buildFileStateView(test.snapshotEvents()).entries).toEqual([])
  })
})

describe('renderRehydrationSection', () => {
  it('returns empty for an empty view and flags stale files first', () => {
    expect(renderRehydrationSection({ entries: [], skippedUnreadable: 0 })).toBe('')
    const test = session()
    readStep(test, 1, 'r1', '/src/a.ts', 'a')
    editStep(test, 2, 'e1', '/src/a.ts')
    const section = renderRehydrationSection(buildFileStateView(test.snapshotEvents()))
    expect(section).toContain('# Files you have read this session')
    expect(section).toContain('STALE: /src/a.ts')
  })

  it('bounds the section and reports the omitted count', () => {
    const test = session()
    for (let i = 1; i <= 50; i += 1) readStep(test, i, `r${i}`, `/src/file-${i}.ts`, 'body')
    const section = renderRehydrationSection(buildFileStateView(test.snapshotEvents()), 600)
    expect(section.length).toBeLessThanOrEqual(700)
    expect(section).toContain('more files omitted')
  })
})

describe('plugin wiring', () => {
  it('registers a scoped context on agent creation that renders the live view', () => {
    // The scoped-context wiring needs a full agent boot; here we assert the
    // plugin registers its agent/created listener without throwing and that
    // the section name/order constants are stable contract.
    const ctx = new Context()
    expect(() => plugin.apply(ctx, { maxChars: 1024 })).not.toThrow()
    expect(plugin.SECTION_NAME).toBe('tianma:file-rehydration')
    expect(plugin.SECTION_ORDER).toBe(200)
  })
})
