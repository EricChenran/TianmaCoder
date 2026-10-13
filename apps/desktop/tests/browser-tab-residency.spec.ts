import { describe, expect, it } from 'vitest'
import type { AgentTabResidencyCandidate } from '../src/browser-tab-residency.ts'
import { AGENT_TAB_LIMIT, isAgentTabProtected, selectAgentTabVictim } from '../src/browser-tab-residency.ts'

function candidate(overrides: Partial<AgentTabResidencyCandidate> & { tabId: string }): AgentTabResidencyCandidate {
  return {
    residency: 'live-background',
    guestAttached: true,
    openedAt: 0,
    lastActivityAt: 0,
    lastSelectedAt: null,
    selected: false,
    visible: false,
    operationActive: false,
    captureActive: false,
    downloadActive: false,
    ...overrides,
  }
}

/** Build `count` background tabs whose activity rises with their index. */
function pool(count: number): AgentTabResidencyCandidate[] {
  return Array.from({ length: count }, (_unused, index) => candidate({
    tabId: `t${String(index).padStart(3, '0')}`,
    openedAt: index,
    lastActivityAt: index,
  }))
}

describe('agent tab residency policy', () => {
  it('keeps the sidebar browser window limit', () => {
    expect(AGENT_TAB_LIMIT).toBe(32)
  })

  it('returns no victim while the pool is within its limit', () => {
    expect(selectAgentTabVictim(pool(AGENT_TAB_LIMIT))).toBeNull()
    expect(selectAgentTabVictim([])).toBeNull()
  })

  it('closes the least recently active unprotected tab', () => {
    const victim = selectAgentTabVictim(pool(AGENT_TAB_LIMIT + 1))
    expect(victim?.tabId).toBe('t000')
  })

  it('protects the active, visible, and busy tabs', () => {
    const tabs = pool(3)
    expect(isAgentTabProtected(candidate({ tabId: 'a', selected: true }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', visible: true }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', operationActive: true }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', captureActive: true }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', downloadActive: true }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', residency: 'live-visible' }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', residency: 'suspend-pending' }))).toBe(true)
    expect(isAgentTabProtected(candidate({ tabId: 'a', residency: 'suspended' }))).toBe(false)
    expect(isAgentTabProtected(candidate({ tabId: 'a' }))).toBe(false)
    expect(tabs).toHaveLength(3)
  })

  it('skips a protected oldest tab for the next eligible one', () => {
    const tabs = pool(AGENT_TAB_LIMIT + 1)
    const oldest = tabs[0]
    if (oldest === undefined) throw new Error('the fixture is empty')
    tabs[0] = { ...oldest, captureActive: true }
    expect(selectAgentTabVictim(tabs)?.tabId).toBe('t001')
  })

  it('returns no victim when every tab is protected', () => {
    const tabs = pool(AGENT_TAB_LIMIT + 1).map(tab => ({ ...tab, selected: true }))
    expect(selectAgentTabVictim(tabs)).toBeNull()
  })

  it('breaks activity ties by selection, then opening time, then id', () => {
    const sameActivity = [
      candidate({ tabId: 'b', lastActivityAt: 5, lastSelectedAt: 9, openedAt: 9 }),
      candidate({ tabId: 'a', lastActivityAt: 5, lastSelectedAt: 9, openedAt: 1 }),
      candidate({ tabId: 'c', lastActivityAt: 5, lastSelectedAt: null, openedAt: 0 }),
    ]
    expect(selectAgentTabVictim(sameActivity, 2)?.tabId).toBe('c')
    const sameSelection = [
      candidate({ tabId: 'z', lastActivityAt: 5, lastSelectedAt: 9, openedAt: 4 }),
      candidate({ tabId: 'y', lastActivityAt: 5, lastSelectedAt: 9, openedAt: 4 }),
    ]
    expect(selectAgentTabVictim(sameSelection, 1)?.tabId).toBe('y')
  })
})
