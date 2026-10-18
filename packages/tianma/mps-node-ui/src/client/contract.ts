/**
 * Contract between the node plugin's apply closure and its Cordis-free
 * components: the snapshot one hook publishes and the operations the closure
 * injects. Components receive these as plain data and callbacks.
 *
 * @module @tianma/dsh-mps-node-ui/contract
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MpsNodeConfig, MpsNodeForm, MpsNodeLogLine, MpsNodeProbeResult, MpsNodeStatus, MpsNodeTaskView } from '@tianma/dsh-mps-node-control/types'

/** The form's own shape: one text field per deployment parameter. */
export type MpsNodeFormInput = MpsNodeForm

/** Everything the node surface renders. */
export interface MpsNodeSnapshot {
  /** Latest status reading, absent until the first read answers. */
  status: MpsNodeStatus | undefined
  /** Recent lines the node printed, oldest first. */
  lines: MpsNodeLogLine[]
  /** Deployment-parameter reading, absent until the first read answers. */
  config: MpsNodeConfig | undefined
  /** Whether a start or a stop is in flight. */
  busy: boolean
  /** Whether a parameter save is in flight. */
  configBusy: boolean
  /** Whether the last parameter save succeeded, so the section can say so. */
  configSaved: boolean
  /** Whether a connectivity probe is in flight. */
  probeBusy: boolean
  /** What the last probe found, until the next one runs. */
  probe: MpsNodeProbeResult | undefined
  /** Tasks this node took, newest first, absent until the first read answers. */
  tasks: MpsNodeTaskView[] | undefined
  /** The task an operator command is in flight for, when one is. */
  taskBusy: string | undefined
  /**
   * Failure to show: the Host's own message, or an empty string when the call
   * failed without one — the section then renders localized copy.
   */
  error: string | undefined
  /** Parameter failure to show, in the Host's own words when it had them. */
  configError: string | undefined
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
  /** Re-read the status, the recent lines, and the deployment parameters. */
  refresh: () => Promise<void>
  /** Save the deployment-parameter form; resolves false when the Host refused. */
  saveConfig: (form: MpsNodeFormInput) => Promise<boolean>
  /**
   * Probe the platform address the form currently holds; the Host answers with
   * what it found rather than throwing, so an unreachable address is a result.
   */
  probePlatform: (form: MpsNodeFormInput) => Promise<void>
  /**
   * Open the Host-native directory chooser and resolve what it picked, or
   * undefined when it was cancelled or no chooser is composed.
   */
  browse: () => Promise<string | undefined>
  /** Cancel one running task through the Host; re-reads the task list after. */
  cancelTask: (taskId: string) => Promise<void>
}
