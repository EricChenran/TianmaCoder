// @vitest-environment jsdom
/** The composer recalls text this Session already sent, and stops recalling as soon as the user types. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { makeTranslate, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished } from 'vitest'
import { InputHub } from '../src/client/input/hub.ts'
import type { SessionInputShell } from '../src/client/input/facade.ts'
import { zh } from '../src/client/locales.ts'

/** Root conversation service stand-in: every send succeeds immediately. */
class AcceptingConversation extends Service {
  /** @param ctx - client root context that owns the service slot. */
  constructor(ctx: Context) {
    super(ctx, 'conversation')
  }

  /**
   * @returns a successful settlement for every send.
   */
  sendSession(): Promise<{ kind: 'success' }> {
    return Promise.resolve({ kind: 'success' })
  }

  /**
   * @returns no serialized attachments (this bench sends text only).
   */
  serializeDraftAttachments(): Promise<{ attachments: [] }> {
    return Promise.resolve({ attachments: [] })
  }

  /** No prepared files exist in this bench. */
  releaseDraftAttachment(): void {}

  /** No prepared files exist in this bench. */
  rebindDraftFiles(): void {}
}

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  await ctx.plugin(AcceptingConversation)
  const id = SessionId(`sent-history-${randomUUID()}`)
  await sessions.add({ id })
  const retained = sessions.retain(id)
  onTestFinished(() => { retained.release() })
  await retained.ready
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  return { shell: hub.shellFor(retained.binding) }
}

/**
 * Send one prompt through the composer and wait for the sink to settle, so the
 * text is recorded in the recall buffer.
 * @param shell - the Session input facade under test.
 * @param text - the prompt to send.
 */
async function send(shell: SessionInputShell, text: string): Promise<void> {
  shell.setDraft(text)
  shell.submit('queue', 'enter')
  // The sink settles on a microtask; two turns cover the promise chain in
  // settleSink even when the send is detached behind serialization.
  await Promise.resolve()
  await Promise.resolve()
}

it('recalls the text just sent once the draft is empty', async () => {
  const { shell } = await bench()
  await send(shell, 'hello world')

  expect(shell.snapshot.draft).toBe('')
  expect(shell.recallSent('older')).toBe(true)
  expect(shell.snapshot.draft).toBe('hello world')
})

it('walks further back on repeated older recalls and stays at the oldest', async () => {
  const { shell } = await bench()
  await send(shell, 'first prompt')
  await send(shell, 'second prompt')

  expect(shell.recallSent('older')).toBe(true)
  expect(shell.snapshot.draft).toBe('second prompt')
  expect(shell.recallSent('older')).toBe(true)
  expect(shell.snapshot.draft).toBe('first prompt')
  expect(shell.recallSent('older')).toBe(true)
  expect(shell.snapshot.draft).toBe('first prompt')
})

it('walks forward again and clears the draft past the newest entry', async () => {
  const { shell } = await bench()
  await send(shell, 'first prompt')
  await send(shell, 'second prompt')
  shell.recallSent('older')
  shell.recallSent('older')

  expect(shell.recallSent('newer')).toBe(true)
  expect(shell.snapshot.draft).toBe('second prompt')
  expect(shell.recallSent('newer')).toBe(true)
  expect(shell.snapshot.draft).toBe('')
})

it('refuses to recall over a draft the user is writing', async () => {
  const { shell } = await bench()
  await send(shell, 'earlier prompt')
  shell.setDraft('a new draft')

  expect(shell.recallSent('older')).toBe(false)
  expect(shell.snapshot.draft).toBe('a new draft')
})

it('restarts the walk at the newest entry after the user edits a recalled one', async () => {
  const { shell } = await bench()
  await send(shell, 'first prompt')
  await send(shell, 'second prompt')
  shell.recallSent('older')
  expect(shell.snapshot.draft).toBe('second prompt')

  shell.setDraft('second prompt edited')
  expect(shell.recallSent('older')).toBe(false)
  shell.setDraft('')
  expect(shell.recallSent('older')).toBe(true)
  expect(shell.snapshot.draft).toBe('second prompt')
})
