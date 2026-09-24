/**
 * The client half of the conversation gate: which sessions lose their composer
 * while no account is signed in, and what the inert composer says.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ComposerBlocks, ComposerBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh } from '../src/client/locales.ts'
import { syncComposerBlock } from '../src/client/composer-block.ts'

const sid = (key: string): SessionId => key as SessionId

/** A session list carrying exactly the given ids. */
function list(ids: readonly string[]): SessionListState {
  return { ids: ids.map(sid), byId: {}, phase: 'ready', projectionsBySession: {} }
}

/**
 * @param set - records the pushes this plugin makes.
 * @returns a conversation face whose other members the gate never reaches.
 */
function conversation(set: (sessionId: SessionId, block: ComposerBlock | undefined) => void): { blocks: ComposerBlocks } {
  return {
    blocks: {
      set,
      storeFor: () => { throw new Error('the account gate never reads a session block store') },
      forget: () => { throw new Error('the account gate never forgets a session block') },
    },
  }
}

describe('the pushed composer block', () => {
  it('refuses every live session while no account is signed in', () => {
    const set = vi.fn()
    syncComposerBlock(conversation(set), list(['one', 'two']), zh['signInToSend'])
    expect(set.mock.calls).toEqual([
      [sid('one'), { reason: zh['signInToSend'] }],
      [sid('two'), { reason: zh['signInToSend'] }],
    ])
  })

  it('clears every live session once an account is signed in', () => {
    const set = vi.fn()
    syncComposerBlock(conversation(set), list(['one', 'two']), undefined)
    expect(set.mock.calls).toEqual([
      [sid('one'), undefined],
      [sid('two'), undefined],
    ])
  })

  it('touches nothing while the client lists no session', () => {
    const set = vi.fn()
    syncComposerBlock(conversation(set), list([]), zh['signInToSend'])
    expect(set).not.toHaveBeenCalled()
  })
})
