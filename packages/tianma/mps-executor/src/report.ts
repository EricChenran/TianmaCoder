/**
 * The node's event vocabulary: one report per thing an operator should see, and the
 * normalization every failure path routes through.
 * @module @tianma/dsh-mps-executor/report
 */

/** One node event for the operator. */
export interface ExecutorReport {
  /** How the event is logged. */
  level: 'info' | 'warn' | 'error'
  /** What happened, in one line. */
  message: string
}

/**
 * Normalize a rejection into an error, so a report always has a message.
 * @param error - the thrown value.
 * @returns the error itself, or one carrying its text.
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
