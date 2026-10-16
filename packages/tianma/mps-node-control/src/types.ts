/**
 * The vocabulary the node-control surface renders: where the supervised process
 * stands, how its last run ended, and the lines it printed.
 *
 * Every field crosses the Host/Client boundary through the generated Typert
 * Remote projection, so all of them are JSON-representable.
 *
 * @module @tianma/dsh-mps-node-control/types
 */

/** Where the supervised node process stands. */
export type MpsNodePhase =
  /** No process is running. */
  | 'stopped'
  /** A launch is in flight. */
  | 'starting'
  /** The process is running. */
  | 'running'
  /** The launch itself failed, so the process never ran. */
  | 'failed'

/** How one node process ended. */
export interface MpsNodeExit {
  /** Exit code the host reported; null when a signal ended it. */
  code: number | null
  /** Signal that ended it, when one did. */
  signal: string | null
  /** When it ended, as an RFC 3339 string. */
  at: string
}

/** One reading of the supervised node process. */
export interface MpsNodeStatus {
  /** Where the process stands now. */
  phase: MpsNodePhase
  /** Profile this entry launches. */
  profile: string
  /** Process id while one is running. */
  pid?: number | undefined
  /** When the running process started, as an RFC 3339 string. */
  startedAt?: string | undefined
  /** How the last process ended, once one has. */
  exit?: MpsNodeExit | undefined
  /**
   * Why the last launch failed, when it could not start at all. The process
   * that never ran has no exit to report, so this is the only account of it.
   */
  error?: string | undefined
}

/** One line the node printed. */
export interface MpsNodeLogLine {
  /** Stream the line arrived on. */
  stream: 'stdout' | 'stderr'
  /** When the node received it, as an RFC 3339 string. */
  at: string
  /** The line itself, without its terminator. */
  text: string
}
