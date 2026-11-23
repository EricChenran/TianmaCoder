/**
 * Recall buffer for text already sent in one Session.
 *
 * Runtime state only: nothing here is persisted with the draft, so a reload
 * starts empty. The most recent entry sits at index 0 and the cursor is
 * cleared after any ordinary edit, which keeps a recalled entry from being
 * overwritten by typing.
 */

/** Entries retained per Session; older sends fall off the end. */
export const SENT_HISTORY_LIMIT = 50

/** One Session's recall buffer. */
export interface SentHistoryFace {
  /**
   * Record a successfully sent text.
   * @param text - the prompt as the user wrote it.
   */
  record(text: string): void
  /**
   * Walk the buffer and return the entry to place in the draft.
   * @param direction - 'older' walks back in time, 'newer' forward.
   * @returns the text to insert, '' when the walk past the newest entry clears the draft, or null when nothing is recalled.
   */
  recall(direction: 'older' | 'newer'): string | null
  /** Forget the walk position; the next recall starts at the newest entry. */
  reset(): void
}

/**
 * @returns an empty buffer for one Session.
 */
export function createSentHistory(): SentHistoryFace {
  const entries: string[] = []
  let cursor: number | undefined

  return {
    record(text) {
      const trimmed = text.trim()
      if (trimmed === '') return
      if (entries[0] !== trimmed) {
        entries.unshift(trimmed)
        if (entries.length > SENT_HISTORY_LIMIT) entries.length = SENT_HISTORY_LIMIT
      }
      cursor = undefined
    },

    recall(direction) {
      if (entries.length === 0) return null
      if (direction === 'older') {
        cursor = cursor === undefined ? 0 : Math.min(cursor + 1, entries.length - 1)
        return entries[cursor] ?? null
      }
      if (cursor === undefined) return null
      if (cursor === 0) {
        cursor = undefined
        return ''
      }
      cursor -= 1
      return entries[cursor] ?? null
    },

    reset() {
      cursor = undefined
    },
  }
}
