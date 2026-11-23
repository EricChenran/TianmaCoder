/** Automatic older-history paging decisions, exercised without DOM or Session access. */
import { expect, it } from 'vitest'
import {
  allowsAutoPage, finishedPage, INITIAL_AUTO_HISTORY, startedAutoPage,
  type AutoHistoryState,
} from '../src/client/chat/auto-history.ts'

const idle: AutoHistoryState = INITIAL_AUTO_HISTORY

const free = { firstSeq: 10, hasMore: true, loadingOlder: false, jumpFree: true }

it('allows a page only when older rows remain, nothing is loading, and no jump owns the viewport', () => {
  expect(allowsAutoPage(free, idle)).toBe(true)
  expect(allowsAutoPage({ ...free, hasMore: false }, idle)).toBe(false)
  expect(allowsAutoPage({ ...free, loadingOlder: true }, idle)).toBe(false)
  expect(allowsAutoPage({ ...free, jumpFree: false }, idle)).toBe(false)
})

it('does not repeat a page already requested for the same head', () => {
  const started = startedAutoPage(10)
  expect(started).toEqual({ intent: 'auto', pageFor: 10, stalled: false })
  // In flight: nothing may start, whatever the head.
  expect(allowsAutoPage(free, started)).toBe(false)
  const settled: AutoHistoryState = { intent: 'none', pageFor: 10, stalled: false }
  expect(allowsAutoPage(free, settled)).toBe(false)
  expect(allowsAutoPage({ ...free, firstSeq: 7 }, settled)).toBe(true)
})

it('marks an automatic page stalled when it settles without moving the head', () => {
  const started = startedAutoPage(10)
  const settled = finishedPage(started, { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: false })
  expect(settled).toEqual({ intent: 'none', pageFor: 10, stalled: true })
})

it('keeps an automatic page healthy when it brings older rows', () => {
  const started = startedAutoPage(10)
  const settled = finishedPage(started, { firstSeq: 10, loadingOlder: true }, { firstSeq: 4, loadingOlder: false })
  expect(settled).toEqual({ intent: 'none', pageFor: 10, stalled: false })
})

it('releases an explicit page without marking it stalled', () => {
  const manual: AutoHistoryState = { intent: 'manual', pageFor: null, stalled: false }
  const settled = finishedPage(manual, { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: false })
  expect(settled).toEqual({ intent: 'none', pageFor: null, stalled: false })
})

it('ignores a settle that is still loading or was never an automatic page', () => {
  const started = startedAutoPage(10)
  expect(finishedPage(started, { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: true })).toBe(started)
  expect(finishedPage(idle, { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: false })).toBe(idle)
})

it('lets an explicit retry run after a stall and clears the stall when it settles', () => {
  const stalled = finishedPage(startedAutoPage(10), { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: false })
  expect(stalled.stalled).toBe(true)
  const retry: AutoHistoryState = { ...stalled, intent: 'manual', stalled: false }
  expect(allowsAutoPage(free, retry)).toBe(false)
  expect(finishedPage(retry, { firstSeq: 10, loadingOlder: true }, { firstSeq: 10, loadingOlder: false })).toEqual({ intent: 'none', pageFor: 10, stalled: false })
})
