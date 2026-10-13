/**
 * Residency policy for one agent browser tab pool. The limit and the victim
 * order are ported from the sidebar browser's window-level policy so an
 * automation that opens more tabs than stay resident reclaims the same tab the
 * human sidebar would: the least recently active unprotected one.
 */

/** Tabs that stay resident per lease; matches the sidebar browser's window limit. */
export const AGENT_TAB_LIMIT = 32

/** Where one tab sits in the residency ladder. */
export type AgentTabResidency = 'live-visible' | 'live-background' | 'suspend-pending' | 'suspended'

/** Facts the victim order reads for one tab. */
export interface AgentTabResidencyCandidate {
  readonly tabId: string
  readonly residency: AgentTabResidency
  /** The physical guest is attached and not destroyed; logical residency cannot replace this fact. */
  readonly guestAttached: boolean
  readonly openedAt: number
  readonly lastActivityAt: number
  readonly lastSelectedAt: number | null
  readonly selected: boolean
  readonly visible: boolean
  /** A command is executing against this tab. */
  readonly operationActive: boolean
  /** A screenshot is capturing this tab. */
  readonly captureActive: boolean
  /** A download started from this tab is still running. */
  readonly downloadActive: boolean
  /** The page is waiting on a dialog this tab opened. */
  readonly dialogPending: boolean
}

/**
 * @param candidate - one tab's residency facts.
 * @returns Whether the tab is protected from limit eviction. Only states a human
 *   could see or the automation is actively using are protected; a suspended tab
 *   is not.
 */
export function isAgentTabProtected(candidate: AgentTabResidencyCandidate): boolean {
  return candidate.residency === 'live-visible'
    || candidate.residency === 'suspend-pending'
    || candidate.selected
    || candidate.visible
    || candidate.operationActive
    || candidate.captureActive
    || candidate.downloadActive
    || candidate.dialogPending
}

/**
 * Pick the tab to close so a pool returns to its limit.
 * @param candidates - every tab of one lease.
 * @param limit - resident tab limit; defaults to {@link AGENT_TAB_LIMIT}.
 * @returns The victim, or `null` when the pool is within its limit or every tab is protected.
 */
export function selectAgentTabVictim(
  candidates: readonly AgentTabResidencyCandidate[],
  limit: number = AGENT_TAB_LIMIT,
): AgentTabResidencyCandidate | null {
  if (candidates.length <= limit) return null
  const eligible = candidates.filter(candidate => !isAgentTabProtected(candidate))
  eligible.sort((left, right) => {
    const activityDelta = left.lastActivityAt - right.lastActivityAt
    if (activityDelta !== 0) return activityDelta
    const selectionDelta = (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
      - (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY)
    if (selectionDelta !== 0) return selectionDelta
    const openedDelta = left.openedAt - right.openedAt
    if (openedDelta !== 0) return openedDelta
    return left.tabId.localeCompare(right.tabId)
  })
  return eligible[0] ?? null
}
