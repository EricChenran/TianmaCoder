/** Last-seen bookkeeping that derives a Session row's unread flag from its activity time. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Browser-storage key holding last-seen timestamps, keyed by Session identity. */
export const LAST_SEEN_STORAGE_KEY = 'dsh.session.lastSeenAt.v1'

/** Storage surface the marks need; absent outside a browser page. */
export type LastSeenStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Decide whether a Session holds activity newer than the moment it was last shown.
 * @param updatedAt - latest activity timestamp of the Session row, absent while it is unlisted.
 * @param lastSeenAt - when this client last showed the Session, absent for a never-opened row.
 * @returns true when the row is newer than the last-seen mark.
 */
export function isUnread(updatedAt: number | undefined, lastSeenAt: number | undefined): boolean {
  if (updatedAt === undefined) return false
  return updatedAt > (lastSeenAt ?? 0)
}

/**
 * Decode persisted last-seen marks, dropping every entry that is not a finite timestamp.
 * @param raw - stored JSON text, or null when the key was never written.
 * @returns the decoded marks, empty when nothing readable was stored.
 */
export function parseLastSeen(raw: string | null): Map<SessionId, number> {
  const marks = new Map<SessionId, number>()
  if (raw === null) return marks
  const decoded = decodeJson(raw)
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return marks
  for (const [id, value] of Object.entries(decoded)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    marks.set(id as SessionId, value)
  }
  return marks
}

/**
 * Encode last-seen marks for browser storage.
 * @param marks - timestamp per Session identity.
 * @returns the JSON text to persist.
 */
export function serializeLastSeen(marks: ReadonlyMap<SessionId, number>): string {
  return JSON.stringify(Object.fromEntries(marks))
}

/**
 * Read the persisted marks, surviving storage that is unavailable or refuses reads.
 * @param storage - storage to read; defaults to `localStorage` when the page has one.
 * @returns the marks, empty when nothing readable was stored.
 */
export function loadLastSeen(storage: LastSeenStorage | undefined = defaultStorage()): Map<SessionId, number> {
  if (storage === undefined) return new Map()
  try {
    return parseLastSeen(storage.getItem(LAST_SEEN_STORAGE_KEY))
  } catch (error) {
    /* A blocked origin loses only this cache; every row then derives from its own activity time. */
    void error
    return new Map()
  }
}

/**
 * Persist the marks, ignoring storage that refuses writes.
 * @param marks - timestamp per Session identity.
 * @param storage - storage to write; defaults to `localStorage` when the page has one.
 */
export function saveLastSeen(
  marks: ReadonlyMap<SessionId, number>,
  storage: LastSeenStorage | undefined = defaultStorage(),
): void {
  if (storage === undefined) return
  try {
    storage.setItem(LAST_SEEN_STORAGE_KEY, serializeLastSeen(marks))
  } catch (error) {
    /* Quota or a private-mode refusal loses only the mark; later activity re-derives it. */
    void error
  }
}

function decodeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    /* Stored marks are a cache rather than a contract, so a corrupt payload means "no marks". */
    void error
    return undefined
  }
}

function defaultStorage(): LastSeenStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}
