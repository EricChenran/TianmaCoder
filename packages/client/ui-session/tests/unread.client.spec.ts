/** Last-seen marks decide which Session rows read as unread. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  LAST_SEEN_STORAGE_KEY, isUnread, loadLastSeen, parseLastSeen, saveLastSeen, serializeLastSeen,
} from '../src/client/unread.ts'

function memoryStorage(initial: Record<string, string> = {}) {
  const cells = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => { cells.set(key, value) },
  }
}

describe('unread derivation', () => {
  it('treats activity newer than the last view as unread', () => {
    expect(isUnread(2, 1)).toBe(true)
    expect(isUnread(1, 1)).toBe(false)
    expect(isUnread(1, undefined)).toBe(true)
    expect(isUnread(undefined, 5)).toBe(false)
  })

  it('round-trips marks and drops entries that are not timestamps', () => {
    const marks = new Map([[SessionId('first'), 10], [SessionId('second'), 20]])
    expect(parseLastSeen(serializeLastSeen(marks))).toEqual(marks)
    expect(parseLastSeen(JSON.stringify({ first: 'soon', second: 5, third: null })))
      .toEqual(new Map([[SessionId('second'), 5]]))
  })

  it('reads no marks from corrupt, absent, or unreachable storage', () => {
    expect(parseLastSeen('{ not json')).toEqual(new Map())
    expect(loadLastSeen(memoryStorage())).toEqual(new Map())
    expect(loadLastSeen(undefined)).toEqual(new Map())
    expect(loadLastSeen({
      getItem: () => { throw new Error('storage blocked') },
      setItem: () => {},
    })).toEqual(new Map())
  })

  it('persists marks under the documented key', () => {
    const storage = memoryStorage()
    saveLastSeen(new Map([[SessionId('first'), 42]]), storage)
    expect(storage.getItem(LAST_SEEN_STORAGE_KEY)).toBe(JSON.stringify({ first: 42 }))
  })
})
