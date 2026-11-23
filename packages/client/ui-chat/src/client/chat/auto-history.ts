/** Automatic older-history paging state, kept free of DOM and Session access so it stays testable. */

/** Why a history page was requested; an automatic page reports failure instead of interrupting. */
export type HistoryIntent = 'none' | 'auto' | 'manual'

/** What the reader has already asked of the loaded window. */
export interface AutoHistoryState {
  /** Intent of the page currently in flight, or `none` when idle. */
  readonly intent: HistoryIntent
  /** Head the last automatic page was requested for; prevents repeating it for the same head. */
  readonly pageFor: number | null
  /** Whether the last automatic page settled without bringing older content. */
  readonly stalled: boolean
}

/** Nothing requested yet. */
export const INITIAL_AUTO_HISTORY: AutoHistoryState = { intent: 'none', pageFor: null, stalled: false }

/** Committed history facts the decision reads. */
export interface AutoHistoryInput {
  /** Anchor of the oldest loaded row, `null` before history is known. */
  readonly firstSeq: number | null
  /** Whether the Session still holds earlier rows. */
  readonly hasMore: boolean
  /** Whether a history page is already loading. */
  readonly loadingOlder: boolean
  /** False while a turn jump owns the viewport. */
  readonly jumpFree: boolean
}

/**
 * Decide whether reaching the top of the loaded window may start a page.
 * @param input - committed history facts.
 * @param state - what has already been requested for this head.
 * @returns whether a request should start now.
 */
export function allowsAutoPage(input: AutoHistoryInput, state: AutoHistoryState): boolean {
  return input.hasMore
    && !input.loadingOlder
    && input.jumpFree
    && state.intent === 'none'
    && state.pageFor !== input.firstSeq
}

/**
 * Record an automatic page that is about to start.
 * @param firstSeq - head the request is made for.
 * @returns state with the page marked in flight and any earlier stall cleared.
 */
export function startedAutoPage(firstSeq: number | null): AutoHistoryState {
  return { intent: 'auto', pageFor: firstSeq, stalled: false }
}

/**
 * Fold a settled page into the state.
 * @param state - state while the page was in flight.
 * @param previous - head and loading flag before the settle.
 * @param next - head and loading flag after the settle.
 * @returns state after the settle; an automatic page that did not move the head is stalled.
 */
export function finishedPage(
  state: AutoHistoryState,
  previous: Pick<AutoHistoryInput, 'firstSeq' | 'loadingOlder'>,
  next: Pick<AutoHistoryInput, 'firstSeq' | 'loadingOlder'>,
): AutoHistoryState {
  if (state.intent === 'none' || !previous.loadingOlder || next.loadingOlder) return state
  const stalled = state.intent === 'auto' ? next.firstSeq === previous.firstSeq : state.stalled
  return { intent: 'none', pageFor: state.pageFor, stalled }
}

/**
 * Clear a stall so the reader may ask again explicitly.
 * @param state - state after a stalled automatic page.
 * @returns state with the stall cleared and no page in flight.
 */
export function retriedPage(state: AutoHistoryState): AutoHistoryState {
  return { intent: 'manual', pageFor: state.pageFor, stalled: false }
}
