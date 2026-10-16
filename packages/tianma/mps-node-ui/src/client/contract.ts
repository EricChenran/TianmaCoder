/**
 * Contract between the node plugin's apply closure and its Cordis-free
 * components: the snapshot one hook publishes and the operations the closure
 * injects. Components receive these as plain data and callbacks.
 *
 * @module @tianma/dsh-mps-node-ui/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MpsNodeLogLine, MpsNodeStatus } from '@tianma/dsh-mps-node-control/types'

/** Everything the node surface renders. */
export interface MpsNodeSnapshot {
  /** Latest status reading, absent until the first read answers. */
  status: MpsNodeStatus | undefined
  /** Recent lines the node printed, oldest first. */
  lines: MpsNodeLogLine[]
  /** Whether a start or a stop is in flight. */
  busy: boolean
  /**
   * Failure to show: the Host's own message, or an empty string when the call
   * failed without one — the section then renders localized copy.
   */
  error: string | undefined
  /** Whether the Host refused the last read, so the section can say so. */
  unreadable: boolean
}

/** Host operations injected into the Cordis-free node components. */
export interface MpsNodeInjected {
  /** Host-owned node snapshot observed through framework hooks. */
  hooks: { mpsNode: HostObservable<MpsNodeSnapshot> }
  /** Start the node, then re-read its status and lines. */
  start: () => Promise<void>
  /** Stop the node, then re-read its status and lines. */
  stop: () => Promise<void>
  /** Re-read the status and the recent lines. */
  refresh: () => Promise<void>
}
