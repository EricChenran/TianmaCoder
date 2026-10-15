/**
 * What the node must do after one non-`OK` envelope code. The protocol fixes
 * three codes as never-retryable and leaves the rest to backoff retry; codes
 * that report a task-level mismatch carry their own local recovery instead, so
 * this module is the single place that decides between them.
 * @module @tianma/dsh-mps-exec-core/errors
 */

/** The local recovery one envelope code requires. */
export type ExecRecovery =
  /** The request may be repeated after a backoff. */
  | 'retry'
  /** The token is gone: fetch a new one, then re-register, then repeat. */
  | 'reauthenticate'
  /** The platform does not know this node: register before repeating. */
  | 'reregister'
  /** The task cannot continue on this node: stop local work and let the platform re-dispatch. */
  | 'abandon-task'
  /** The lease is not held here any more: stop, and submit no result. */
  | 'discard-result'
  /** The node cannot recover by itself: stop every request and report to operators. */
  | 'halt-node'

const RECOVERY_BY_CODE: Readonly<Record<string, ExecRecovery>> = {
  NODE_SECRET_INVALID: 'halt-node',
  NODE_DISABLED: 'halt-node',
  PROTOCOL_UNSUPPORTED: 'halt-node',
  NODE_TOKEN_EXPIRED: 'reauthenticate',
  NODE_NOT_REGISTERED: 'reregister',
  TASK_NOT_FOUND: 'abandon-task',
  // The platform already holds this result, which is what a duplicate submission means:
  // retrying it would be asking the same question again and reporting a refusal that
  // never happened.
  ALREADY_FINAL: 'discard-result',
  TASK_NOT_LEASED_BY_YOU: 'discard-result',
  LEASE_EXPIRED: 'discard-result',
  ARTIFACT_TOO_LARGE: 'abandon-task',
  BASE_COMMIT_MISMATCH: 'abandon-task',
  INVALID_CHANGED_FILES: 'retry',
  SLOT_OVERSELL: 'retry',
  CHECKSUM_MISMATCH: 'retry',
  RATE_LIMITED: 'retry',
  DB_UNAVAILABLE: 'retry',
  INTERNAL_ERROR: 'retry',
}

/**
 * Resolve the recovery for one envelope code. An unknown code is retried, so a
 * platform that adds codes never strands a task in a node that predates them.
 * @param code - the envelope code.
 * @returns the recovery the node applies.
 */
export function recoveryForCode(code: string): ExecRecovery {
  return RECOVERY_BY_CODE[code] ?? 'retry'
}

/** Options identifying the response that produced an error. */
export interface ExecResponseErrorOptions {
  /** The envelope code. */
  code: string
  /** The HTTP status the response arrived with. */
  httpStatus: number
  /** The platform request id, when the envelope carried one. */
  requestId?: string | undefined
}

/** A non-`OK` platform response, carrying its envelope code and required recovery. */
export class ExecResponseError extends Error {
  /** The envelope code the platform returned. */
  readonly code: string
  /** The HTTP status the response arrived with. */
  readonly httpStatus: number
  /** The platform request id, or `''` when the envelope carried none. */
  readonly requestId: string
  /** What the node must do next. */
  readonly recovery: ExecRecovery

  /**
   * @param message - human-readable failure text.
   * @param options - the envelope code, HTTP status, and request id.
   */
  constructor(message: string, options: ExecResponseErrorOptions) {
    super(message)
    this.name = 'ExecResponseError'
    this.code = options.code
    this.httpStatus = options.httpStatus
    this.requestId = options.requestId ?? ''
    this.recovery = recoveryForCode(options.code)
  }
}
