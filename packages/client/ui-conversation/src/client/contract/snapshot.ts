/** Target-neutral Conversation state assembled from one Session event window. */
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewSnapshotStore } from './conversation.ts'

/** Latest registered target snapshots and their shell-level activity. */
export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore
  readonly activeTargets: ReadonlySet<string>
}

/** Empty Conversation value used before a Session binding is available. */
export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}

/** Shell phase derived from Session lifecycle and registered target activity. */
export type ConversationPhase = 'blank' | 'engaging' | 'active'

/**
 * Resolve the shell phase without adding Conversation data to the Session snapshot.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @returns the phase used by the header, View ring, and composer layout.
 */
export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  return active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
}

/** Facts that decide a Conversation presence's phase and hero placement. */
export interface ConversationPanelPhaseInput {
  /** Whether a Session is selected at all. */
  readonly hasSession: boolean
  /** Assembly phase derived from the Session and its Conversation. */
  readonly shellPhase: ConversationPhase
  /** The Session's open state while it replays, absent without a Session. */
  readonly openState: string | undefined
  /** Whether the list summary already proves this Session blank. */
  readonly summaryBlank: boolean | undefined
  /** Whether a continuable subagent still waits for a Host parent-availability summary. */
  readonly parentAvailabilityPending: boolean
}

/** Phase and hero placement shared by the main panel and embedded occurrences. */
export interface ConversationPanelPhase {
  /** Settling, hero, or active transcript. */
  readonly phase: 'settling' | 'hero' | 'active'
  /** Whether the composer sits in the centered hero position. */
  readonly hero: boolean
}

/**
 * Decide how one Conversation presence presents while its history settles.
 *
 * While a Session is still replaying (loading + blank) the hero/docked choice is
 * unknowable, so the composer renders hidden instead of flashing the centered
 * hero and snapping to the docked bar. A summary-blank Session is exempt: it can
 * only land on the hero, so hiding would blank the column for the whole history
 * round-trip. A restored continuable subagent waits for a Host summary to
 * establish parent availability, keeping the composer hidden instead of briefly
 * rendering the parent-offline takeover.
 * @param input - selection, assembly phase, and the two pending conditions.
 * @returns the phase and whether the composer is a hero.
 */
export function conversationPanelPhase(input: ConversationPanelPhaseInput): ConversationPanelPhase {
  const settling = input.hasSession && (
    (input.shellPhase === 'blank' && input.openState === 'loading' && input.summaryBlank !== true)
    || input.parentAvailabilityPending
  )
  const hero = !input.hasSession
    || (input.shellPhase === 'blank' && (input.openState === 'open' || input.summaryBlank === true))
  return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }
}
