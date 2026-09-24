/**
 * Registration through one apply: the composer gate must wire even though this
 * plugin mounts before `ui-conversation` in the shipped roster — the
 * conversation and session services are declared injects, so a probe could
 * never meet them absent at apply time and silently skip the gate.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ComposerBlock, ComposerBlocks } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OaSessionView } from '@tianma/dsh-oa-account/types'
import { zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const SIGNED_OUT: OaSessionView = { signedIn: false, user: null, status: null, assetOrigin: 'https://oa.example' }
const SIGNED_IN: OaSessionView = { signedIn: true, user: null, status: 'active', assetOrigin: 'https://oa.example' }

/** A session-stream double the spec drives by pushing session projections. */
function streamDouble() {
  const pushed: Array<{ value: OaSessionView; accept: () => void }> = []
  let wake: (() => void) | undefined
  return {
    dispose: (): Promise<void> => Promise.resolve(),
    push(value: OaSessionView): void {
      pushed.push({ value, accept: () => {} })
      wake?.()
      wake = undefined
    },
    [Symbol.asyncIterator]: () => ({
      async next(): Promise<IteratorResult<{ value: OaSessionView; accept: () => void }>> {
        if (pushed.length === 0) await new Promise<void>((resolve) => { wake = resolve })
        return { done: false, value: pushed.shift()! }
      },
    }),
  }
}

describe('the account apply wires the composer gate', () => {
  it('raises the block on every listed session, and clears it once signed in', async () => {
    const ctx = new Context()
    const blockCalls: Array<[SessionId, ComposerBlock | undefined]> = []
    const conversation = {
      blocks: {
        set: (sessionId: SessionId, block: ComposerBlock | undefined): void => { blockCalls.push([sessionId, block]) },
        storeFor: (): never => { throw new Error('the account gate never reads a session block store') },
        forget: (): never => { throw new Error('the account gate never forgets a session block') },
      } as ComposerBlocks,
    }
    const sessions = {
      list: {
        getSnapshot: () => ({ ids: ['one', 'two'] as SessionId[], byId: {}, phase: 'ready' as const, projectionsBySession: {} }),
        subscribe: (_listener: () => void) => () => {},
      },
    }
    let sessionView: OaSessionView = SIGNED_OUT
    const stream = streamDouble()
    const remote = {
      $stream: () => stream,
      oaAccount: {
        session: () => Promise.resolve({ ok: true as const, value: sessionView }),
        profile: () => Promise.resolve({ ok: false as const, error: { message: 'not read here' } }),
        stats: () => Promise.resolve({ ok: false as const, error: { message: 'not read here' } }),
      },
    }
    ctx.provide('slots', { inject: () => {} } as never)
    ctx.provide('locale', {
      register: () => () => {},
      bind: () => (key: keyof typeof zh) => zh[key],
    } as never)
    ctx.provide('remote', remote as never)
    ctx.provide('remote.oaAccount', remote.oaAccount as never)
    ctx.provide('conversation', conversation as never)
    ctx.provide('sessions', sessions as never)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // The first sync runs while the stream is still silent: signed-out is the
    // safe reading, and every live session's composer names the reason.
    expect(blockCalls).toEqual([
      ['one' as SessionId, { reason: zh['signInToSend'] }],
      ['two' as SessionId, { reason: zh['signInToSend'] }],
    ])

    sessionView = SIGNED_IN
    stream.push(SIGNED_IN)
    await vi.waitFor(() => {
      expect(blockCalls.some(call => call[1] === undefined)).toBe(true)
    })
    expect(blockCalls.slice(-2)).toEqual([
      ['one' as SessionId, undefined],
      ['two' as SessionId, undefined],
    ])
  })
})
