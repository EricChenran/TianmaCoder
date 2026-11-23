// @vitest-environment jsdom
/** Session switches carry the composer draft instead of dropping its attachments with the source scope. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { makeTranslate, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { DraftAttachmentId } from '../src/client/contract/input.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { zh } from '../src/client/locales.ts'

/** Rebind calls issued by every mounted stand-in; cleared before each case. */
const rebindDraftFiles = vi.fn()

beforeEach(() => { rebindDraftFiles.mockClear() })

/** Root conversation service stand-in: records the rebind a move asks for. */
class RecordingConversation extends Service {
  /** Rebind calls issued by draft moves. */
  readonly rebindDraftFiles = rebindDraftFiles

  /** @param ctx - client root context that owns the service slot. */
  constructor(ctx: Context) {
    super(ctx, 'conversation')
  }
}

async function bench() {
  const ctx = new Context()
  const sessions = new TestSessions(async (operation) => { await operation() }, ctx)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  ctx.provide('sessions', sessions)
  await ctx.plugin(RecordingConversation)
  const fromId = SessionId(`draft-move-from-${randomUUID()}`)
  const toId = SessionId(`draft-move-to-${randomUUID()}`)
  await sessions.add({ id: fromId })
  await sessions.add({ id: toId })
  const from = sessions.retain(fromId)
  const to = sessions.retain(toId)
  onTestFinished(() => {
    from.release()
    to.release()
  })
  await from.ready
  await to.ready
  const hub = new InputHub(ctx, makeTranslate(zh, {}))
  return {
    hub, fromId, toId,
    from: hub.shellFor(from.binding), to: hub.shellFor(to.binding),
  }
}

it('carries the draft text and its attachment ids into an empty target Session', async () => {
  const b = await bench()
  const id = 'carry-1' as DraftAttachmentId
  b.from.setDraft('carry this prompt')
  expect(b.from.addAttachments([id])).toBe(true)

  expect(b.hub.moveDraft(b.fromId, b.toId)).toBe(true)

  expect(b.to.snapshot.draft).toBe('carry this prompt')
  expect(b.to.snapshot.attachmentIds).toEqual([id])
  expect(b.from.snapshot.draft).toBe('')
  expect(b.from.snapshot.attachmentIds).toEqual([])
  expect(rebindDraftFiles).toHaveBeenCalledWith(b.toId, [id])
})

it('returns the same attachments after switching away and back', async () => {
  const b = await bench()
  const id = 'carry-back' as DraftAttachmentId
  b.from.setDraft('round trip')
  expect(b.from.addAttachments([id])).toBe(true)

  expect(b.hub.moveDraft(b.fromId, b.toId)).toBe(true)
  expect(b.hub.moveDraft(b.toId, b.fromId)).toBe(true)

  expect(b.from.snapshot.draft).toBe('round trip')
  expect(b.from.snapshot.attachmentIds).toEqual([id])
  expect(b.to.snapshot.attachmentIds).toEqual([])
  expect(rebindDraftFiles).toHaveBeenLastCalledWith(b.fromId, [id])
})

it('leaves both drafts alone while the source admission is claimed', async () => {
  const b = await bench()
  const id = 'busy-1' as DraftAttachmentId
  b.from.setDraft('/demo ')
  expect(b.from.addAttachments([id])).toBe(true)
  const token = '/demo'
  const span = { start: 0, end: token.length + 1, draftRev: b.from.snapshot.draftRev }
  expect(b.from.beginCommand({ name: 'demo', token } as never, span)).toBe(true)
  expect(b.from.snapshot.phase).toBe('claimed')

  expect(b.hub.moveDraft(b.fromId, b.toId)).toBe(false)

  expect(b.from.snapshot.attachmentIds).toEqual([id])
  expect(b.to.snapshot.attachmentIds).toEqual([])
  expect(rebindDraftFiles).not.toHaveBeenCalled()
})

it('never overwrites a target Session that already holds a draft', async () => {
  const b = await bench()
  const id = 'occupied-1' as DraftAttachmentId
  b.from.setDraft('source prompt')
  expect(b.from.addAttachments([id])).toBe(true)
  b.to.setDraft('target prompt')

  expect(b.hub.moveDraft(b.fromId, b.toId)).toBe(false)

  expect(b.to.snapshot.draft).toBe('target prompt')
  expect(b.from.snapshot.draft).toBe('source prompt')
  expect(b.from.snapshot.attachmentIds).toEqual([id])
})
